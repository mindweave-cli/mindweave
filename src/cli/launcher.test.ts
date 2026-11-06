/**
 * launcher.test.ts — the launcher that picks which installed copy of Mindweave runs.
 *
 * It sits on the path of every launch, so what is pinned here is mostly the failure direction: whatever
 * is wrong with the staged copy, the answer is "run the copy that is already here".
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STALE_START_MS,
  chooseLaunch,
  clearStarting,
  handOff,
  isNewer,
  markBad,
  parseVersion,
  readState,
  runningManagedVersion,
  statePath,
  versionEntry,
  writeState,
} from "./launcher.js";
import { appVersion } from "./version.js";
import { classifyInstall } from "./selfUpdate.js";
import { guardedPathReason } from "../tools/guard.js";

const all = () => true;
const none = () => false;

test("versions compare by number, not by text", () => {
  assert.deepEqual(parseVersion("3.4.5"), [3, 4, 5]);
  assert.equal(parseVersion("3.4.5-beta.1")?.join("."), "3.4.5");
  assert.equal(parseVersion("../evil"), null);
  assert.equal(parseVersion("latest"), null);
  assert.ok(isNewer("3.10.0", "3.9.9"), "ten is more than nine");
  assert.ok(!isNewer("3.4.5", "3.4.5"), "the same version is not newer");
  assert.ok(!isNewer("3.4.4", "3.4.5"));
  assert.ok(!isNewer("junk", "3.4.5") && !isNewer("3.4.6", "junk"), "what is not a version is never newer");
});

test("nothing staged: this copy runs", () => {
  assert.deepEqual(chooseLaunch({}, "3.4.5", 1000, all).choice, { kind: "own" });
});

test("a newer, complete copy is chosen, and its start is recorded", () => {
  const r = chooseLaunch({ active: "3.5.0" }, "3.4.5", 1000, all);
  assert.deepEqual(r.choice, { kind: "managed", version: "3.5.0" });
  assert.deepEqual(r.state.starting, { version: "3.5.0", at: 1000 });
});

test("an older or equal copy is never chosen over this one", () => {
  assert.equal(chooseLaunch({ active: "3.4.5" }, "3.4.5", 1, all).choice.kind, "own");
  assert.equal(chooseLaunch({ active: "3.4.0" }, "3.4.5", 1, all).choice.kind, "own", "after the launcher itself was updated past it");
});

test("a copy whose files are not complete is not chosen", () => {
  assert.equal(chooseLaunch({ active: "3.5.0" }, "3.4.5", 1, none).choice.kind, "own");
});

test("a copy marked bad is never tried again", () => {
  assert.equal(chooseLaunch({ active: "3.5.0", bad: ["3.5.0"] }, "3.4.5", 1, all).choice.kind, "own");
});

test("a start that never confirmed is recorded as bad and the previous copy is used", () => {
  const state = { active: "3.6.0", previous: "3.5.0", starting: { version: "3.6.0", at: 0 } };
  const r = chooseLaunch(state, "3.4.5", STALE_START_MS + 1, all);
  assert.deepEqual(r.choice, { kind: "managed", version: "3.5.0" });
  assert.deepEqual(r.state.bad, ["3.6.0"]);
  assert.equal(r.state.active, "3.5.0");
});

test("a start that never confirmed with nothing before it falls back to this copy", () => {
  const r = chooseLaunch({ active: "3.6.0", starting: { version: "3.6.0", at: 0 } }, "3.4.5", STALE_START_MS + 1, all);
  assert.equal(r.choice.kind, "own");
  assert.deepEqual(r.state.bad, ["3.6.0"]);
});

test("a second window opened right after the first is not a failed start", () => {
  const r = chooseLaunch({ active: "3.6.0", starting: { version: "3.6.0", at: 1000 } }, "3.4.5", 1000 + 5_000, all);
  assert.deepEqual(r.choice, { kind: "managed", version: "3.6.0" });
  assert.equal(r.state.bad?.length, 0);
});

test("a damaged state file reads as nothing staged, and a version that is a path is dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "mw-launcher-"));
  writeFileSync(statePath(dir), "{ not json");
  assert.deepEqual(readState(dir), {});
  writeFileSync(
    statePath(dir),
    JSON.stringify({ active: "../../etc", previous: "3.1.0", bad: ["x/y", "3.0.0"], starting: { version: "..", at: 1 } }),
  );
  assert.deepEqual(readState(dir), { previous: "3.1.0", bad: ["3.0.0"] });
});

test("a copy knows whether it runs from a version folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "mw-launcher-"));
  assert.equal(runningManagedVersion(join(dir, "versions", "3.5.0", "node_modules", "mindweave"), dir), "3.5.0");
  assert.equal(runningManagedVersion(join(dir, "elsewhere", "mindweave"), dir), null);
  assert.equal(runningManagedVersion(join(dir, "versions"), dir), null);
});

test("an installed-by-the-updater path is placed as managed, and nothing else is", () => {
  const probe = { isLink: () => false, exists: () => false };
  assert.equal(classifyInstall("C:\\Users\\a\\.mindweave\\versions\\3.5.0\\node_modules\\mindweave", probe).kind, "managed");
  assert.equal(classifyInstall("/home/a/.mindweave/versions/3.5.0/node_modules/mindweave", probe).kind, "managed");
  assert.notEqual(classifyInstall("/home/a/proj/node_modules/mindweave", probe).kind, "managed");
});

test("the agent's tools cannot reach the versions folder or the state file", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mw-launcher-")));
  const before = process.env.MINDWEAVE_STATE_DIR;
  process.env.MINDWEAVE_STATE_DIR = dir;
  try {
    assert.ok(await guardedPathReason(versionEntry("3.5.0", dir)), "a copy that runs at every launch must not be writable");
    assert.ok(await guardedPathReason(statePath(dir)));
  } finally {
    if (before === undefined) delete process.env.MINDWEAVE_STATE_DIR;
    else process.env.MINDWEAVE_STATE_DIR = before;
  }
});

// ── the real hand-off, against fake copies in a throwaway state folder ───────────────────────────────

let root = "";
const g = globalThis as Record<string, unknown>;
let savedState: string | undefined;

beforeEach(() => {
  savedState = process.env.MINDWEAVE_STATE_DIR;
  root = realpathSync(mkdtempSync(join(tmpdir(), "mw-handoff-")));
  process.env.MINDWEAVE_STATE_DIR = root;
  delete g.__mindweaveHandedOff;
  delete g.__fakeRan;
});
afterEach(() => {
  if (savedState === undefined) delete process.env.MINDWEAVE_STATE_DIR;
  else process.env.MINDWEAVE_STATE_DIR = savedState;
  delete g.__mindweaveHandedOff;
  delete g.__fakeRan;
});

/** A copy on disk. `index` is the body of its dist/index.js. */
function stage(version: string, index: string): void {
  const pkg = join(versionEntry(version, root), "..", "..");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "mindweave", version, type: "module" }));
  writeFileSync(join(pkg, "dist", "index.js"), index);
  writeFileSync(join(pkg, "dist", "main.js"), "export {};\n");
}

test("hand-off runs the staged copy in this process and records the start", async () => {
  stage("99.0.0", "globalThis.__fakeRan = 'yes';\n");
  writeState({ active: "99.0.0" }, root);
  assert.equal(await handOff(), true);
  assert.equal(g.__fakeRan, "yes");
  assert.equal(readState(root).starting?.version, "99.0.0");
  clearStarting("99.0.0", root);
  assert.equal(readState(root).starting, undefined, "the app confirming clears it");
});

test("with no state file, hand-off does nothing and writes nothing", async () => {
  assert.equal(await handOff(), false);
  assert.ok(!existsSync(statePath(root)));
});

test("MINDWEAVE_NO_MANAGED=1 turns it off", async () => {
  stage("99.0.0", "globalThis.__fakeRan = 'yes';\n");
  writeState({ active: "99.0.0" }, root);
  process.env.MINDWEAVE_NO_MANAGED = "1";
  try {
    assert.equal(await handOff(), false);
  } finally {
    delete process.env.MINDWEAVE_NO_MANAGED;
  }
  assert.equal(g.__fakeRan, undefined);
});

test("a copy that cannot even be loaded is marked bad and this copy runs", async () => {
  stage("99.0.0", "this is not javascript (\n");
  writeState({ active: "99.0.0" }, root);
  assert.equal(await handOff(), false);
  assert.deepEqual(readState(root).bad, ["99.0.0"]);
  assert.equal(readState(root).active, undefined);
  assert.equal(await handOff(), false, "and it is not tried again");
});

test("a copy that starts and then fails is marked bad, and the error is not swallowed", async () => {
  stage("99.0.0", "throw new Error('boom');\n");
  writeState({ active: "99.0.0" }, root);
  await assert.rejects(handOff(), /boom/);
  assert.deepEqual(readState(root).bad, ["99.0.0"]);
});

test("a copy handed to never hands over again", async () => {
  stage("99.0.0", "globalThis.__fakeRan = (globalThis.__fakeRan ?? 0) + 1;\n");
  writeState({ active: "99.0.0" }, root);
  await handOff();
  assert.equal(await handOff(), false, "once per process");
  assert.equal(g.__fakeRan, 1);
});

test("markBad moves to the previous copy", () => {
  writeState({ active: "3.6.0", previous: "3.5.0", starting: { version: "3.6.0", at: 1 } }, root);
  markBad("3.6.0", root);
  assert.deepEqual(readState(root), { active: "3.5.0", bad: ["3.6.0"] });
});

test("a launcher newer than the staged copy runs itself", async () => {
  stage("0.0.1", "globalThis.__fakeRan = 'no';\n");
  writeState({ active: "0.0.1" }, root);
  assert.ok(appVersion() !== "");
  assert.equal(await handOff(), false);
  assert.equal(g.__fakeRan, undefined);
  assert.equal(readFileSync(statePath(root), "utf8").includes("launcherRoot"), true, "the launcher's own place is recorded for /update");
});
