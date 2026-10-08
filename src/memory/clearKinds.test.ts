/**
 * clearKinds.test.ts — what clearing may touch.
 *
 * Every result used to be "history": the task list was cleared down to its first line, a
 * user's answer could be stubbed, a sub-agent's report (up to 60 rounds of work) could go,
 * and a 16-token confirmation was replaced by a 36-token stub. Now what cannot be had again
 * is kept, a snapshot keeps only its newest copy, and nothing is cleared into something bigger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLEARED_STUB, clearKind, microcompact } from "./compaction.js";
import type { Entry } from "./types.js";

const BIG = "line of output that is long enough to be worth clearing\n".repeat(30);

/** One call and its result, for a tool, in the transcript's own shape. */
function round(id: string, name: string, content: string, args = "{}"): Entry[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
    { role: "tool", toolCallId: id, content },
  ];
}

/** Old rounds for `names`, then enough recent rounds that the old ones fall outside the kept window. */
function transcript(old: [string, string][]): Entry[] {
  const out: Entry[] = [{ role: "user", content: "work" }];
  old.forEach(([name, body], i) => out.push(...round(`old${i}`, name, body)));
  for (let i = 0; i < 12; i++) out.push(...round(`new${i}`, "read_file", BIG));
  return out;
}

const isCleared = (entries: Entry[], id: string) =>
  entries.some((e) => e.role === "tool" && e.toolCallId === id && e.content.includes(CLEARED_STUB));

test("what cannot be had again is never cleared", () => {
  const kept = ["ask_user", "use_skill", "spawn_subagent", "save_memory", "governor", "skill", "exit_plan", "workspace"];
  const { entries } = microcompact(transcript(kept.map((n) => [n, BIG] as [string, string])));
  kept.forEach((n, i) => assert.equal(isCleared(entries, `old${i}`), false, `${n} was cleared`));
  assert.equal(isCleared(entries, "new0"), true, "ordinary results still are");
});

test("a snapshot keeps only its newest copy", () => {
  const e = transcript([["todo_write", BIG], ["shells", BIG], ["todo_write", BIG], ["ui", BIG], ["ui", BIG]]);
  const { entries } = microcompact(e);
  assert.equal(isCleared(entries, "old0"), true, "an older task list is history");
  assert.equal(isCleared(entries, "old2"), false, "the newest task list stays");
  assert.equal(isCleared(entries, "old1"), false, "the only shells list stays");
  assert.equal(isCleared(entries, "old3"), true);
  assert.equal(isCleared(entries, "old4"), false);
});

test("a finished task's sweep may release pinned results", () => {
  const e = transcript([["ask_user", BIG]]);
  assert.equal(isCleared(microcompact(e, 2, new Set(), true).entries, "old0"), true);
  assert.equal(isCleared(microcompact(e, 2).entries, "old0"), false);
});

test("a result smaller than its own stub is left alone, but its edit body still shrinks", () => {
  const e: Entry[] = [
    { role: "user", content: "work" },
    ...round("w", "write_file", "wrote 3 lines", JSON.stringify({ path: "a.ts", content: "x".repeat(4000) })),
    ...Array.from({ length: 12 }, (_, i) => round(`n${i}`, "read_file", BIG)).flat(),
  ];
  const { entries } = microcompact(e);
  assert.equal(isCleared(entries, "w"), false, "a 3-token confirmation was replaced by a bigger stub");
  const call = entries.find((x) => x.role === "assistant" && x.toolCalls?.[0]?.id === "w");
  assert.ok(call && call.role === "assistant" && call.toolCalls![0]!.arguments.length < 400, "the 4000-character body should have shrunk");
});

test("kinds: anything unlisted is history", () => {
  assert.equal(clearKind("run_command"), "history");
  assert.equal(clearKind("mcp__github__list"), "history");
  assert.equal(clearKind("ask_user"), "pinned");
  assert.equal(clearKind("todo_write"), "latest");
});
