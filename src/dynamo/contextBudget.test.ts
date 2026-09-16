/**
 * contextBudget.test.ts — the /context breakdown.
 *
 * The defects worth guarding here are all defects of OMISSION, which is why they get
 * behavioural tests rather than shape assertions: a breakdown that silently drops a
 * category still renders, still adds up, and still looks right. Measured sessions put
 * tool-call ARGUMENTS at roughly the same size as tool RESULTS, so the two failures
 * that matter are counting arguments as free, and offering to reclaim bytes that the
 * clearing pass would refuse to touch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBudget, formatBudget } from "./contextBudget.js";
import { CLEARED_STUB, KEEP_LAST_N } from "../memory/compaction.js";
import type { Entry } from "../memory/types.js";

/** One assistant tool-call plus its result, as the transcript stores them. */
function round(id: string, name: string, args: string, result: string): Entry[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
    { role: "tool", toolCallId: id, content: result },
  ] as Entry[];
}

const payload = (n: number) => "x".repeat(n);

test("a write_file's payload is counted, not treated as free", () => {
  // The body of a written file lives in the CALL, and stays in the transcript whether
  // or not the result is later cleared. A breakdown that only weighs results reports
  // roughly half the real cost of a session that writes files.
  const big = payload(40_000);
  const budget = contextBudget(
    round("1", "write_file", JSON.stringify({ path: "a.ts", content: big }), "Wrote a.ts"),
  );

  const args = budget.slices.find((s) => s.label === "Tool call arguments");
  assert.ok(args && args.tokens > 5_000, `arguments were not weighed: ${JSON.stringify(budget.slices)}`);
  const results = budget.slices.find((s) => s.label === "Tool results");
  assert.ok(args!.tokens > (results?.tokens ?? 0) * 10, "the payload should dwarf its one-line result");
});

test("the per-tool table names the tool that a result came from", () => {
  // A tool entry carries only a call id. Without joining it back to the call, the table
  // can say results are expensive but never which tool to stop calling — which is the
  // only form of the answer anyone can act on.
  const budget = contextBudget([
    ...round("1", "run_command", "{}", payload(8_000)),
    ...round("2", "run_command", "{}", payload(8_000)),
    ...round("3", "read_file", "{}", payload(1_000)),
  ]);

  assert.equal(budget.tools[0]!.name, "run_command", "the heaviest tool must sort first");
  assert.equal(budget.tools[0]!.calls, 2);
  assert.ok(budget.tools[0]!.tokens > budget.tools[1]!.tokens);
  assert.deepEqual(budget.tools.map((t) => t.name).sort(), ["read_file", "run_command"]);
});

test("already-cleared results are not offered up a second time", () => {
  // Re-counting a stub as reclaimable makes /context promise a saving that /compact
  // cannot deliver, and the discrepancy only shows after the user acts on it.
  const stale = Array.from({ length: KEEP_LAST_N + 4 }, (_, i) =>
    round(`c${i}`, "read_file", "{}", CLEARED_STUB),
  ).flat();
  assert.equal(contextBudget(stale).reclaimable, 0, "cleared bodies have nothing left to free");
});

test("recent results are excluded from the reclaimable figure", () => {
  // Clearing deliberately protects the last few rounds, so counting them would quote a
  // saving the clearing pass refuses to make.
  const recent = Array.from({ length: 3 }, (_, i) => round(`r${i}`, "read_file", "{}", payload(20_000))).flat();
  assert.equal(contextBudget(recent).reclaimable, 0, "nothing older than the protected window exists yet");

  const withOld = [...round("old", "read_file", "{}", payload(20_000)), ...recent, ...recent, ...recent];
  assert.ok(contextBudget(withOld).reclaimable > 0, "an old result past the window should be reclaimable");
});

test("measured overhead is reported as measured, and omitted rather than guessed", () => {
  // The non-transcript half is a figure the provider reported; the transcript half is a
  // character estimate. Presenting them as equally certain is how a breakdown earns
  // distrust, and inventing the overhead when none was measured is worse than a gap.
  const entries = round("1", "read_file", "{}", payload(4_000));

  const without = contextBudget(entries);
  assert.ok(!without.slices.some((s) => s.label === "System prompt and tools"), "must not invent an overhead");

  const withIt = contextBudget(entries, 18_000);
  const row = withIt.slices.find((s) => s.label === "System prompt and tools");
  assert.equal(row?.tokens, 18_000);
  assert.equal(row?.measured, true);
  assert.equal(withIt.total, without.total + 18_000, "the total must include it exactly once");
});

test("the engine's own reminders are separated from what the person typed", () => {
  // Nudges arrive as user messages. Billing them to the user makes the one category
  // they can actually control look like the problem.
  const budget = contextBudget([
    { role: "user", content: payload(400) },
    { role: "user", content: payload(4_000), synthetic: true },
  ] as Entry[]);

  const yours = budget.slices.find((s) => s.label === "Your messages")!;
  const auto = budget.slices.find((s) => s.label === "Automatic reminders")!;
  assert.ok(auto.tokens > yours.tokens * 5, "the reminder was billed to the user");
});

test("empty categories are dropped, and the total is the sum of what is shown", () => {
  const budget = contextBudget(round("1", "read_file", "{}", payload(4_000)));
  assert.ok(budget.slices.every((s) => s.tokens > 0), "a zero row is noise");
  assert.equal(budget.total, budget.slices.reduce((n, s) => n + s.tokens, 0));
  assert.deepEqual(contextBudget([]).slices, []);
  assert.equal(contextBudget([]).total, 0);
});

// ── rendering ────────────────────────────────────────────────────────────────

test("the rendered block distinguishes a measured figure from an estimate", () => {
  // Half this table is a character-count guess and half is what the provider counted.
  // Printing them identically invites someone to act on the guess as if it were the
  // bill, and there is no way to tell them apart after the fact.
  const budget = contextBudget(round("1", "read_file", "{}", payload(40_000)), 18_000);
  const text = formatBudget(budget, 200_000, 160_000);

  const overheadLine = text.split("\n").find((l) => l.includes("System prompt"))!;
  const resultsLine = text.split("\n").find((l) => l.includes("Tool results"))!;
  assert.doesNotMatch(overheadLine, /~/, "a reported figure must not be marked as a guess");
  assert.match(resultsLine, /~/, "an estimate must be marked");
  assert.match(text, /provider reported/, "the marking needs a legend or it is noise");
});

test("the header states the window and where compaction lands", () => {
  const text = formatBudget(contextBudget(round("1", "read_file", "{}", payload(4_000))), 200_000, 160_000);
  assert.match(text.split("\n")[0]!, /200k/);
  assert.match(text.split("\n")[0]!, /compacts at 160k/);
});

test("an empty context says so instead of rendering an empty table", () => {
  assert.match(formatBudget(contextBudget([]), 200_000, 160_000), /Nothing in context yet/);
});

test("with nothing old enough to clear, no saving is promised", () => {
  const text = formatBudget(contextBudget(round("1", "read_file", "{}", payload(40_000))), 200_000, 160_000);
  assert.doesNotMatch(text, /frees about/, "quoting a saving the clearing pass would refuse is a lie");
  assert.match(text, /Nothing old enough to clear/);
});
