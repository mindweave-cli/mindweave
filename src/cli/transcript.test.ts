/**
 * transcript.test.ts — the transcript state machine: silent token accumulation
 * (whole-block reveal), narration sealing, tool lifecycle, and the drain ordering
 * that keeps the live region tiny and blocks in order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduce, trimNarration, NARRATION_LINES, type Action, type TranscriptState } from "./transcript.js";
import { isGroupable } from "./toolDisplay.js";

test("only read-only discovery tools group — edits, writes, runs, tests never do", () => {
  // Reads + silent status checks fold into one row.
  for (const n of ["read_file", "read_symbol", "shells"]) {
    assert.ok(isGroupable(n), `${n} should group (silent receipt — collapsing loses nothing)`);
  }
  // Search and the code-intel lookups do NOT group, because they no longer render at
  // all (search.ts sets quiet on every path; navigational() wraps the others): they are
  // how the agent finds its way around, not work done to the project. Grouping them
  // would put them back on screen as a count that answers nothing. `todo_write` is
  // silent too, and for the same kind of reason — its reader is the model.
  for (const n of ["search", "outline", "definition", "references", "relevant", "todo_write"]) {
    assert.ok(!isGroupable(n), `${n} is hidden outright, so it must not group`);
  }
  // Anything whose row carries output you need to see (a diff, command/test output,
  // fetched content, the meta result) must keep its own row.
  for (const n of ["edit", "replace_symbol_body", "write_file", "run_command", "skill", "use_skill", "web", "spawn_subagent"]) {
    assert.ok(!isGroupable(n), `${n} must NOT group`);
  }
});

function run(actions: Action[]): TranscriptState {
  return actions.reduce(reduce, initialState());
}

test("tokens accumulate silently — the block shows nothing until it seals", () => {
  const s = run([
    { type: "token", delta: "Hel" },
    { type: "token", delta: "lo" },
  ]);
  // Open assistant block exists but its visible text is still empty.
  const block = s.tail.find((b) => b.kind === "assistant");
  assert.ok(block && block.kind === "assistant" && block.text === "");
  assert.equal(s.raw, "Hello");
  assert.equal(s.committed.length, 0);
});

test("finishReply seals the whole text at once and commits it", () => {
  const s = run([
    { type: "token", delta: "Hello world" },
    { type: "finishReply" },
  ]);
  assert.equal(s.tail.length, 0);
  assert.equal(s.committed.length, 1);
  assert.equal(s.committed[0]!.kind, "assistant");
  assert.equal((s.committed[0] as { text: string }).text, "Hello world");
  assert.equal(s.lastReply, "Hello world");
});

test("an empty assistant block is dropped, not committed", () => {
  const s = run([{ type: "token", delta: "   " }, { type: "finishReply" }]);
  assert.equal(s.committed.length, 0);
  assert.equal(s.tail.length, 0);
});

test("toolStart seals pending narration, then shows the tool running", () => {
  const s = run([
    { type: "token", delta: "Let me check." },
    { type: "toolStart", toolId: "a", name: "Read", arg: "x.ts" },
  ]);
  // Narration committed; tool running in the tail.
  assert.equal(s.committed.length, 1);
  assert.equal(s.committed[0]!.kind, "assistant");
  assert.equal(s.tail.length, 1);
  const tool = s.tail[0]!;
  assert.ok(tool.kind === "tool" && tool.status === "running" && tool.name === "Read");
});

test("toolEnd resolves the tool and drains it to committed", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Update", arg: "home.html" },
    { type: "toolEnd", toolId: "a", ok: true, summary: "1 replacement", detail: "- old\n+ new" },
  ]);
  assert.equal(s.tail.length, 0);
  assert.equal(s.committed.length, 1);
  const tool = s.committed[0]!;
  assert.ok(tool.kind === "tool" && tool.status === "ok" && tool.detail === "- old\n+ new");
});

test("a failed tool resolves to error status", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Run", arg: "npm test" },
    { type: "toolEnd", toolId: "a", ok: false, summary: "exit 1" },
  ]);
  assert.equal((s.committed[0] as { status: string }).status, "error");
});

test("toolEnd's action/name override the row set at toolStart — a governor decision discovered mid-call", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Update", arg: "secret.txt", action: "edit" },
    { type: "toolEnd", toolId: "a", ok: false, summary: "kept protected", action: "governor", name: "Governor" },
  ]);
  const tool = s.committed[0]!;
  assert.ok(tool.kind === "tool");
  assert.equal((tool as { action?: string }).action, "governor");
  assert.equal(tool.name, "Governor");
});

test("toolEnd with no action/name override leaves the toolStart row untouched", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Update", arg: "home.html", action: "edit" },
    { type: "toolEnd", toolId: "a", ok: true, summary: "1 replacement" },
  ]);
  const tool = s.committed[0]!;
  assert.ok(tool.kind === "tool");
  assert.equal((tool as { action?: string }).action, "edit");
  assert.equal(tool.name, "Update");
});

test("a QUIET failure leaves no row at all", () => {
  // An old_string that matched two places is the agent adjusting its own aim, not news.
  // Painting it red teaches the user that error rows are background noise, which is the
  // one thing an error row must never become. The model still gets the full reason.
  const s = run([
    { type: "toolStart", toolId: "a", name: "Update", arg: "MINDWEAVE.md" },
    { type: "toolEnd", toolId: "a", ok: false, summary: "matches 2 places", quiet: true },
  ]);
  assert.equal(s.committed.length, 0, "nothing committed");
  assert.equal(s.tail.length, 0, "and nothing left hanging in the tail");
});

test("a quiet failure inside a group removes only that item", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: false, summary: "no match", quiet: true },
    { type: "toolEnd", toolId: "b", ok: true, summary: "40 lines" },
    { type: "finishReply" },
  ]);
  const group = [...s.committed, ...s.tail].find((b) => b.kind === "tools");
  assert.ok(group && group.kind === "tools");
  if (group && group.kind === "tools") {
    assert.equal(group.items.length, 1, "the quiet item is gone");
    assert.equal(group.items[0]!.toolId, "b");
  }
});

test("a group whose only item went quiet disappears entirely", () => {
  // Otherwise the user is left with an "Exploring… (0)" header, which is exactly the
  // noise this removes, just phrased differently.
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: false, summary: "no match", quiet: true },
    { type: "finishReply" },
  ]);
  assert.equal([...s.committed, ...s.tail].filter((b) => b.kind === "tools").length, 0);
});

test("a quiet failure does not block the tools behind it from draining", () => {
  // The dropped row must not sit in the tail as an unfinished block, or every later
  // tool queues behind a row that will never resolve.
  const s = run([
    { type: "toolStart", toolId: "a", name: "Update", arg: "a.ts" },
    { type: "toolEnd", toolId: "a", ok: false, summary: "matches 2 places", quiet: true },
    { type: "toolStart", toolId: "b", name: "Update", arg: "a.ts" },
    { type: "toolEnd", toolId: "b", ok: true, summary: "1 replacement" },
  ]);
  assert.equal(s.committed.length, 1, "the successful retry is the only thing shown");
  assert.equal((s.committed[0] as { status: string }).status, "ok");
});

test("an ordinary failure is still shown — quiet is not a blanket mute", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Run", arg: "npm test" },
    { type: "toolEnd", toolId: "a", ok: false, summary: "exit 1" },
  ]);
  assert.equal(s.committed.length, 1);
  assert.equal((s.committed[0] as { status: string }).status, "error");
});

test("drain keeps order — a finished later tool waits behind an unfinished earlier one", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts" },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts" },
    { type: "toolEnd", toolId: "b", ok: true, summary: "done" }, // second finishes first
  ]);
  // Nothing commits yet — the first tool is still running, so the second can't
  // print ahead of it.
  assert.equal(s.committed.length, 0);
  assert.equal(s.tail.length, 2);

  const s2 = reduce(s, { type: "toolEnd", toolId: "a", ok: true, summary: "done" });
  // Now both drain, in start order.
  assert.equal(s2.committed.length, 2);
  assert.equal((s2.committed[0] as { arg: string }).arg, "a.ts");
  assert.equal((s2.committed[1] as { arg: string }).arg, "b.ts");
});

// ── discovery grouping ────────────────────────────────────────────────────────

test("consecutive discovery calls fold into one live group, not separate rows", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts", group: true },
    { type: "toolStart", toolId: "c", name: "Glob", arg: "**/*", group: true },
  ]);
  assert.equal(s.tail.length, 1, "one group block, not three rows");
  const g = s.tail[0]!;
  assert.ok(g.kind === "tools" && g.items.length === 3 && !g.done);
  assert.equal(s.committed.length, 0, "stays live until closed");
});

test("toolEnd resolves a group item in place, group stays open", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
  ]);
  const g = s.tail[0]!;
  assert.ok(g.kind === "tools");
  assert.equal(g.items[0]!.status, "ok");
  assert.equal(g.items[1]!.status, "running");
  assert.equal(s.committed.length, 0);
});

test("the discovery group commits when the turn ends", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
    { type: "finishReply" },
  ]);
  assert.equal(s.tail.length, 0);
  assert.equal(s.committed.length, 1);
  assert.ok(s.committed[0]!.kind === "tools" && s.committed[0]!.done);
});

test("narration closes the group; later reads start a fresh one", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
    { type: "token", delta: "Found it." },
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts", group: true },
  ]);
  assert.equal(s.committed.length, 2);
  assert.equal(s.committed[0]!.kind, "tools");
  assert.equal(s.committed[1]!.kind, "assistant");
  assert.ok(s.tail[0]!.kind === "tools" && (s.tail[0]!).items.length === 1);
});

test("a mutating tool closes the group and keeps its own row with detail", () => {
  const s = run([
    { type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
    { type: "toolStart", toolId: "w", name: "Update", arg: "a.ts" }, // no group flag → individual
  ]);
  assert.equal(s.committed.length, 1);
  assert.equal(s.committed[0]!.kind, "tools");
  assert.equal(s.tail.length, 1);
  assert.ok(s.tail[0]!.kind === "tool" && s.tail[0]!.name === "Update");
});

// ── sub-agent nested rail ─────────────────────────────────────────────────────

test("subagentStart opens a live nested block; its tool calls fold into the rail", () => {
  const s = run([
    { type: "subagentStart", agentId: "sub1", task: "find authFetch call sites", readOnly: true },
    { type: "subToolStart", agentId: "sub1", toolId: "a", name: "Search", arg: "authFetch" },
    { type: "subToolStart", agentId: "sub1", toolId: "b", name: "Read", arg: "login.ts" },
  ]);
  assert.equal(s.tail.length, 1, "one nested block, not separate rows");
  const blk = s.tail[0]!;
  assert.ok(blk.kind === "subagent" && !blk.done);
  const agent = blk.kind === "subagent" ? blk.agents[0]! : undefined;
  assert.equal(agent?.readOnly, true);
  assert.equal(agent?.items.length, 2);
  assert.equal(s.committed.length, 0, "stays live until it reports back");
});

test("subToolEnd resolves a rail item in place, the sub-agent block stays open", () => {
  const s = run([
    { type: "subagentStart", agentId: "s", task: "t", readOnly: true },
    { type: "subToolStart", agentId: "s", toolId: "a", name: "Read", arg: "x.ts" },
    { type: "subToolEnd", agentId: "s", toolId: "a", ok: true, summary: "Read x.ts (12 lines)" },
  ]);
  const blk = s.tail[0]!;
  assert.ok(blk.kind === "subagent" && !blk.done);
  const item = blk.kind === "subagent" ? blk.agents[0]!.items[0]! : undefined;
  assert.equal(item?.status, "ok");
  assert.equal(item?.note, "Read x.ts (12 lines)");
});

test("subagentEnd seals the sub-agent and drains it to committed with its summary", () => {
  const s = run([
    { type: "subagentStart", agentId: "s", task: "t", readOnly: false },
    { type: "subToolStart", agentId: "s", toolId: "a", name: "Read", arg: "x.ts" },
    { type: "subToolEnd", agentId: "s", toolId: "a", ok: true },
    { type: "subagentEnd", agentId: "s", ok: true, summary: "3 steps" },
  ]);
  assert.equal(s.tail.length, 0);
  assert.equal(s.committed.length, 1);
  const blk = s.committed[0]!;
  assert.ok(blk.kind === "subagent" && blk.done);
  const agent = blk.kind === "subagent" ? blk.agents[0]! : undefined;
  assert.equal(agent?.status, "ok");
  assert.equal(agent?.summary, "3 steps");
});

test("a failed sub-agent seals to error status", () => {
  const s = run([
    { type: "subagentStart", agentId: "s", task: "t", readOnly: true },
    { type: "subagentEnd", agentId: "s", ok: false, summary: "failed" },
  ]);
  const blk = s.committed[0]!;
  assert.equal(blk.kind === "subagent" ? blk.agents[0]!.status : "", "error");
});

test("narration before a sub-agent is sealed first, then the rail opens", () => {
  const s = run([
    { type: "token", delta: "Delegating the search." },
    { type: "subagentStart", agentId: "s", task: "t", readOnly: true },
  ]);
  assert.equal(s.committed.length, 1);
  assert.equal(s.committed[0]!.kind, "assistant");
  assert.equal(s.tail.length, 1);
  assert.equal(s.tail[0]!.kind, "subagent");
});

test("concurrent sub-agents share ONE block but keep their own rails", () => {
  // Read-only workers fan out in parallel. As separate blocks their rows interleaved
  // into a stripe; grouped, each still owns its own calls.
  const s = run([
    { type: "subagentStart", agentId: "a", task: "auth", readOnly: true },
    { type: "subagentStart", agentId: "b", task: "api", readOnly: true },
    { type: "subToolStart", agentId: "a", toolId: "1", name: "Read", arg: "auth.ts" },
    { type: "subToolStart", agentId: "b", toolId: "2", name: "Read", arg: "api.ts" },
    { type: "subToolStart", agentId: "a", toolId: "3", name: "Read", arg: "login.ts" },
  ]);
  assert.equal(s.tail.length, 1, "one block, however many workers");
  const blk = s.tail[0]!;
  assert.ok(blk.kind === "subagent");
  const agents = blk.kind === "subagent" ? blk.agents : [];
  assert.equal(agents.length, 2);
  assert.equal(agents.find((x) => x.agentId === "a")?.items.length, 2);
  assert.equal(agents.find((x) => x.agentId === "b")?.items.length, 1);
});

test("one worker finishing does NOT commit the block while a sibling is still going", () => {
  // The failure this prevents: committing on the first end strands the other worker's
  // rows in a block that has already scrolled away as finished.
  const mid = run([
    { type: "subagentStart", agentId: "a", task: "auth", readOnly: true },
    { type: "subagentStart", agentId: "b", task: "api", readOnly: true },
    { type: "subagentEnd", agentId: "a", ok: true, summary: "3 steps" },
  ]);
  assert.equal(mid.committed.length, 0, "still live: one worker is unfinished");
  assert.equal(mid.tail.length, 1);

  const done = [{ type: "subagentEnd", agentId: "b", ok: true, summary: "2 steps" } as Action].reduce(reduce, mid);
  assert.equal(done.tail.length, 0, "the last one to finish commits the block");
  assert.equal(done.committed.length, 1);
});

test("a later sub-agent opens a NEW block once the previous one has finished", () => {
  // Joining is only for workers that overlap. Sequential delegations must not pile
  // into one block that grows for the whole session.
  const s = run([
    { type: "subagentStart", agentId: "a", task: "first", readOnly: true },
    { type: "subagentEnd", agentId: "a", ok: true, summary: "done" },
    { type: "subagentStart", agentId: "b", task: "second", readOnly: true },
  ]);
  assert.equal(s.committed.length, 1, "the finished one committed on its own");
  assert.equal(s.tail.length, 1, "the new one opened separately");
  assert.equal(s.tail[0]!.kind === "subagent" ? s.tail[0]!.agents.length : 0, 1);
});

test("note and say commit directly without disturbing a streaming block", () => {
  const s = run([
    { type: "token", delta: "partial" },
    { type: "note", text: "a header" },
  ]);
  // The note is queued in the tail behind the unfinished assistant block (order
  // preserved), so it isn't committed ahead of it.
  assert.equal(s.committed.length, 0);
  assert.equal(s.tail.length, 2);

  const done = run([{ type: "say", text: "hello" }]);
  assert.equal(done.committed.length, 1);
  assert.equal(done.committed[0]!.kind, "assistant");
});

// ── narration is CUT at the display, not merely discouraged ───────────────────
// The prompt asks for two sentences and the engine nudges past them. Both are
// requests. Measured live, with both in place: a single question produced six
// paragraph-length blocks and the nudge fired into a void. The screen is the one
// place the rule can actually hold, so it holds here.

const ESSAY =
  "I now have a clear picture of what's next. Let me verify the current state by reading the render layer. " +
  "The picture: priority #1 is already substantially built and wired through the whole stack. " +
  "So what's genuinely left is thin. Those are minor.";

test("narration before a tool call is cut to the budget", () => {
  const s = run([
    { type: "token", delta: ESSAY },
    { type: "toolStart", toolId: "1", name: "read_file", arg: "a.ts", action: "read", group: false },
  ]);
  const block = [...s.committed, ...s.tail].find((b) => b.kind === "assistant");
  assert.ok(block && block.kind === "assistant", "no assistant block was committed");
  assert.ok(block.text.length < ESSAY.length, "the essay reached the screen untouched");
  assert.equal(block.text, trimNarration(ESSAY));
  assert.match(block.text, /^I now have a clear picture/, "it keeps the front, which carries the finding");
  assert.doesNotMatch(block.text, /Those are minor/, "the tail is deliberation");
});

test("the reply that ENDS a turn is never cut", () => {
  // That one is the answer to the question. Trimming it would lose real work.
  const s = run([{ type: "token", delta: ESSAY }, { type: "finishReply" }]);
  assert.equal((s.committed[0] as { text: string }).text, ESSAY);
  assert.equal(s.lastReply, ESSAY);
});

test("narration already within budget is left exactly as written", () => {
  const short = "Build passed. Running the tests now.";
  assert.equal(trimNarration(short), short);
  assert.equal(trimNarration(""), "");
});

test("the budget is the stated number of sentences", () => {
  const four = "One thing. Two thing. Three thing. Four thing.";
  assert.equal(trimNarration(four).split(/(?<=[.!?])\s+/).length, NARRATION_LINES);
});

test("the model is allowed to talk between tool calls, on every step", () => {
  // This was once capped at ONE block per turn, to stop a 23-call turn printing 24
  // prose blocks. The cap could not tell a repetitive model from a quiet one, so
  // against a sparing model it only guaranteed silence: a long turn showed the user
  // nothing at all between the request and the answer, and the tool looked hung.
  const s = run([
    { type: "user", text: "go" },
    { type: "token", delta: "Let me read the backend pieces." },
    { type: "toolStart", toolId: "1", name: "read_file", arg: "a.ts", action: "read", group: false },
    { type: "toolEnd", toolId: "1", ok: true },
    { type: "token", delta: "That was not it. Checking the settings." },
    { type: "toolStart", toolId: "2", name: "read_file", arg: "b.ts", action: "read", group: false },
    { type: "toolEnd", toolId: "2", ok: true },
  ]);
  const narration = [...s.committed, ...s.tail].filter((b) => b.kind === "assistant");
  assert.equal(narration.length, 2, "the model went quiet after its first line");
  assert.match((narration[1] as { text: string }).text, /Checking the settings/);
});

test("each line of narration is still bounded, so it cannot become a wall", () => {
  // Removing the per-turn cap does not license a paragraph per step. The per-block
  // trim is what keeps a long turn readable.
  const s = run([
    { type: "user", text: "go" },
    { type: "token", delta: "One. Two. Three. Four. Five." },
    { type: "toolStart", toolId: "1", name: "read_file", arg: "a.ts", action: "read", group: false },
    { type: "toolEnd", toolId: "1", ok: true },
  ]);
  const narration = [...s.committed, ...s.tail].filter((b) => b.kind === "assistant");
  assert.equal(narration.length, 1);
  const text = (narration[0] as { text: string }).text;
  assert.match(text, /One. Two./, "the opening sentences were not kept");
  assert.ok(!text.includes("Five"), `narration was not trimmed: ${text}`);
});

test("the final reply is never suppressed, however much narration came before", () => {
  const s = run([
    { type: "user", text: "go" },
    { type: "token", delta: "Looking." },
    { type: "toolStart", toolId: "1", name: "read_file", arg: "a.ts", action: "read", group: false },
    { type: "toolEnd", toolId: "1", ok: true },
    { type: "token", delta: "Done. The gate was reading Map order instead of recency." },
    { type: "finishReply" },
  ]);
  assert.match(s.lastReply, /Map order instead of recency/);
});

test("the next turn gets its own narration line", () => {
  const s = run([
    { type: "user", text: "first" },
    { type: "token", delta: "One." },
    { type: "toolStart", toolId: "1", name: "read_file", arg: "a.ts", action: "read", group: false },
    { type: "toolEnd", toolId: "1", ok: true },
    { type: "finishReply" },
    { type: "user", text: "second" },
    { type: "token", delta: "Two." },
    { type: "toolStart", toolId: "2", name: "read_file", arg: "b.ts", action: "read", group: false },
    { type: "toolEnd", toolId: "2", ok: true },
  ]);
  const texts = [...s.committed, ...s.tail].filter((b) => b.kind === "assistant").map((b) => (b as { text: string }).text);
  assert.deepEqual(texts, ["One.", "Two."], "the budget refills per turn, not per session");
});

test("a rejected draft reply never reaches the screen", () => {
  // The reply gate discards an over-long draft and has the model rewrite it. The draft
  // has already streamed in as tokens by then — unrendered, because text reveals whole
  // on seal — so dropping the buffer is what keeps the user from reading both.
  let s = reduce(initialState(), { type: "user", text: "fix the guard" });
  for (const delta of ["## What changed\n", "A very long recap ", "of work you watched."]) {
    s = reduce(s, { type: "token", delta });
  }
  s = reduce(s, { type: "resetReply" });
  for (const delta of ["Fixed. ", "The guard was inverted."]) {
    s = reduce(s, { type: "token", delta });
  }
  s = reduce(s, { type: "finishReply" });

  const all = [...s.committed, ...s.tail];
  const replies = all.filter((b) => b.kind === "assistant").map((b) => (b as { text: string }).text);
  assert.deepEqual(replies, ["Fixed. The guard was inverted."]);
  assert.equal(s.lastReply, "Fixed. The guard was inverted.");
  assert.ok(!JSON.stringify(all).includes("What changed"), "no trace of the draft anywhere");
});

test("resetReply on a turn with nothing buffered is harmless", () => {
  const s = reduce(reduce(initialState(), { type: "user", text: "hi" }), { type: "resetReply" });
  assert.equal(s.raw, "");
});

/**
 * `/clear` — the screen empties, and the id counter deliberately does not restart.
 *
 * The blocks are rendered from `committed`+`tail` into a virtualized alt-screen frame
 * (not Ink's <Static>, which writes to scrollback and could not be taken back), so
 * emptying these two lists IS the clear.
 */
test("clear empties everything the conversation put on screen", () => {
  let s = initialState();
  for (const a of [
    { type: "user", text: "do the thing" },
    { type: "toolStart", toolId: "t1", name: "read_file", arg: "a.ts" },
    { type: "toolEnd", toolId: "t1", ok: true, summary: "read" },
    { type: "token", delta: "here is the answer" },
    { type: "finishReply" },
  ] as Action[]) {
    s = reduce(s, a);
  }
  assert.ok(s.committed.length + s.tail.length > 0, "the fixture produced nothing to clear");

  const cleared = reduce(s, { type: "clear" });
  assert.deepEqual(cleared.committed, [], "finished blocks stayed on screen");
  assert.deepEqual(cleared.tail, [], "in-progress blocks stayed on screen");
  assert.deepEqual(cleared.toolMap, {}, "tool rows still map to ids that no longer exist");
  assert.equal(cleared.openAsstId, null, "a half-open assistant block outlived the conversation");
  assert.equal(cleared.raw, "", "accumulated reply text outlived the conversation");
  assert.equal(cleared.lastReply, "", "the previous reply is still the recorded one");
});

test("clear does NOT restart the block id counter", () => {
  // Block ids are React keys. Restarting the counter makes the first block of the new
  // conversation collide with a key React has just seen, and Ink reuses the old node
  // instead of mounting a fresh one.
  let s = initialState();
  s = reduce(s, { type: "user", text: "one" });
  s = reduce(s, { type: "user", text: "two" });
  const seqBefore = s.seq;
  assert.ok(seqBefore > 0);

  const cleared = reduce(s, { type: "clear" });
  assert.equal(cleared.seq, seqBefore, "the id counter restarted — new blocks will collide with old React keys");

  const next = reduce(cleared, { type: "user", text: "after the clear" });
  const newId = [...next.committed, ...next.tail][0]!.id;
  assert.ok(newId > seqBefore, `the first block after a clear reused id ${newId}`);
});

test("clear leaves a state a new conversation can build on", () => {
  // A clear that produced a subtly broken state would fail on the NEXT turn, far from
  // the command that caused it.
  let s = reduce(initialState(), { type: "user", text: "before" });
  s = reduce(s, { type: "clear" });
  s = reduce(s, { type: "user", text: "after" });
  s = reduce(s, { type: "toolStart", toolId: "t9", name: "read_file", arg: "b.ts" });
  s = reduce(s, { type: "toolEnd", toolId: "t9", ok: true, summary: "read" });
  s = reduce(s, { type: "token", delta: "reply" });
  s = reduce(s, { type: "finishReply" });

  const texts = [...s.committed, ...s.tail].map((b) => ("text" in b ? b.text : ""));
  assert.ok(texts.some((t) => t.includes("after")), "the new turn did not render");
  assert.ok(!texts.some((t) => t.includes("before")), "a block from the cleared conversation came back");
  assert.equal(s.lastReply, "reply", "the reply after a clear was not recorded");
});

// ── The wait a vision call leaves behind ─────────────────────────────────────

test("a result that awaits the model starts a clock; an ordinary one does not", () => {
  let s = reduce(initialState(), { type: "user", text: "look at this" });
  s = reduce(s, { type: "toolStart", toolId: "t1", name: "Viewed", arg: "shot.png" });
  s = reduce(s, { type: "toolEnd", toolId: "t1", ok: true, detail: "800x600 · PNG · 40 KB", awaitsModel: true });
  const viewed = [...s.committed, ...s.tail].find((b) => b.kind === "tool");
  assert.equal(viewed?.kind === "tool" && typeof viewed.since, "number");

  let plain = reduce(initialState(), { type: "user", text: "read it" });
  plain = reduce(plain, { type: "toolStart", toolId: "t2", name: "Read", arg: "a.ts" });
  plain = reduce(plain, { type: "toolEnd", toolId: "t2", ok: true, summary: "40 lines" });
  const read = [...plain.committed, ...plain.tail].find((b) => b.kind === "tool");
  assert.equal(read?.kind === "tool" && read.since, undefined);
});

test("the clock stops when the model speaks", () => {
  let s = reduce(initialState(), { type: "user", text: "look" });
  s = reduce(s, { type: "toolStart", toolId: "t1", name: "Viewed", arg: "shot.png" });
  s = reduce(s, { type: "toolEnd", toolId: "t1", ok: true, detail: "800x600", awaitsModel: true });
  s = reduce(s, { type: "token", delta: "I can see" });

  const viewed = [...s.committed, ...s.tail].find((b) => b.kind === "tool");
  assert.equal(viewed?.kind === "tool" && typeof viewed.waited, "number");
});

test("the clock also stops on the next tool call, not just on speech", () => {
  // The model may act on what it saw instead of describing it. That is still the end
  // of the wait: measuring to the end of the turn would fold in everything after.
  let s = reduce(initialState(), { type: "user", text: "look" });
  s = reduce(s, { type: "toolStart", toolId: "t1", name: "Viewed", arg: "shot.png" });
  s = reduce(s, { type: "toolEnd", toolId: "t1", ok: true, detail: "800x600", awaitsModel: true });
  s = reduce(s, { type: "toolStart", toolId: "t2", name: "Update", arg: "a.css" });

  const viewed = [...s.committed, ...s.tail].find((b) => b.kind === "tool" && b.toolId === "t1");
  assert.equal(viewed?.kind === "tool" && typeof viewed.waited, "number");
});

test("a turn that ends without either still leaves no row counting", () => {
  let s = reduce(initialState(), { type: "user", text: "look" });
  s = reduce(s, { type: "toolStart", toolId: "t1", name: "Viewed", arg: "shot.png" });
  s = reduce(s, { type: "toolEnd", toolId: "t1", ok: true, detail: "800x600", awaitsModel: true });
  s = reduce(s, { type: "endTurn" });

  const viewed = [...s.committed, ...s.tail].find((b) => b.kind === "tool");
  assert.equal(viewed?.kind === "tool" && typeof viewed.waited, "number");
  assert.equal(viewed?.kind === "tool" && viewed.live, false);
});

test("a settled wait is never re-stamped by later events", () => {
  // The number belongs to one gap. A second token arriving must not restart or extend it.
  let s = reduce(initialState(), { type: "user", text: "look" });
  s = reduce(s, { type: "toolStart", toolId: "t1", name: "Viewed", arg: "shot.png" });
  s = reduce(s, { type: "toolEnd", toolId: "t1", ok: true, detail: "800x600", awaitsModel: true });
  s = reduce(s, { type: "token", delta: "a" });
  const first = [...s.committed, ...s.tail].find((b) => b.kind === "tool");
  const stamped = first?.kind === "tool" ? first.waited : undefined;
  s = reduce(s, { type: "token", delta: "b" });
  s = reduce(s, { type: "endTurn" });
  const later = [...s.committed, ...s.tail].find((b) => b.kind === "tool");
  assert.equal(later?.kind === "tool" && later.waited, stamped);
});

// ── a running command's output, shown before it finishes ─────────────────────

test("progress fills a running row's body", () => {
  let s = reduce(initialState(), { type: "user", text: "build it" });
  s = reduce(s, { type: "toolStart", toolId: "t1", name: "Run", arg: "cargo build", action: "run" });
  s = reduce(s, { type: "toolProgress", toolId: "t1", text: "Compiling serde v1.0" });
  const row = s.tail.find((b) => b.kind === "tool") as { detail?: string; detailKind?: string };
  assert.equal(row.detail, "Compiling serde v1.0");
  assert.equal(row.detailKind, "shell", "output must be rendered as shell output, not as a diff");
});

test("a later update REPLACES the earlier one", () => {
  // The tail is resent whole rather than as increments, so appending would show every
  // line twice and grow without bound over a long build.
  let s = reduce(initialState(), { type: "user", text: "build it" });
  s = reduce(s, { type: "toolStart", toolId: "t1", name: "Run", arg: "cargo build", action: "run" });
  s = reduce(s, { type: "toolProgress", toolId: "t1", text: "first" });
  s = reduce(s, { type: "toolProgress", toolId: "t1", text: "second" });
  const row = s.tail.find((b) => b.kind === "tool") as { detail?: string };
  assert.equal(row.detail, "second");
});

test("a finished row is never overwritten by a late tail", () => {
  // The last progress tick can arrive after the result — it is on a timer, the result is
  // not. Letting it land would replace the command's real output with a snapshot from
  // before it ended.
  //
  // The row is kept in the TAIL for this, by leaving an earlier call unfinished: a row
  // that has drained to committed is out of reach anyway, so a test that let it drain
  // would pass with the guard removed and prove nothing.
  let s = reduce(initialState(), { type: "user", text: "build it" });
  s = reduce(s, { type: "toolStart", toolId: "slow", name: "Run", arg: "server", action: "run" });
  s = reduce(s, { type: "toolStart", toolId: "t1", name: "Run", arg: "cargo build", action: "run" });
  s = reduce(s, { type: "toolEnd", toolId: "t1", ok: true, detail: "the real output", detailKind: "shell" });
  s = reduce(s, { type: "toolProgress", toolId: "t1", text: "a stale tail" });
  const row = s.tail.find((b) => b.kind === "tool" && b.toolId === "t1") as { detail?: string; done: boolean };
  assert.ok(row, "the finished row drained away, so the guard was never exercised");
  assert.equal(row.done, true);
  assert.equal(row.detail, "the real output");
});

test("progress for an unknown call changes nothing", () => {
  // A quiet failure drops its row entirely; a tick already in flight then names a block
  // that no longer exists.
  const s = reduce(initialState(), { type: "user", text: "hi" });
  assert.equal(reduce(s, { type: "toolProgress", toolId: "gone", text: "x" }), s);
});

test("progress never disturbs a grouped call", () => {
  // A group folds into one row ("Read 8 files") with nowhere to put output, and writing
  // to it would replace the group's own list.
  let s = reduce(initialState(), { type: "user", text: "look" });
  s = reduce(s, { type: "toolStart", toolId: "g1", name: "Read", arg: "a.ts", action: "read", group: true });
  const before = s;
  s = reduce(s, { type: "toolProgress", toolId: "g1", text: "should not land" });
  assert.equal(s, before);
});
