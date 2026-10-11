/**
 * agentLines.ts — what a sub-agent says about itself on screen (pure).
 *
 * A sub-agent used to be its task prompt pasted onto one line, then every call it made, then a
 * summary built for the lead agent. This turns that into what a person wants to know, in the order
 * they want it: a short title, how it ended, and, opened, the task, the result and what it did.
 * The list of calls is folded the way the commands row folds them: counts first, repeats merged.
 */
import { itemLabel } from "./toolItems.js";
import { visibleWidth, wrapAnsi } from "./wrap.js";
import type { AgentEntry, ToolGroupItem } from "./transcript.js";

/**
 * A short title from the task the agent was given (pure). The task is a prompt written for a model
 * ("You are re-verifying a FIXED bug in Notes App, an Electron app at C:\\Projects\\...") and is
 * never a title, so this keeps the first idea in it: the opening words dropped, the first sentence
 * or clause kept, a path left off, and the cut made at a word, never in the middle of one.
 */
export function agentTitle(task: string, max: number): string {
  let t = task.replace(/\s+/g, " ").trim();
  t = t.replace(/^(?:you are|you're|your task is to|your job is to|task:|please)\s+/i, "");
  const end = t.search(/[.!?](?:\s|$)|:\s| — | - /);
  if (end >= 12) t = t.slice(0, end);
  const comma = t.indexOf(", ");
  if (comma >= 20) t = t.slice(0, comma);
  t = t.replace(/\s+(?:at|in|under|inside)\s+(?:[A-Za-z]:\\|\/|~)\S*.*$/i, "");
  t = t.replace(/[\s,;:.-]+$/, "");
  if (t === "") return "";
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length <= max) return t;
  const room = Math.max(1, max - 1);
  const space = t.lastIndexOf(" ", room);
  return `${t.slice(0, space >= Math.floor(room / 2) ? space : room).replace(/[\s,;:.-]+$/, "")}…`;
}

/** A span of time, whole seconds under a minute and `2m 10s` past it (pure). */
export function humanSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** One line of what it did: the same call said again is one line with a count. */
export interface DidRow {
  label: string;
  count: number;
  error: boolean;
}

/**
 * Everything a worker did as lines, repeats merged wherever they happen (pure).
 * A poll that came back six times, with other calls between, is `Shell #4 (running)  ×6`, not six
 * lines. First appearance sets the order, so the list still reads as what happened.
 */
export function didRows(items: ToolGroupItem[]): DidRow[] {
  const rows: DidRow[] = [];
  const byLabel = new Map<string, DidRow>();
  for (const it of items) {
    // A look at the shell list ("1 running, 4 total") is bookkeeping, not something it did to the project.
    const label = it.name === "Shell" && !it.arg ? "Checked the shells" : itemLabel(it);
    const at = byLabel.get(label);
    if (at) {
      at.count += 1;
      if (it.status === "error") at.error = true;
    } else {
      const row = { label, count: 1, error: it.status === "error" };
      byLabel.set(label, row);
      rows.push(row);
    }
  }
  return rows;
}

/** The kinds of call, for the count: reading, searching, running, changing, and the rest. */
type Kind = "read" | "search" | "run" | "change" | "other";
function kindOf(it: ToolGroupItem): Kind {
  switch (it.kind) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "run":
      return "run";
    case "edit":
    case "write":
      return "change";
    default:
      return "other";
  }
}

/**
 * What it did, counted: "Read 6 files, ran 4 commands" (pure). Each kind has its own tense and its
 * own noun, in the order they began, and a call that failed or was refused is said at the end.
 */
export function didText(items: ToolGroupItem[], live: boolean): string {
  if (items.length === 0) return live ? "Starting" : "Nothing";
  const order: Kind[] = [];
  for (const it of items) {
    const k = kindOf(it);
    if (!order.includes(k)) order.push(k);
  }
  const parts = order.map((k, i) => {
    const mine = items.filter((it) => kindOf(it) === k);
    const going = live && mine.some((it) => it.status === "running");
    const n = k === "read" ? mine.reduce((sum, it) => sum + Math.max(1, it.covers ?? 1), 0) : mine.length;
    let text: string;
    switch (k) {
      case "read":
        text = `${going ? "Reading" : "Read"} ${n} file${n === 1 ? "" : "s"}`;
        break;
      case "search":
        text = `${going ? "Searching" : "Searched"} ${n === 1 ? "once" : `${n} times`}`;
        break;
      case "run":
        text = `${going ? "Running" : "Ran"} ${n} command${n === 1 ? "" : "s"}`;
        break;
      case "change":
        text = `${going ? "Changing" : "Changed"} ${n} file${n === 1 ? "" : "s"}`;
        break;
      default:
        text = `${n} other call${n === 1 ? "" : "s"}`;
    }
    return i === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
  });
  const failed = items.filter((it) => it.status === "error").length;
  return failed > 0 ? `${parts.join(", ")}, ${failed} failed` : parts.join(", ");
}

/** What it is doing right now, in the present tense: "reading use-debounced.ts" (pure). */
export function nowText(items: ToolGroupItem[]): string {
  const going = [...items].reverse().find((it) => it.status === "running");
  if (!going) return "";
  const text = itemLabel(going);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The tone a front end colours an outcome with: green, red, amber, or none. */
export type Tone = "good" | "bad" | "warn" | undefined;

export function toneOf(agent: AgentEntry): Tone {
  if (agent.verdict === "pass") return "good";
  if (agent.verdict === "fail" || agent.status === "error") return "bad";
  if (agent.verdict === "partial" || agent.verdict === "unknown") return "warn";
  return undefined;
}

/** The mark before the outcome: a tick, a cross, or a bang for "not sure". */
export function markOf(tone: Tone): string {
  return tone === "good" ? "✓" : tone === "bad" ? "✗" : tone === "warn" ? "!" : "·";
}

/** What opens under a worker: a label, the words, and a tone for the words. */
export interface BodyRow {
  label: string;
  text: string;
  tone?: Tone;
}

/** How many lines of what it did are shown opened before the rest is counted. */
export const MAX_DID_ROWS = 12;

/**
 * The opened view (pure): the task, how it ended, what it did in a count, then each thing it did.
 * The task is cut to three lines of `width` and ends in an ellipsis when there is more.
 */
export function bodyRows(agent: AgentEntry, live: boolean, width: number): BodyRow[] {
  const rows: BodyRow[] = [];
  const task = (agent.full ?? agent.task).replace(/\s+/g, " ").trim();
  if (task) rows.push({ label: "Task", text: cutLines(task, width, 3) });
  if (!live && agent.headline) rows.push({ label: "Result", text: `${markOf(toneOf(agent))} ${agent.headline}`, tone: toneOf(agent) });
  else if (!live && agent.summary) rows.push({ label: "Result", text: agent.summary, tone: toneOf(agent) });
  rows.push({ label: "Did", text: didText(agent.items, live) });
  const list = didRows(agent.items);
  const shown = list.slice(0, MAX_DID_ROWS);
  for (const r of shown) rows.push({ label: "", text: r.count > 1 ? `${r.label}  ×${r.count}` : r.label, tone: r.error ? "bad" : undefined });
  if (list.length > shown.length) rows.push({ label: "", text: `… and ${list.length - shown.length} more` });
  return rows;
}

/** A text kept to `lines` rows of `width` columns, with an ellipsis where it was cut (pure). */
function cutLines(text: string, width: number, lines: number): string {
  const room = Math.max(8, width) * lines;
  if (text.length <= room) return text;
  const cut = text.lastIndexOf(" ", room - 1);
  return `${text.slice(0, cut > room / 2 ? cut : room - 1).replace(/[\s,;:.-]+$/, "")}…`;
}

/** One row of the shaded band, as drawn: the label column, the words, and the spaces that fill it. */
export interface BandRow {
  label: string;
  text: string;
  tone: Tone;
  pad: number;
}

/** The width of the label column ("Result") and what is left of a line for the words. */
export const LABEL_WIDTH = 8;
export function bandText(columns: number): number {
  return Math.max(8, columns - 14);
}

/**
 * The opened rows as lines of exact width (pure): every line wraps to the room beside the label
 * column, a wrapped line hangs under its words, and each is padded so the band is a clean block.
 */
export function bandRows(rows: BodyRow[], columns: number): BandRow[] {
  const room = bandText(columns);
  const out: BandRow[] = [];
  for (const r of rows) {
    const parts = wrapAnsi(r.text === "" ? " " : r.text, room);
    parts.forEach((part, i) => out.push({ label: i === 0 ? r.label : "", text: part, tone: r.tone, pad: Math.max(0, room - visibleWidth(part)) }));
  }
  return out;
}
