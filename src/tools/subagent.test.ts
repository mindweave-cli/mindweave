/**
 * subagent.test.ts — spawn_subagent guard paths + forkSession isolation.
 *
 * The happy path (spawn → run child → summary) reuses the real engine/model loop and
 * is covered by the live TUI smoke test; here we verify the parts that must hold
 * WITHOUT a model: the recursion/availability/empty guards, and that a forked child
 * is properly isolated from (yet shares the right state with) its parent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import type { Session } from "../memory/types.js";
import { spawnSubagent, Semaphore, clampSteps } from "./subagent.js";
import { callIsConcurrencySafe } from "../dynamo/engine.js";
import { forkSession } from "../memory/session.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: "/proj", reads: new Map(), todos: [], ...overrides };
}

test("spawn_subagent requires a task", async () => {
  const r = await spawnSubagent.execute({}, ctx({ forkChild: () => ({}) as Session }));
  assert.equal(r.isError, true);
  assert.match(r.output, /`task` is required/);
});

test("spawn_subagent refuses to recurse past the depth cap", async () => {
  const r = await spawnSubagent.execute(
    { task: "do a thing" },
    ctx({ subagentDepth: 1, forkChild: () => ({}) as Session }),
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /cannot spawn another sub-agent/);
});

test("spawn_subagent fails cleanly when the context can't fork (no engine)", async () => {
  const r = await spawnSubagent.execute({ task: "do a thing" }, ctx());
  assert.equal(r.isError, true);
  assert.match(r.output, /aren't available/);
});

// ── parallelism: the concurrency predicate that drives fan-out ────────────────────

test("a read-only sub-agent is concurrency-safe (fans out); an editing one is not", () => {
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x", read_only: true }), true);
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x", read_only: false }), false);
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x" }), false); // default: runs alone
});

test("callIsConcurrencySafe: per-args predicate wins, else read-only ⇒ safe", () => {
  // A plain read-only tool with no predicate → safe.
  assert.equal(callIsConcurrencySafe({ readOnly: true }, {}), true);
  // A mutating tool with no predicate → not safe (serial lane).
  assert.equal(callIsConcurrencySafe({ readOnly: false }, {}), false);
  // The predicate overrides: mutating tool that declares itself safe for these args.
  assert.equal(callIsConcurrencySafe({ readOnly: false, isConcurrencySafe: (a) => a.ro === true }, { ro: true }), true);
  assert.equal(callIsConcurrencySafe({ readOnly: false, isConcurrencySafe: (a) => a.ro === true }, { ro: false }), false);
});

test("clampSteps bounds the budget and rejects junk", () => {
  assert.equal(clampSteps(5), 5);
  assert.equal(clampSteps(10_000), 60); // clamped to MAX_SUBAGENT_STEPS
  assert.equal(clampSteps(0), undefined);
  assert.equal(clampSteps(-3), undefined);
  assert.equal(clampSteps("nope"), undefined);
  assert.equal(clampSteps(undefined), undefined);
});

// ── Semaphore: bounded fan-out must NEVER exceed the limit, and all tasks finish ──

test("Semaphore never exceeds its limit and runs everything", async () => {
  const limit = 3;
  const sem = new Semaphore(limit);
  let active = 0;
  let maxActive = 0;
  let done = 0;
  const task = () =>
    sem.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      done++;
    });
  await Promise.all(Array.from({ length: 12 }, task));
  assert.equal(done, 12, "every queued task ran");
  assert.ok(maxActive <= limit, `never more than ${limit} at once, saw ${maxActive}`);
  assert.equal(maxActive, limit, "and it actually reached the limit (real concurrency)");
});

// ── forkSession ────────────────────────────────────────────────────────────────

const SHARED_CHASSIS = { marker: "shared" };

function parentSession(): Session {
  const toolContext: ToolContext = {
    cwd: "/proj",
    roots: ["/proj"],
    reads: new Map([["/proj/a.ts", { mtimeMs: 1, size: 1, full: true }]]),
    todos: [{ id: "1", text: "parent todo", status: "pending" }] as unknown as ToolContext["todos"],
    chassis: SHARED_CHASSIS as unknown as ToolContext["chassis"],
    guarded: true,
    subagentDepth: 0,
  };
  return {
    id: "parent",
    cwd: "/proj",
    createdAt: 1,
    transcript: [{ role: "user", content: "hello" }],
    toolContext,
    projectMemory: "MEM",
    memoryDir: "/proj/.mem",
    memoryIndex: "IDX",
    priorSessions: 0,
    projectContext: "CTX",
    governance: {} as Session["governance"],
    modelConfig: {} as Session["modelConfig"],
  };
}

test("forkSession gives the child a fresh transcript seeded with the task", () => {
  const child = forkSession(parentSession(), "find all call sites of X");
  assert.notEqual(child.id, "parent");
  assert.equal(child.transcript.length, 1);
  assert.equal(child.transcript[0]!.role, "user");
  assert.match((child.transcript[0] as { content: string }).content, /sub-agent/);
  assert.match((child.transcript[0] as { content: string }).content, /find all call sites of X/);
});

test("forkSession isolates reads + todos but SHARES the code map", () => {
  const parent = parentSession();
  const child = forkSession(parent, "task");
  // Isolated: the child starts with an empty working set.
  assert.equal(child.toolContext.reads.size, 0);
  assert.equal(child.toolContext.todos.length, 0);
  // Parent's ledger is untouched.
  assert.equal(parent.toolContext.reads.size, 1);
  // Shared by reference: same chassis object, so the child sees the same code map.
  assert.equal(child.toolContext.chassis, SHARED_CHASSIS);
  // Inherits the parent's Sentinel gate.
  assert.equal(child.toolContext.guarded, true);
});

test("forkSession increments depth and applies read_only", () => {
  const parent = parentSession();
  const child = forkSession(parent, "task", { readOnly: true });
  assert.equal(child.toolContext.subagentDepth, 1);
  assert.equal(child.toolContext.readOnlyTools, true);
  // Project facts carry over by reference (same objects as the parent).
  assert.equal(child.projectMemory, "MEM");
  assert.equal(child.modelConfig, parent.modelConfig);
});

// ── spawn_subagent's limits are enforced in code; the text must match ─────────
// All three were invisible. The step budget one matters most: a paused child looks
// like a failed child, and the right response (raise max_steps) is the opposite of
// the instinct (give up, or retry the identical call).

test("a sub-agent cannot spawn a sub-agent, and the description says so", async () => {
  const ctx = {
    cwd: process.cwd(),
    reads: new Map(),
    todos: [],
    subagentDepth: 1,
    forkChild: () => {
      throw new Error("must not be reached");
    },
  } as unknown as ToolContext;
  const r = await spawnSubagent.execute({ task: "anything" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /cannot spawn another sub-agent/i);
  assert.match(spawnSubagent.description, /cannot spawn its own children/i);
});

test("the stated concurrency and budget are the real constants", () => {
  // Numbers in prose drift from the code they describe unless something checks.
  assert.match(spawnSubagent.description, /Up to 5 run at once/i);
  assert.match(spawnSubagent.description, /20 tool rounds by default/i);
});

test("read_only decides whether a worker may run in parallel", () => {
  // The parallel claim rests entirely on this predicate.
  assert.equal(spawnSubagent.isConcurrencySafe?.({ read_only: true }), true);
  assert.equal(spawnSubagent.isConcurrencySafe?.({ read_only: false }), false);
  assert.equal(spawnSubagent.isConcurrencySafe?.({}), false, "unset must be the safe default");
});

test("a worker is ALWAYS given an explicit step budget", async () => {
  // The engine no longer caps a turn by default: an interactive turn has a person in
  // front of it holding Esc, and a counter is a worse circuit breaker than that. A
  // worker has neither a screen nor a keyboard, so its cap is the only thing between a
  // misread task and an unbounded bill — and it now exists ONLY because this call site
  // passes one. Dropping `maxSteps` here would silently make every worker unbounded.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./subagent.ts", import.meta.url), "utf8");
  const call = source.indexOf("respond(child, {");
  assert.ok(call > 0, "the worker no longer runs through respond()");
  const options = source.slice(call, call + 400);
  assert.match(options, /maxSteps:/, "a worker is being started without a step budget");
});

test("a worker is never handed the user's messages", async () => {
  // The queue belongs to the person at the prompt and to the turn they are watching. A
  // worker runs on a task it was given; a message typed at the main turn arriving in its
  // context would steer the wrong agent, and the main turn would never see it at all.
  // The isolation is structural: `steer` is simply not passed here.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./subagent.ts", import.meta.url), "utf8");
  const call = source.indexOf("respond(child, {");
  assert.ok(call > 0, "the worker no longer runs through respond()");
  assert.ok(!/\bsteer:/.test(source.slice(call, call + 600)), "a worker is being given the user's message queue");
});

test("a verifier runs alone even when it was also marked read-only: it runs commands, and two would see each other's output", () => {
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x", verify: true }), false);
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x", read_only: true, verify: true }), false);
  assert.equal(spawnSubagent.isConcurrencySafe!({ task: "x", read_only: true }), true, "a research worker still fans out");
});

test("forkSession gives a verifier its command tool, and nobody else", () => {
  const parent = parentSession();
  assert.equal(forkSession(parent, "t", { readOnly: true, verifier: true }).toolContext.verifierTools, true);
  assert.equal(forkSession(parent, "t", { readOnly: true }).toolContext.verifierTools, false);
  assert.equal(forkSession(parent, "t").toolContext.verifierTools, false);
});
