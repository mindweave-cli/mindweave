/**
 * agentView.ts — switching the chat between the main agent and the sub-agents it started (pure).
 *
 * A sub-agent's own words are never sent to the screen, only its calls and its report, so the view of one is what it was
 * asked, what it has done so far (each call, in order, with its result) and how it ended. The tabs are the sub-agents of
 * the CURRENT turn: everything started since the last message the person sent.
 */
import { agentTitle, humanSpan, toneOf, type Tone } from "./agentLines.js";
import { initialState, reduce, type AgentEntry, type Block, type TranscriptState } from "./transcript.js";

/** The sub-agents started since the last message the person sent, in the order they started. */
export function turnAgents(blocks: Block[]): AgentEntry[] {
  let from = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]!.kind === "user") {
      from = i + 1;
      break;
    }
  }
  const out: AgentEntry[] = [];
  for (let i = from; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "subagent") out.push(...b.agents);
  }
  return out;
}

/**
 * The view after one step along the tabs: null is the main agent, then each sub-agent. Wraps at both ends, and falls back to
 * the main agent when the one being viewed is no longer in the list (a new message was sent).
 */
export function cycleView(current: string | null, agents: AgentEntry[], dir: 1 | -1): string | null {
  if (agents.length === 0) return null;
  const at = current === null ? -1 : agents.findIndex((a) => a.agentId === current);
  const slots = agents.length + 1; // main + each
  const next = (((at + 1 + dir) % slots) + slots) % slots; // slot 0 is the main agent
  return next === 0 ? null : agents[next - 1]!.agentId;
}

/** The short name a tab carries: its place and what it was asked ("#2 Check the login flow"). */
export function tabLabel(agent: AgentEntry, index: number, max = 22): string {
  const title = agentTitle(agent.task, max);
  return title ? `#${index + 1} ${title}` : `#${index + 1}`;
}

/** The mark in front of a tab: a dot while it works, then how it ended. */
export function tabMark(agent: AgentEntry): { mark: string; tone: Tone | "running" } {
  if (agent.status === "running") return { mark: "●", tone: "running" };
  const tone = toneOf(agent);
  return { mark: tone === "bad" ? "✗" : tone === "warn" ? "!" : "✓", tone };
}

/**
 * The sub-agent as the conversation the chat draws (pure): what it was asked as a message, each call it made as the same rows
 * the main chat uses (grouped reads and commands, a running one pulsing), a line saying where it stands, and, once it has
 * finished, its report as the reply. Built by the transcript's own reducer, so it looks exactly like the main chat.
 */
export function agentTranscript(agent: AgentEntry, now: number): Block[] {
  let s: TranscriptState = initialState();
  const task = (agent.full ?? agent.task).replace(/\s+/g, " ").trim();
  s = reduce(s, { type: "user", text: task || agent.task });
  // What the person wrote to it sits where it was written: before the call it had reached.
  const said = agent.said ?? [];
  const saySoFar = (upto: number) => {
    for (const m of said) if (m.at === upto) s = reduce(s, { type: "user", text: m.text });
  };
  agent.items.forEach((it, i) => {
    saySoFar(i);
    const id = `${agent.agentId}:${it.toolId || i}`;
    s = reduce(s, {
      type: "toolStart",
      toolId: id,
      name: it.name,
      ...(it.arg !== undefined ? { arg: it.arg } : {}),
      ...(it.kind ? { action: it.kind } : {}),
      group: it.kind !== "edit" && it.kind !== "write",
    });
    if (it.status !== "running") s = reduce(s, { type: "toolEnd", toolId: id, ok: it.status === "ok", ...(it.note ? { summary: it.note } : {}) });
  });
  for (const m of said) if (m.at >= agent.items.length) s = reduce(s, { type: "user", text: m.text });
  const steps = agent.steps ?? agent.items.length;
  const took = agent.startedAt === undefined ? "" : humanSpan((agent.endedAt ?? now) - agent.startedAt);
  const state = agent.status === "running" ? "working" : agent.headline ?? agent.summary ?? "finished";
  s = reduce(s, { type: "note", text: `${agent.readOnly ? "read-only · " : ""}${steps} step${steps === 1 ? "" : "s"}${took ? ` · ${took}` : ""} · ${state}` });
  const report = (agent.summary ?? "").trim();
  if (agent.status !== "running" && report) {
    s = reduce(s, { type: "token", delta: report });
    s = reduce(s, { type: "finishReply" });
    s = reduce(s, { type: "endTurn" });
  }
  return [...s.committed, ...s.tail];
}
