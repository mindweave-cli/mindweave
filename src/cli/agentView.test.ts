/**
 * agentView.test.ts — the tabs between the main agent and its sub-agents, and what a sub-agent's screen says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTranscript, cycleView, tabLabel, tabMark, turnAgents } from "./agentView.js";
import type { AgentEntry, Block } from "./transcript.js";

const agent = (id: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({ agentId: id, task: `You are checking the ${id} part of the app.`, readOnly: true, status: "running", items: [], startedAt: 1_000, ...extra });
const sub = (id: number, agents: AgentEntry[]): Block => ({ kind: "subagent", id, done: false, agents });
const user = (id: number): Block => ({ kind: "user", id, done: true, text: "go" });

test("the tabs are the sub-agents started since the last message, in order", () => {
  const blocks: Block[] = [user(1), sub(2, [agent("old")]), user(3), sub(4, [agent("a"), agent("b")]), sub(5, [agent("c")])];
  assert.deepEqual(turnAgents(blocks).map((a) => a.agentId), ["a", "b", "c"]);
  assert.deepEqual(turnAgents([user(1)]), []);
  assert.deepEqual(turnAgents([]), []);
});

test("cycling goes main, each sub-agent, and round again, both ways", () => {
  const list = [agent("a"), agent("b")];
  assert.equal(cycleView(null, list, 1), "a");
  assert.equal(cycleView("a", list, 1), "b");
  assert.equal(cycleView("b", list, 1), null);
  assert.equal(cycleView(null, list, -1), "b");
  assert.equal(cycleView("a", list, -1), null);
  assert.equal(cycleView(null, [], 1), null, "nothing to switch to");
  assert.equal(cycleView("gone", list, 1), "a", "a view whose agent is no longer there counts as main");
});

test("a tab carries its place and a short title, and a mark for how it is going", () => {
  assert.match(tabLabel(agent("login"), 1), /^#2 /);
  assert.equal(tabMark(agent("a")).mark, "●");
  assert.equal(tabMark(agent("a", { status: "ok", verdict: "pass" })).mark, "✓");
  assert.equal(tabMark(agent("a", { status: "error" })).mark, "✗");
  assert.equal(tabMark(agent("a", { status: "ok", verdict: "partial" })).mark, "!");
});

const kinds = (blocks: ReturnType<typeof agentTranscript>) => blocks.map((b) => b.kind);

test("the sub-agent's screen is a conversation: what it was asked, then its calls as the chat's own rows", () => {
  const a = agent("login", {
    items: [
      { toolId: "1", name: "Read", arg: "auth.ts", kind: "read", status: "ok", note: "read auth.ts (120 lines)" },
      { toolId: "2", name: "Grep", arg: "token", kind: "search", status: "running" },
    ],
  });
  const blocks = agentTranscript(a, 5_000);
  assert.equal(blocks[0]!.kind, "user");
  assert.match((blocks[0] as { text: string }).text, /checking the login part/);
  assert.ok(kinds(blocks).length >= 3, "the task, its calls and where it stands");
  assert.ok(blocks.some((b) => b.kind === "note" && /read-only · 2 steps · 4s · working/.test((b as { text: string }).text)));
  assert.ok(!blocks.some((b) => b.kind === "assistant"), "no report while it is still working");
});

test("a finished sub-agent ends with its report as the reply", () => {
  const a = agent("x", { status: "ok", verdict: "pass", headline: "All checks passed", summary: "Everything held.", endedAt: 3_000, steps: 3, items: [{ toolId: "1", name: "Read", kind: "read", status: "ok" }] });
  const blocks = agentTranscript(a, 9_000);
  const last = blocks[blocks.length - 1]!;
  assert.equal(last.kind, "assistant");
  assert.match((last as { text: string }).text, /Everything held\./);
  assert.ok(blocks.some((b) => b.kind === "note" && /3 steps · 2s · All checks passed/.test((b as { text: string }).text)));
});

test("a sub-agent with no calls yet is still a conversation, not an empty screen", () => {
  const blocks = agentTranscript(agent("fresh"), 2_000);
  assert.ok(blocks.length >= 2);
  assert.equal(blocks[0]!.kind, "user");
});

test("what the person wrote to a worker sits in its conversation where it was written", () => {
  const a = agent("login", {
    items: [
      { toolId: "1", name: "Read", arg: "a.ts", kind: "read", status: "ok", note: "read a.ts" },
      { toolId: "2", name: "Read", arg: "b.ts", kind: "read", status: "ok", note: "read b.ts" },
    ],
    said: [
      { at: 1, text: "look at the footer too" },
      { at: 2, text: "and the header" },
    ],
  });
  const blocks = agentTranscript(a, 5_000);
  const users = blocks.filter((b) => b.kind === "user").map((b) => (b as { text: string }).text);
  assert.equal(users.length, 3, "the task and the two messages");
  assert.match(users[1]!, /footer/);
  assert.match(users[2]!, /header/);
  const order = blocks.map((b) => (b.kind === "user" ? `user:${(b as { text: string }).text.slice(0, 6)}` : b.kind));
  assert.ok(order.indexOf("user:look a") > 1, "after the first call, not before it");
});
