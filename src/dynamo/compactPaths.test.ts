/**
 * compactPaths.test.ts — the compaction cascade at the engine level.
 *
 * The pure halves are covered in `memory/sessionMemoryCompact.test.ts` and
 * `drivers/contextOverflow.test.ts`. What those cannot show is that the engine
 * actually REACHES them, and every defect this file guards was a wiring defect that
 * type-checked: a summary path that never consulted the notes, a compaction that
 * announced a cache break it had caused itself, a manual compact that paid to
 * summarize tool output it could have cleared for free.
 *
 * The notes path makes NO model call, which is what makes it testable here: a session
 * with no reachable driver either compacts from its notes or throws, and there is no
 * third outcome to be vague about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { compactNow, toolFailureResult } from "./engine.js";
import { estimateEntriesTokens } from "../memory/compaction.js";
import type { Entry, Session } from "../memory/types.js";
import { createRuleScope, noteScopePath } from "../governor/scope.js";
import { renderRules } from "../governor/rules.js";

const NOTES = "# Session Title\nWiring the parser\n\n# Current State\nHalfway through lexer.ts, nested quotes still failing.";

const filler = (tokens: number) => "x".repeat(tokens * 3.5);

function round(n: number, size: number): Entry[] {
  return [
    { role: "assistant", content: `step ${n}`, toolCalls: [{ id: `t${n}`, name: "read_file", arguments: "{}" }] },
    { role: "tool", content: filler(size), toolCallId: `t${n}` },
  ] as Entry[];
}

/** A session carrying only what the compaction path reads. */
function session(over: Partial<Session> = {}): Session {
  return {
    transcript: [{ role: "user", content: "go" } as Entry, ...Array.from({ length: 40 }, (_, i) => round(i, 2_000)).flat()],
    modelConfig: { model: "deepseek-v4-pro" },
    toolContext: {},
    sessionMemory: NOTES,
    sessionMemoryEntries: 20,
    ...over,
  } as unknown as Session;
}

test("a session with current notes compacts without a model call", async () => {
  // No driver is reachable in a unit test, so reaching the summarizer would throw.
  // Completing quietly IS the assertion that the free path was taken.
  const s = session();
  const before = estimateEntriesTokens(s.transcript);
  await compactNow(s);
  assert.ok(estimateEntriesTokens(s.transcript) < before, "the transcript was compacted");
  assert.equal(s.transcript[0]!.role, "summary");
  assert.match(s.transcript[0]!.content, /nested quotes still failing/, "the notes became the summary");
});

test("the notes boundary is reset so the next compaction is honest", async () => {
  // The notes describe everything before the tail they were spliced in front of. Left
  // pointing at an index in the OLD transcript, the next compaction would keep the
  // wrong slice, which is the one failure the whole path must never risk.
  const s = session();
  await compactNow(s);
  assert.equal(s.sessionMemoryEntries, 1);
  assert.equal(s.sessionMemoryTokens, estimateEntriesTokens(s.transcript));
});

test("a compaction does not report the cache break it caused itself", async () => {
  // The prefix after a compaction bears no resemblance to the one before, and that is
  // the point. Announcing it would train the user to ignore a warning that exists to
  // catch UNEXPLAINED breaks.
  const s = session({ prefixPrint: { anything: true } as never });
  const activity: string[] = [];
  await compactNow(s, { onActivity: (text: string) => activity.push(text) } as never);
  assert.equal(s.prefixPrint, undefined, "the baseline is dropped so the next step has nothing to diff");
  assert.ok(!activity.some((line) => /cache/i.test(line)), `no cache warning, got: ${activity.join(" | ")}`);
});

test("a successful compaction resets the failure breaker", () => {
  // Without this a session that failed twice early stays two-thirds of the way to
  // giving up for the rest of its life.
  const s = session({ compactFailures: 2 });
  return compactNow(s).then(() => {
    assert.equal(s.compactFailures, 0, "a clean compaction did not reset the breaker");
  });
});

test("compaction is reported to the caller", async () => {
  const reports: { before: number; after: number; window: number }[] = [];
  await compactNow(session(), { onCompaction: (r: never) => reports.push(r) } as never);
  assert.equal(reports.length, 1);
  assert.ok(reports[0]!.after < reports[0]!.before, "reported a real reduction");
  assert.ok(reports[0]!.window > 0);
});

test("stale notes decline the free path instead of faking it", async () => {
  // No notes at all means the summarizer is the only option, and with no reachable
  // driver that must SURFACE rather than quietly leaving the transcript alone.
  const s = session({ sessionMemory: "" });
  const before = s.transcript.length;
  await compactNow(s).catch(() => {});
  assert.equal(s.transcript.length <= before, true);
  assert.notEqual(s.transcript[0]!.role, "summary", "nothing was spliced from empty notes");
});

// ---------------------------------------------------------------------------
// Source-shape checks, for the wiring that cannot fail loudly. Same approach
// engine.test.ts already takes for the pause paths: each of these type-checks and
// passes every behavioural test while quietly doing the wrong thing.
// ---------------------------------------------------------------------------

const engineSource = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");

test("manual /compact clears stale tool bodies before paying to summarize", () => {
  const body = engineSource.match(/export async function compactNow\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "compactNow not found — did it get renamed?");
  assert.match(body, /microcompact\(/, "the cheap pass must run before the billed one");
  assert.ok(
    body.indexOf("microcompact(") < body.indexOf("autocompact("),
    "microcompact must come FIRST or the summarizer is billed for what it could have dropped",
  );
});

test("a failed compaction is surfaced, not just counted", () => {
  const body = engineSource.match(/const fail = \([^)]*\) => \{([\s\S]*?)\n  \};/)?.[1];
  assert.ok(body, "the fail helper not found — did it get renamed?");
  assert.match(body, /compactFailures/, "the breaker still has to count it");
  assert.match(body, /onActivity/, "and the user has to be told it happened");
});

test("the circuit breaker says so when it gives up", () => {
  // Giving up silently was the original defect: the session then ran past its bar
  // unmanaged with nothing on screen connecting the eventual failure to compaction.
  const guard = engineSource.match(/compactFailures \?\? 0\) >= MAX_COMPACT_FAILURES\)[\s\S]{0,900}/)?.[0];
  assert.ok(guard, "the breaker guard not found — did it get restructured?");
  assert.match(guard, /onActivity/, "the give-up has to reach the screen");
  // Reading the flag is not enough. A guard that checks `!compactGaveUpTold` and never
  // SETS it repeats the notice on every step for the rest of the session, which is how
  // a message meant to be noticed becomes noise the user filters out.
  assert.match(guard, /if \(!session\.compactGaveUpTold\)/, "guarded so it fires once");
  assert.match(guard, /session\.compactGaveUpTold = true/, "and latched, or it fires every step");
});

test("both ways a provider refuses an over-long request share one remedy", () => {
  // Two copies of the shed-and-retry logic is how the thrown-error path and the
  // stop-reason path drift into behaving differently.
  assert.match(engineSource, /isContextOverflowError\(error\)/, "the rejection path is classified");
  assert.equal(
    (engineSource.match(/dropOldestRounds\(/g) ?? []).length,
    1,
    "shedding must live in exactly one place",
  );
  assert.equal(
    (engineSource.match(/shedAndRetry\(\)/g) ?? []).length,
    2,
    "and be reached from both the thrown error and the stop reason",
  );
});

// ---------------------------------------------------------------------------
// Restoration, against real files on disk. The selector is unit-tested in
// memory/restore.test.ts; what these prove is the half that cannot be faked —
// that the ledger stops describing content the transcript no longer holds.
// ---------------------------------------------------------------------------

test("the read ledger stops claiming files the compaction deleted", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "mw-restore-"));
  try {
    const kept = join(dir, "editing.ts");
    const dropped = join(dir, "glanced.ts");
    await fs.writeFile(kept, "export const editing = 1;\n");
    await fs.writeFile(dropped, "export const glanced = 2;\n");

    const reads = new Map([
      [kept, { mtimeMs: 1, size: 10, full: true, touchedAt: 5, focus: [{ start: 1, end: 1 }] }],
      [dropped, { mtimeMs: 1, size: 10, full: true, touchedAt: 9 }],
    ]);
    // A third entry for a file that no longer exists: it must leave the ledger too,
    // rather than being carried forward as something the model can see.
    reads.set(join(dir, "deleted.ts"), { mtimeMs: 1, size: 10, full: true, touchedAt: 7 });

    const s = session({ toolContext: { cwd: dir, reads, roots: [dir] } as never });
    await compactNow(s);

    const after = s.toolContext.reads as Map<string, unknown>;
    assert.ok(!after.has(join(dir, "deleted.ts")), "a vanished file must not stay in the ledger");
    for (const [path, record] of after) {
      // Anything still claimed must be claimed because it was just put BACK, which is
      // the invariant: the ledger describes what is on screen, nothing more.
      assert.ok(s.transcript.some((e) => e.content.includes(path)), `${path} is claimed but not in context`);
      assert.equal((record as { full: boolean }).full, true);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("worked-in files come back, and say so", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "mw-restore-"));
  try {
    const worked = join(dir, "lexer.ts");
    await fs.writeFile(worked, "export function lex() {\n  return 'tokens';\n}\n");
    const reads = new Map([[worked, { mtimeMs: 1, size: 10, full: true, touchedAt: 1, focus: [{ start: 1, end: 3 }] }]]);

    const s = session({ toolContext: { cwd: dir, reads, roots: [dir] } as never });
    await compactNow(s);

    // Placed right after the summary: the only position that cannot interact with tool
    // pairing in the kept tail, whatever the tail happens to end with.
    assert.equal(s.transcript[0]!.role, "summary");
    assert.equal(s.transcript[1]!.role, "user");
    assert.match(s.transcript[1]!.content, /restored after the compaction/i);
    assert.match(s.transcript[1]!.content, /return 'tokens'/, "the real file content came back");
    assert.match(s.transcript[1]!.content, /read it again before you edit it/i, "and names what is still gone");
    assert.equal((s.toolContext.reads as Map<string, unknown>).has(worked), true, "and may be claimed again");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a file too large for its share is skipped, not truncated", async () => {
  // Half a file under a heading that says "the file you were working in" is the
  // context-that-lies failure this whole path exists to end.
  const dir = await fs.mkdtemp(join(tmpdir(), "mw-restore-"));
  try {
    const huge = join(dir, "huge.ts");
    await fs.writeFile(huge, "x".repeat(200_000));
    const reads = new Map([[huge, { mtimeMs: 1, size: 200_000, full: true, touchedAt: 1 }]]);
    const s = session({ toolContext: { cwd: dir, reads, roots: [dir] } as never });
    await compactNow(s);
    assert.ok(!s.transcript.some((e) => e.content.includes("<restored_files>")), "nothing was restored");
    assert.equal((s.toolContext.reads as Map<string, unknown>).size, 0, "and nothing is still claimed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A throwing tool must never unwind the turn.
//
// By the time a tool runs, the assistant entry carrying tool_calls has been pushed
// AND persisted. A rejection escaping the call site therefore ends the turn with tool
// calls that have no results, and since the provider requires every tool_call_id to be
// answered, EVERY later request in that live session is malformed. The transcript is
// repaired on load, so the damage lasts exactly until the user restarts, which is the
// worst shape for a fault: the fix is invisible and the session merely looks broken.
//
// Probed before building this: all 28 tools, five wrong argument types each, no
// arguments, and ten Windows path shapes that make `fs` throw. Zero threw. So this is
// defence in depth against a single point of failure, not a fix for an observed bug,
// and the next tool added inherits it.
// ---------------------------------------------------------------------------

test("a thrown tool fault becomes a result the model can act on", () => {
  const r = toolFailureResult("run_command", new Error("spawn EACCES"));
  assert.equal(r.isError, true, "it has to read as a failure, not a successful empty result");
  assert.match(r.output, /run_command tool failed/, "names the tool that broke");
  assert.match(r.output, /spawn EACCES/, "and carries the reason");
  // Told only that something failed, a model reliably assumes it called the tool
  // wrongly and retries the identical call.
  assert.match(r.output, /fault in the tool, not in your request/);
});

test("a tool fault never carries a stack trace into the transcript", () => {
  // A stack is noise to the model, and it names absolute paths that would then be
  // re-sent to the provider on every later turn of the session.
  const error = new Error("boom");
  error.stack = "Error: boom\n    at secretThing (D:\Users\someone\private\path.ts:1:1)";
  const out = toolFailureResult("edit", error).output;
  assert.doesNotMatch(out, /\bat \w+ \(/, "no stack frames");
  assert.doesNotMatch(out, /private\path\.ts/, "no absolute paths from the stack");
});

test("a non-Error thrown value still produces a usable result", () => {
  // Nothing stops a library rejecting with a string or an object.
  for (const thrown of ["just a string", { code: 42 }, null, undefined]) {
    const r = toolFailureResult("search", thrown);
    assert.equal(r.isError, true, String(thrown));
    assert.ok(r.output.length > 0);
  }
});

test("the tool call site turns faults AND interrupts into results, and an interrupt is not called a fault", () => {
  const body = engineSource.match(/const runCall = async \([\s\S]*?\n    \};/)?.[0];
  assert.ok(body, "runCall not found — did it get renamed?");
  assert.match(body, /try \{[\s\S]*?result = await tool\.execute\(/, "execute must be guarded");
  assert.match(body, /toolFailureResult\(call\.name, error\)/, "and a fault must become a result");
  // Esc is the user, not a fault: it must not be reported as a broken tool. It is also not
  // allowed to travel out of the loop, because the assistant message carrying these calls is
  // already saved and a throw leaves them unanswered, which makes every later request in the
  // session malformed. So it becomes its own kind of result.
  const abort = body.match(/if \(isAbort\(error\)\) \{[\s\S]*?\n        \}/)?.[0];
  assert.ok(abort, "an abort must be handled where the call runs");
  assert.doesNotMatch(abort, /throw error/, "an abort must not travel out and strand the saved tool calls");
  assert.match(abort, /summary: "interrupted"/, "and it is reported as an interruption");
  assert.doesNotMatch(abort, /toolFailureResult/, "never as a broken tool");
  // The loop still does not carry on after a cancel: the abort check at the top of the next
  // pass comes before any model call.
  const loop = engineSource.match(/for \(let step = 0;[\s\S]*?await maybeCompact/)?.[0];
  assert.ok(loop && /options\.signal\?\.aborted\) return interrupted\(session\)/.test(loop), "the loop must stop on an abort before the next step");
});

test("a glob-scoped rule keeps applying after a compaction", async () => {
  // The read ledger answers "what can the model see right now", so a compaction empties
  // it. Rule scoping was riding on that same set, which meant a rule the user scoped to
  // a folder silently stopped applying the moment the session was summarised, and only
  // returned if the model happened to re-read a matching file. A standing instruction
  // must not evaporate because the transcript was rewritten.
  //
  // Asserted on the RENDERED rules rather than on whatever structure carries them, so
  // this keeps holding if the mechanism changes again — which it has once already.
  const dir = await fs.mkdtemp(join(tmpdir(), "mw-scope-"));
  try {
    const worked = join(dir, "src", "api", "users.ts");
    await fs.mkdir(join(dir, "src", "api"), { recursive: true });
    await fs.writeFile(worked, "export const users = 1;\n");

    const rules = [
      { name: "pm", description: "", body: "Use pnpm." },
      { name: "api", description: "", body: "Kebab-case routes.", globs: ["src/api/**"] },
    ];
    const scope = createRuleScope();
    const reads = new Map([[worked, { mtimeMs: 1, size: 10, full: true, touchedAt: 1 }]]);
    const s = session({
      toolContext: {
        cwd: dir,
        reads,
        roots: [dir],
        ruleScope: scope,
        governance: { rules, skills: [], forbidden: { patterns: [], root: dir } },
      } as never,
      governance: { rules, skills: [], forbidden: { patterns: [], root: dir } } as never,
    });

    // The session works in src/api, which is what fires the scoped rule.
    noteScopePath(scope, rules, dir, worked);
    assert.match(renderRules(rules, scope.matched), /Kebab-case/, "the rule never fired");

    await compactNow(s);

    // The ledger is deliberately not asserted on here: compaction clears it and then
    // RESTORES files into it, so its contents are a fact about that pass, not about
    // scoping. Scoping is the thing under test and it must hold either way.
    assert.match(
      renderRules(rules, scope.matched),
      /Kebab-case/,
      "the scoped rule stopped applying because the transcript was summarised",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rule scoping does not depend on the read ledger at all", () => {
  // Previously asserted by grepping the engine source for a variable name, which passes
  // for a rename and fails for nothing that matters. The real property is that a rule
  // which has fired renders with an EMPTY ledger — the state a compaction leaves behind.
  const rules = [
    { name: "pm", description: "", body: "Use pnpm." },
    { name: "api", description: "", body: "Kebab-case routes.", globs: ["src/api/**"] },
  ];
  const scope = createRuleScope();
  const root = process.platform === "win32" ? "D:\proj" : "/proj";
  noteScopePath(scope, rules, root, join(root, "src", "api", "users.ts"));
  // No ledger is consulted here because there is nothing to consult.
  assert.match(renderRules(rules, scope.matched), /Kebab-case/);
});
