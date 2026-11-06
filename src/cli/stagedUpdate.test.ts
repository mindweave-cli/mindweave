/**
 * stagedUpdate.test.ts — installing the next version beside the running one.
 *
 * The whole sequence runs on fake copies in a throwaway folder: no npm, no network. What matters is the
 * failure direction. A download that fails, a copy that will not start, two windows at once: each must leave
 * `current.json` exactly as it was and no half-made folder behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDLE_BEFORE_STAGING_MS,
  mayCheck,
  pruneVersions,
  stageDecision,
  stageVersion,
  stagedAhead,
  stagedCopyIsComplete,
  sweepStaging,
  toPrune,
  type StageDeps,
  type StageInput,
} from "./stagedUpdate.js";
import { readState, statePath, versionsRoot, writeState } from "./launcher.js";

const base: StageInput = {
  latest: "3.5.0",
  running: "3.4.5",
  state: {},
  idleMs: IDLE_BEFORE_STAGING_MS + 1,
  busy: false,
  installKind: "global",
  attempted: new Set(),
  disabled: false,
};

test("a download starts only when a newer release exists and nobody is working", () => {
  assert.deepEqual(stageDecision(base), { stage: true, version: "3.5.0" });
  assert.deepEqual(stageDecision({ ...base, busy: true }), { stage: false, why: "busy" });
  assert.deepEqual(stageDecision({ ...base, idleMs: IDLE_BEFORE_STAGING_MS - 1 }), { stage: false, why: "not-idle" });
});

test("it never starts for a checkout, the app, or when switched off", () => {
  for (const kind of ["source", "app", "local", "unknown"]) {
    assert.equal(stageDecision({ ...base, installKind: kind }).stage, false, kind);
  }
  assert.equal(stageDecision({ ...base, installKind: "managed" }).stage, true, "a copy the launcher started can");
  assert.deepEqual(stageDecision({ ...base, disabled: true }), { stage: false, why: "off" });
});

test("nothing newer, already staged, marked bad, or already tried: no download", () => {
  assert.equal(stageDecision({ ...base, latest: null }).stage, false);
  assert.equal(stageDecision({ ...base, latest: "3.4.5" }).stage, false);
  assert.deepEqual(stageDecision({ ...base, state: { active: "3.5.0" } }), { stage: false, why: "already-staged" });
  assert.equal(stageDecision({ ...base, state: { active: "3.6.0" } }).stage, false, "a newer one is already waiting");
  assert.deepEqual(stageDecision({ ...base, state: { bad: ["3.5.0"] } }), { stage: false, why: "bad" });
  assert.deepEqual(stageDecision({ ...base, attempted: new Set(["3.5.0"]) }), { stage: false, why: "tried" });
  assert.equal(stageDecision({ ...base, state: { active: "3.5.0" }, latest: "3.5.1" }).stage, true, "a still newer release replaces it");
});

test("the registry is asked only when the moment is right", () => {
  assert.equal(mayCheck({ disabled: false, installKind: "global", busy: false, idleMs: IDLE_BEFORE_STAGING_MS }), null);
  assert.ok(mayCheck({ disabled: false, installKind: "global", busy: true, idleMs: IDLE_BEFORE_STAGING_MS }));
});

test("a staged copy newer than the running one is the one to restart into", () => {
  assert.equal(stagedAhead({ active: "3.5.0" }, "3.4.5"), "3.5.0");
  assert.equal(stagedAhead({ active: "3.5.0" }, "3.5.0"), null, "already running it");
  assert.equal(stagedAhead({ active: "3.5.0", bad: ["3.5.0"] }, "3.4.5"), null);
  assert.equal(stagedAhead({}, "3.4.5"), null);
});

test("pruning keeps the active, previous and running copies and nothing else", () => {
  const gone = toPrune(["3.3.0", "3.4.0", "3.5.0", "3.6.0", ".3.7.0.tmp-1", ".lock"], { active: "3.6.0", previous: "3.5.0" }, "3.4.0");
  assert.deepEqual(gone, ["3.3.0"], "folders that are not versions are never touched");
});

// ── the sequence, on fake copies ──────────────────────────────────────────────────────────────────────

function freshRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "mw-staged-")));
}

/** What a successful npm install leaves under `dir`. */
function writeCopy(dir: string, version: string, over: { main?: boolean; reported?: string } = {}): void {
  const pkg = join(dir, "node_modules", "mindweave");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "mindweave", version: over.reported ?? version, type: "module" }));
  writeFileSync(join(pkg, "dist", "index.js"), "export {};\n");
  if (over.main !== false) writeFileSync(join(pkg, "dist", "main.js"), "export {};\n");
}

function deps(root: string, over: Partial<StageDeps> = {}): StageDeps {
  return {
    root,
    running: null,
    now: () => Date.now(),
    install: async (dir, version) => {
      writeCopy(dir, version);
      return { ok: true, message: "" };
    },
    smoke: async () => true,
    ...over,
  };
}

const leftovers = (root: string) => (existsSync(versionsRoot(root)) ? readdirSync(versionsRoot(root)).filter((n) => n.startsWith(".")) : []);

test("a good download becomes the active copy, with no half-made folder left", async () => {
  const root = freshRoot();
  const r = await stageVersion("3.5.0", deps(root));
  assert.deepEqual(r, { ok: true, version: "3.5.0" });
  assert.ok(stagedCopyIsComplete("3.5.0", root));
  assert.equal(readState(root).active, "3.5.0");
  assert.deepEqual(leftovers(root), []);
});

test("the copy before becomes the fallback, and older ones are removed", async () => {
  const root = freshRoot();
  await stageVersion("3.5.0", deps(root));
  await stageVersion("3.6.0", deps(root));
  assert.deepEqual({ a: readState(root).active, p: readState(root).previous }, { a: "3.6.0", p: "3.5.0" });
  await stageVersion("3.7.0", deps(root));
  assert.deepEqual(readdirSync(versionsRoot(root)).sort(), ["3.6.0", "3.7.0"], "3.5.0 went, the two newest stayed");
});

test("a failed download changes nothing", async () => {
  const root = freshRoot();
  await stageVersion("3.5.0", deps(root));
  const before = JSON.stringify(readState(root));
  const r = await stageVersion("3.6.0", deps(root, { install: async () => ({ ok: false, message: "ENOTFOUND" }) }));
  assert.deepEqual(r, { ok: false, message: "ENOTFOUND" });
  assert.equal(JSON.stringify(readState(root)), before);
  assert.deepEqual(leftovers(root), []);
  assert.ok(!existsSync(join(versionsRoot(root), "3.6.0")));
});

test("a copy that is not the version asked for is refused", async () => {
  const root = freshRoot();
  const r = await stageVersion("3.5.0", deps(root, { install: async (dir) => (writeCopy(dir, "3.5.0", { reported: "3.4.9" }), { ok: true, message: "" }) }));
  assert.equal(r.ok, false);
  assert.ok(!existsSync(statePath(root)), "current.json was not even created");
  assert.deepEqual(leftovers(root), []);
});

test("a copy that will not start is never switched in", async () => {
  const root = freshRoot();
  const r = await stageVersion("3.5.0", deps(root, { smoke: async () => false }));
  assert.deepEqual(r, { ok: false, message: "the installed copy did not start" });
  assert.ok(!existsSync(statePath(root)));
  assert.ok(!existsSync(join(versionsRoot(root), "3.5.0")));
  assert.deepEqual(leftovers(root), []);
});

test("a copy missing its main file is refused", async () => {
  const root = freshRoot();
  const r = await stageVersion("3.5.0", deps(root, { install: async (dir) => (writeCopy(dir, "3.5.0", { main: false }), { ok: true, message: "" }) }));
  assert.equal(r.ok, false);
  assert.ok(!existsSync(join(versionsRoot(root), "3.5.0")));
});

test("an install that throws leaves the lock released and the state alone", async () => {
  const root = freshRoot();
  const r = await stageVersion("3.5.0", deps(root, { install: async () => { throw new Error("disk full"); } }));
  assert.deepEqual(r, { ok: false, message: "disk full" });
  assert.deepEqual(leftovers(root), [], "no lock, no half-made folder");
  assert.equal((await stageVersion("3.5.0", deps(root))).ok, true, "and the next try is not blocked");
});

test("two windows at once: the second does not install", async () => {
  const root = freshRoot();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let started: () => void = () => {};
  const running = new Promise<void>((r) => (started = r));
  const first = stageVersion("3.5.0", deps(root, { install: async (dir, v) => { started(); await held; writeCopy(dir, v); return { ok: true, message: "" }; } }));
  await running;
  const second = await stageVersion("3.5.0", deps(root));
  assert.deepEqual(second, { ok: false, message: "another install is running" });
  release();
  assert.equal((await first).ok, true);
});

test("a lock left by a dead install does not block forever", async () => {
  const root = freshRoot();
  const lock = join(versionsRoot(root), ".lock");
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(lock, old, old);
  assert.equal((await stageVersion("3.5.0", deps(root))).ok, true);
});

test("a version that is a path is refused before anything is made", async () => {
  const root = freshRoot();
  for (const v of ["../x", "3.5.0/../..", "latest", ""]) {
    assert.equal((await stageVersion(v, deps(root))).ok, false, v);
  }
  assert.ok(!existsSync(versionsRoot(root)));
});

test("a copy already complete on disk is only switched in, not downloaded again", async () => {
  const root = freshRoot();
  await stageVersion("3.5.0", deps(root));
  writeState({ previous: undefined, bad: [] }, root);
  let installs = 0;
  const r = await stageVersion("3.5.0", deps(root, { install: async () => (installs++, { ok: true, message: "" }) }));
  assert.equal(r.ok, true);
  assert.equal(installs, 0);
  assert.equal(readState(root).active, "3.5.0");
});

test("pruning spares the copy this window runs", async () => {
  const root = freshRoot();
  await stageVersion("3.5.0", deps(root));
  await stageVersion("3.6.0", deps(root));
  await stageVersion("3.7.0", deps(root, { running: "3.5.0" }));
  assert.deepEqual(readdirSync(versionsRoot(root)).sort(), ["3.5.0", "3.6.0", "3.7.0"]);
  pruneVersions(root, readState(root), null);
  assert.deepEqual(readdirSync(versionsRoot(root)).sort(), ["3.6.0", "3.7.0"]);
});

test("old half-made folders are swept, fresh ones are left", () => {
  const root = freshRoot();
  const oldDir = join(versionsRoot(root), ".3.5.0.tmp-1");
  const newDir = join(versionsRoot(root), ".3.6.0.tmp-2");
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  const old = new Date(Date.now() - 3 * 60 * 60_000);
  utimesSync(oldDir, old, old);
  sweepStaging(root, Date.now());
  assert.ok(!existsSync(oldDir));
  assert.ok(existsSync(newDir));
});
