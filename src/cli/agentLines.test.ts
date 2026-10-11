/**
 * agentLines.test.ts — what a sub-agent says about itself: its title, how it ended, what it did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTitle, bandRows, bodyRows, didRows, didText, humanSpan, markOf, nowText, toneOf, MAX_DID_ROWS } from "./agentLines.js";
import { initialState, reduce, type Action, type AgentEntry, type Block, type ToolGroupItem } from "./transcript.js";

const item = (name: string, arg: string | undefined, kind: ToolGroupItem["kind"], status: ToolGroupItem["status"] = "ok", note?: string, covers?: number): ToolGroupItem => ({
  toolId: `${name}${arg}${Math.random()}`,
  name,
  ...(arg ? { arg } : {}),
  kind,
  status,
  ...(note ? { note } : {}),
  ...(covers ? { covers } : {}),
});

const agent = (over: Partial<AgentEntry> = {}): AgentEntry => ({ agentId: "a", task: "t", readOnly: true, status: "ok", items: [], ...over });

test("a task written for a model becomes a short title, cut at a word", () => {
  const task = "You are re-verifying a FIXED bug in Notes App, an Electron + React + TypeScript app at C:\\Projects\\Ma";
  assert.equal(agentTitle(task, 80), "Re-verifying a FIXED bug in Notes App");
  assert.equal(agentTitle("Find every authFetch call site in the app. Report file and line.", 80), "Find every authFetch call site in the app");
  assert.equal(agentTitle("Review the close guard: does it ever strand the window?", 80), "Review the close guard");
  assert.equal(agentTitle("Draft unit tests for runCommand.ts", 80), "Draft unit tests for runCommand.ts");
  // Too long for the room: cut at a word, with an ellipsis, never in the middle of one.
  const cut = agentTitle("Summarise how the session notes are refreshed during a long run of tool calls", 30);
  assert.ok(cut.endsWith("…") && cut.length <= 30, cut);
  assert.ok(!/\s…$/.test(cut) && "Summarise how the session notes are refreshed".startsWith(cut.slice(0, -1)), cut);
  assert.equal(agentTitle("   ", 30), "");
});

test("time taken reads at a glance", () => {
  assert.equal(humanSpan(4000), "4s");
  assert.equal(humanSpan(60000), "1m");
  assert.equal(humanSpan(130000), "2m 10s");
});

test("what it did is counted by kind, in the order it began, with what failed said last", () => {
  const items = [
    item("Read", "a.ts", "read"),
    item("Run", "npm test", "run"),
    item("Read", "b.ts", "read"),
    item("Run", "ls", "run", "error"),
  ];
  assert.equal(didText(items, false), "Read 2 files, ran 2 commands, 1 failed");
  assert.equal(didText([...items, item("Read", "c.ts", "read", "running")], true), "Reading 3 files, ran 2 commands, 1 failed");
  assert.equal(didText([item("Read", "files", "read", "ok", undefined, 4)], false), "Read 4 files", "one call can take several files");
  assert.equal(didText([item("Search", "x", "search")], false), "Searched once");
  assert.equal(didText([], true), "Starting");
});

test("a call that came back again, with others between, is one line with a count", () => {
  const items = [
    item("Shell", "#4", "run", "ok", "shell #4 (running)"),
    item("Read", "a.ts", "read", "ok", "read a.ts (10 lines)"),
    item("Shell", "#4", "run", "ok", "shell #4 (running)"),
    item("Shell", "#4", "run", "ok", "shell #4 (running)"),
    item("Blocked", undefined, "meta", "error", "Blocked (read-only sub-agent)"),
  ];
  const rows = didRows(items);
  assert.deepEqual(rows.map((r) => [r.label, r.count, r.error]), [
    ["Shell #4 (running)", 3, false],
    ["Read a.ts (10 lines)", 1, false],
    ["Blocked (read-only sub-agent)", 1, true],
  ]);
});

test("a look at the shell list is not something it did to the project", () => {
  const rows = didRows([item("Shell", undefined, "run", "ok", "1 running, 4 total"), item("Shell", undefined, "run", "ok", "0 running, 4 total")]);
  assert.deepEqual(rows.map((r) => [r.label, r.count]), [["Checked the shells", 2]]);
});

test("where it is right now is the call still running", () => {
  assert.equal(nowText([item("Read", "a.ts", "read"), item("Read", "use-debounced.ts", "read", "running")]), "reading use-debounced.ts");
  assert.equal(nowText([item("Read", "a.ts", "read")]), "");
});

test("how it ended is a tone: good, bad, or not sure, and a mark to go with it", () => {
  assert.equal(toneOf(agent({ verdict: "pass" })), "good");
  assert.equal(toneOf(agent({ verdict: "fail" })), "bad");
  assert.equal(toneOf(agent({ status: "error" })), "bad");
  assert.equal(toneOf(agent({ verdict: "partial" })), "warn");
  assert.equal(toneOf(agent({ verdict: "unknown" })), "warn");
  assert.equal(toneOf(agent()), undefined);
  assert.deepEqual(["good", "bad", "warn", undefined].map((t) => markOf(t as never)), ["✓", "✗", "!", "·"]);
});

test("opened, it shows the task, how it ended, a count and each thing it did", () => {
  const a = agent({
    task: "short label",
    full: "Check that no timeout remains in the close guard and that every handler branch replies.",
    headline: "Could not fully verify · 8 checks",
    verdict: "partial",
    items: [item("Read", "a.ts", "read", "ok", "read a.ts (10 lines)"), item("Blocked", undefined, "meta", "error", "Blocked (read-only sub-agent)")],
  });
  const rows = bodyRows(a, false, 80);
  assert.deepEqual(rows.map((r) => r.label), ["Task", "Result", "Did", "", ""]);
  assert.match(rows[0]!.text, /^Check that no timeout remains/, "the task is the full one, not the short label");
  assert.equal(rows[1]!.text, "! Could not fully verify · 8 checks");
  assert.equal(rows[1]!.tone, "warn");
  assert.equal(rows[4]!.tone, "bad", "a refused call is red");
});

test("while it works there is no result yet, and a long list is counted past the cap", () => {
  const many = Array.from({ length: MAX_DID_ROWS + 5 }, (_, i) => item("Read", `f${i}.ts`, "read", "ok", `read f${i}.ts (1 line)`));
  const rows = bodyRows(agent({ status: "running", items: many }), true, 80);
  assert.ok(!rows.some((r) => r.label === "Result"));
  assert.equal(rows.filter((r) => r.label === "").length, MAX_DID_ROWS + 1);
  assert.equal(rows[rows.length - 1]!.text, "… and 5 more");
});

test("a long task is kept to three lines, ending in an ellipsis", () => {
  const rows = bodyRows(agent({ full: "word ".repeat(200) }), false, 40);
  assert.ok(rows[0]!.text.length <= 120 && rows[0]!.text.endsWith("…"), rows[0]!.text);
});

test("the band is lines of one width, so it draws as a clean block", () => {
  const rows = bodyRows(agent({ full: "word ".repeat(40), headline: "Done", verdict: "pass", items: [item("Read", "a.ts", "read")] }), false, 60);
  const lines = bandRows(rows, 74);
  assert.ok(lines.length > rows.length, "a long line wraps");
  assert.equal(new Set(lines.map((l) => l.text.length + l.pad)).size, 1);
  assert.deepEqual(lines.filter((l) => l.label !== "").map((l) => l.label), ["Task", "Result", "Did"], "a wrapped line has its label once");
});

// ── the transcript: dispatch, time, outcome, and the click ───────────────────────────────────────

const run = (actions: Action[]) => actions.reduce(reduce, initialState());
const blocks = (s: ReturnType<typeof run>): Block[] => [...s.committed, ...s.tail];

test("a worker keeps its full task, when it started, how it ended and how long it took", () => {
  const s = run([
    { type: "subagentStart", agentId: "a", task: "short", readOnly: true, full: "the whole task" },
    { type: "subagentEnd", agentId: "a", ok: true, summary: "3 steps", headline: "Done", verdict: "pass", steps: 3 },
  ]);
  const b = blocks(s)[0]!;
  assert.ok(b.kind === "subagent");
  const ag = b.kind === "subagent" ? b.agents[0]! : undefined;
  assert.equal(ag?.full, "the whole task");
  assert.equal(ag?.headline, "Done");
  assert.equal(ag?.verdict, "pass");
  assert.equal(ag?.steps, 3);
  assert.ok(ag?.startedAt !== undefined && ag.endedAt !== undefined && ag.endedAt >= ag.startedAt);
});

test("a click opens one worker, and the keyboard opens or folds them all", () => {
  let s = run([
    { type: "subagentStart", agentId: "a", task: "one", readOnly: true },
    { type: "subagentStart", agentId: "b", task: "two", readOnly: true },
  ]);
  const id = blocks(s)[0]!.id;
  s = reduce(s, { type: "toggleItem", id, index: 1 });
  let ags = (blocks(s)[0] as Extract<Block, { kind: "subagent" }>).agents;
  assert.deepEqual(ags.map((x) => !!x.open), [false, true]);
  s = reduce(s, { type: "toggleExpand", id });
  ags = (blocks(s)[0] as Extract<Block, { kind: "subagent" }>).agents;
  assert.deepEqual(ags.map((x) => !!x.open), [false, false], "with one open, the keyboard folds");
  s = reduce(s, { type: "toggleExpand", id });
  ags = (blocks(s)[0] as Extract<Block, { kind: "subagent" }>).agents;
  assert.deepEqual(ags.map((x) => !!x.open), [true, true], "with none open, it opens them all");
});

test("a worker's old calls open after it has finished and scrolled into the past", () => {
  let s = run([
    { type: "subagentStart", agentId: "a", task: "one", readOnly: true },
    { type: "subagentEnd", agentId: "a", ok: true, summary: "0 steps" },
  ]);
  assert.equal(s.tail.length, 0, "finished work is committed");
  const id = s.committed[0]!.id;
  s = reduce(s, { type: "toggleItem", id, index: 0 });
  assert.equal((s.committed[0] as Extract<Block, { kind: "subagent" }>).agents[0]!.open, true);
});
