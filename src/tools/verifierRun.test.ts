/**
 * verifierRun.test.ts — a verdict is judged against what the verifier did, not only what it says.
 *
 * The case this exists for is a real one: a verifier that could not run anything wrote
 * `$ read src/main/index.ts` lines under a report, was credited with "8 checks with evidence", and
 * put a PASS on a claim that was false. These pin the three things that stop that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRun, verifyWithGuards, watchRuns } from "./verifierRun.js";
import { checkLines, commandMatches, parseVerdict } from "./verifyReport.js";
import { Checkpoints } from "./checkpoints.js";
import type { EngineEvent } from "../dynamo/engine.js";

const start = (id: string, name: string, args: Record<string, unknown>): EngineEvent => ({ type: "tool", phase: "start", id, name, args });
const end = (id: string, name: string, summary = "ok", error = false): EngineEvent => ({ type: "tool", phase: "end", id, name, summary, error });

// ── what a cited command is compared with ────────────────────────────────────────────────────────

test("a cited command is backed when every word of it ran, in order, in some command", () => {
  const ran = ["npm run typecheck 2>&1 | Select-String error", "node scripts/check-persistence.mjs"];
  assert.equal(commandMatches("npm run typecheck", ran), true);
  assert.equal(commandMatches("npm typecheck", ran), true, "the report abbreviates");
  assert.equal(commandMatches("node scripts/check-persistence.mjs", ran), true);
  assert.equal(commandMatches("npm test", ran), false, "a command that was never run");
  assert.equal(commandMatches("read src/main/index.ts:91-123", ran), false, "a look at a file is not a command");
  assert.equal(commandMatches("search over src/ for setTimeout", ran), false);
  assert.equal(commandMatches("", ran), false);
});

test("the report's check lines are the commands with output after them", () => {
  const text = ["### Check: a", "$ npm test", "ok 12 tests", "=> PASS", "### Check: b", "$ node x.js", "### Check: c", "$ ls", "file", "=> PASS"].join("\n");
  assert.deepEqual(checkLines(text).map((c) => c.command), ["npm test", "ls"], "a command with nothing after it is not a check");
});

// ── the run's own record ─────────────────────────────────────────────────────────────────────────

test("what a call was is said the way a report would cite it, and a file read is not a command", () => {
  assert.equal(describeRun("run_command", { command: "npm test" }), "npm test");
  assert.equal(describeRun("run_command", { command: "   " }), undefined);
  assert.equal(describeRun("ui", { action: "click", name: "Save" }), "ui click Save");
  assert.equal(describeRun("ui", { port: 9333 }), "ui 9333");
  assert.equal(describeRun("ui", {}), "ui look");
  assert.equal(describeRun("ui", { steps: [{ action: "click" }, { action: "type" }] }), "ui click type");
  assert.equal(describeRun("read_file", { paths: ["a.ts"] }), undefined);
  assert.equal(describeRun("search", { pattern: "x" }), undefined);
});

test("only commands that really ran are remembered: a refused one never ran", () => {
  const w = watchRuns();
  for (const e of [
    start("1", "run_command", { command: "npm test" }),
    end("1", "run_command", "ok"),
    start("2", "run_command", { command: "npm run build" }),
    end("2", "run_command", "declined run_command", true),
    start("3", "read_file", { paths: ["a.ts"] }),
    end("3", "read_file"),
    start("4", "ui", { action: "look" }),
    end("4", "ui", "Looked at it"),
    start("5", "run_command", { command: "false" }),
    end("5", "run_command", "exit 1", true),
  ]) w.onEvent(e);
  assert.deepEqual(w.ran(), ["npm test", "ui look", "false"], "a command that failed still ran");
});

// ── the verdict ──────────────────────────────────────────────────────────────────────────────────

const FAKE_REPORT = [
  "### Check: the reason reaches the wording",
  "$ read src/main/index.ts:119; src/preload/index.ts:32-33",
  "send is called with the reason",
  "=> PASS — `'unwritten'` now reaches `closeWarning`",
  "",
  "### Check: no timer remains",
  "$ search over src/ for setTimeout|clearTimeout",
  "only use-debounced.ts",
  "=> PASS",
  "",
  "VERDICT: partial",
].join("\n");

test("reading written up as commands is not credited, and a PASS under it says so", () => {
  const r = parseVerdict(FAKE_REPORT, { executed: [], modified: [] });
  assert.equal(r.evidence, 0, "no check was backed by a command");
  assert.equal(r.unbacked, 2);
  assert.match(r.concerns.join(" "), /2 checks cite a command that never ran/);
  assert.equal((r.body.match(/NOT A CHECK/g) ?? []).length, 2, "each PASS is marked where the reader will see it");
  assert.match(r.body, /=> PASS — `'unwritten'` now reaches `closeWarning` \[NOT A CHECK/);
});

test("without the run's record, the report's own lines count, as before", () => {
  const r = parseVerdict(FAKE_REPORT);
  assert.equal(r.evidence, 2);
  assert.doesNotMatch(r.body, /NOT A CHECK/);
});

test("a check backed by a command that ran is counted, and a pass on it stands", () => {
  const report = ["### Check: typecheck", "$ npm run typecheck", "exit 0", "=> PASS", "### Check: break it", "$ node probe.mjs", "threw as expected", "=> PASS", "VERDICT: pass"].join("\n");
  const r = parseVerdict(report, { executed: ["npm run typecheck", "node probe.mjs"], modified: [] });
  assert.equal(r.verdict, "pass");
  assert.equal(r.evidence, 2);
  assert.equal(r.unbacked, 0);
  assert.deepEqual(r.concerns, []);
});

test("a pass whose checks never ran is downgraded", () => {
  const report = ["### Check: x", "$ read a.ts", "looks right", "=> PASS", "VERDICT: pass"].join("\n");
  const r = parseVerdict(report, { executed: [], modified: [] });
  assert.equal(r.verdict, "partial");
  assert.equal(r.downgraded, true);
});

test("a pass is not a pass if a project file changed while the verifier ran", () => {
  const report = ["### Check: x", "$ npm test", "ok", "=> PASS", "VERDICT: pass"].join("\n");
  const r = parseVerdict(report, { executed: ["npm test"], modified: ["src/a.ts", "src/b.ts (new)"] });
  assert.equal(r.verdict, "partial");
  assert.equal(r.downgraded, true);
  assert.match(r.concerns.join(" "), /changed 2 project files while it ran \(src\/a\.ts, src\/b\.ts \(new\)\)/);
  assert.match(r.concerns.join(" "), /undo puts them back/);
});

test("a fail is not second-guessed, but a change to the files is still said", () => {
  const r = parseVerdict(["$ npm test", "1 failing", "VERDICT: fail"].join("\n"), { executed: ["npm test"], modified: ["src/a.ts"] });
  assert.equal(r.verdict, "fail");
  assert.equal(r.modified?.length, 1);
});

// ── the whole run: the files are looked at before and after ──────────────────────────────────────

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mw-verify-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

test("a verifier that changed a source file has its pass downgraded, the file named, and undo able to put it back", async () => {
  const root = await project();
  try {
    const cp = new Checkpoints();
    const report = await verifyWithGuards({
      cwd: root,
      checkpoints: cp,
      run: async (onEvent) => {
        onEvent(start("1", "run_command", { command: "npm test" }));
        await writeFile(join(root, "src", "a.ts"), "export const a = 'made to pass';\n");
        onEvent(end("1", "run_command"));
        return ["### Check: tests", "$ npm test", "all passed", "=> PASS", "VERDICT: pass"].join("\n");
      },
    });
    assert.equal(report.verdict, "partial");
    assert.deepEqual(report.modified, ["src/a.ts"]);
    cp.seal("verifier");
    await cp.undo();
    assert.equal(await readFile(join(root, "src", "a.ts"), "utf8"), "export const a = 1;\n", "the file is back as it was");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verifier that only ran things leaves the verdict as it said it, and build output is not a change", async () => {
  const root = await project();
  try {
    const report = await verifyWithGuards({
      cwd: root,
      run: async (onEvent) => {
        onEvent(start("1", "run_command", { command: "npm run build" }));
        await mkdir(join(root, "out"), { recursive: true });
        await writeFile(join(root, "out", "main.js"), "built");
        onEvent(end("1", "run_command"));
        return ["### Check: build", "$ npm run build", "built", "=> PASS", "### Check: break it", "$ npm run build", "built again", "=> PASS", "VERDICT: pass"].join("\n");
      },
    });
    assert.equal(report.verdict, "pass");
    assert.deepEqual(report.modified, []);
    assert.equal(report.evidence, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── what the verifier started in the background is stopped when it finishes ─────────────────────────

import { stopStartedBy } from "./verifierRun.js";
import type { BackgroundShells } from "./backgroundShells.js";

function fakeShells(initial: { id: number; status: string }[]): { shells: BackgroundShells; killed: number[]; add: (id: number, status?: string) => void } {
  const list = [...initial];
  const killed: number[] = [];
  const shells = { list: () => list, kill: (id: number) => (killed.push(id), true) } as unknown as BackgroundShells;
  return { shells, killed, add: (id, status = "running") => void list.push({ id, status }) };
}

test("only the shells that began during the run, and are still running, are stopped", () => {
  const f = fakeShells([{ id: 1, status: "running" }]);
  f.add(2);
  f.add(3, "exited");
  assert.equal(stopStartedBy(f.shells, new Set([1])), 1);
  assert.deepEqual(f.killed, [2], "the session's own shell is left alone, and a finished one needs nothing");
  assert.equal(stopStartedBy(undefined, new Set()), 0);
});

test("it is stopped even when the verifier's run fails", async () => {
  const root = await project();
  try {
    const f = fakeShells([{ id: 1, status: "running" }]);
    await assert.rejects(
      verifyWithGuards({
        cwd: root,
        shells: f.shells,
        run: async () => {
          f.add(2);
          throw new Error("the provider fell over");
        },
      }),
      /fell over/,
    );
    assert.deepEqual(f.killed, [2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
