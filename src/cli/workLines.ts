/**
 * workLines.ts — what a work row says about the reads in it (pure).
 *
 * The row holds the commands the agent ran and the files it read. A command's line is its
 * command and how it ended; a read's line is the file and WHICH PART of it was read: the lines
 * 410–551, or the whole file. The words come from the result each read already leaves
 * ("read menu.ts lines 410-551", "read menu.ts (120 lines)"), so a chat saved before this
 * existed says the same thing.
 */
import type { WorkItem } from "./transcript.js";
import { MCP_CALL_NAME } from "./toolDisplay.js";

/** Whether this call read a file (or a symbol of one), rather than ran something. */
export function isRead(it: WorkItem): boolean {
  return it.kind === "read";
}

/** Whether this call was a step of a UI test: a look at the app, a click, something typed. */
export function isStep(it: WorkItem): boolean {
  return it.kind === "screenshot";
}

/** Whether this call was a tool an MCP server offers (not a change to a server's setup). */
export function isMcp(it: WorkItem): boolean {
  return it.kind === "mcp" && it.name === MCP_CALL_NAME;
}

/** Whether this call changed or checked an MCP server's setup (add, enable, reconnect...). */
export function isServerChange(it: WorkItem): boolean {
  return it.kind === "mcp" && it.name === "MCP";
}

/** The server a change was about: the arg is "enable rea", the server is "rea". */
export function serverOf(it: WorkItem): string {
  const arg = it.arg ?? "";
  const at = arg.indexOf(" ");
  return at < 0 ? arg : arg.slice(at + 1);
}

/** How many steps the calls in this row took: a batch is one call that carries several. */
export function stepCount(items: WorkItem[]): number {
  return items.filter(isStep).reduce((n, it) => n + Math.max(1, it.covers ?? 1), 0);
}

/** Which of the three kinds of work a call is. */
function workKind(it: WorkItem): "run" | "read" | "step" | "tool" | "setup" {
  return isRead(it) ? "read" : isStep(it) ? "step" : isMcp(it) ? "tool" : isServerChange(it) ? "setup" : "run";
}

/** The files one read call took, by name: a list call names each, any other names one. */
export function filesOf(it: WorkItem): string[] {
  if (!it.arg) return [];
  return (it.covers ?? 1) > 1 ? it.arg.split(/,\s*/).filter(Boolean) : [it.arg];
}

/** How many different files the reads in this row took. A file read twice is still one file. */
export function fileCount(items: WorkItem[]): number {
  const names = new Set<string>();
  for (const it of items) {
    if (!isRead(it)) continue;
    const files = filesOf(it);
    if (files.length === 0) names.add(it.toolId);
    for (const f of files) names.add(f);
  }
  return names.size;
}

/**
 * What the header says (pure): commands, files and test steps each with their own tense and count,
 * in the order they began.
 *
 * While some of a kind are still working and some are done, the count says so: "Running 1 of 3
 * commands", not "Running 3 commands" above a mark that shows two of them finished.
 */
export function workHeader(items: WorkItem[], live: boolean | undefined): { text: string; working: boolean } {
  const order: ("run" | "read" | "step" | "tool" | "setup")[] = [];
  for (const it of items) {
    const k = workKind(it);
    if (!order.includes(k)) order.push(k);
  }
  const parts = order.map((k, i) => {
    const mine = items.filter((it) => workKind(it) === k);
    const going = !live ? [] : mine.filter((it) => it.status === "running");
    // Server changes are counted by SERVER: enabling, removing and adding "rea" is one server
    // being worked on, not three of them.
    const size = (list: WorkItem[]) =>
      k === "read" ? fileCount(list) : k === "step" ? stepCount(list) : k === "setup" ? new Set(list.map(serverOf)).size : list.length;
    const n = size(mine);
    const nGoing = size(going);
    const noun =
      k === "read" ? (n === 1 ? "file" : "files") : k === "step" ? (n === 1 ? "step" : "steps") : k === "tool" ? (n === 1 ? "MCP tool" : "MCP tools") : k === "setup" ? (n === 1 ? "MCP server" : "MCP servers") : n === 1 ? "command" : "commands";
    const count = going.length > 0 && nGoing < n ? `${nGoing} of ${n}` : `${n}`;
    const verb =
      going.length > 0
        ? k === "read" ? "Reading" : k === "step" ? "Testing" : k === "tool" ? "Calling" : k === "setup" ? "Managing" : "Running"
        : k === "read" ? "Read" : k === "step" ? "Tested" : k === "tool" ? "Called" : k === "setup" ? "Managed" : "Ran";
    const text = `${verb} ${count} ${noun}`;
    return i === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
  });
  return { text: parts.join(", "), working: !!live && items.some((it) => it.status === "running") };
}

/** Which part of the file a read took, in words (pure). */
export function rangeText(it: WorkItem): string {
  const said = (it.note ?? it.summary ?? "").trim();
  if (it.status === "running") return "";
  if (it.status === "error") return `✗ ${said.replace(/^read\s+/i, "") || "failed"}`;
  if ((it.covers ?? 1) > 1) return "whole file";
  const lines = said.match(/lines ([\d,]+)\s*[-–]\s*([\d,]+)(?: of ([\d,]+))?/);
  if (lines) return `lines ${lines[1]}–${lines[2]}${lines[3] ? ` of ${lines[3]}` : ""}`;
  const symbol = said.match(/\((.+?):([\d,]+)-([\d,]+)\)\s*$/);
  if (symbol) return `lines ${symbol[2]}–${symbol[3]} of ${symbol[1]!.split(/[\\/]/).pop()}`;
  const whole = said.match(/\(([\d,]+) lines?\)/);
  if (whole) return `whole file · ${whole[1]} line${whole[1] === "1" ? "" : "s"}`;
  if (/\(empty\)/.test(said)) return "empty file";
  if (/\(unchanged\)/.test(said)) return "read before, unchanged";
  return said.replace(/^read\s+\S+\s*/i, "");
}

/** The lines a read contributes to the opened list: one per file, each with the part taken. */
export function readRows(it: WorkItem): { label: string; range: string }[] {
  const files = filesOf(it);
  const range = rangeText(it);
  if (files.length === 0) return [{ label: it.name.toLowerCase(), range }];
  return files.map((f) => ({ label: f, range }));
}

/** What a step is called on its line: "Click \"Add Game\"", "Look port 9222" (pure). */
export function stepLabel(it: WorkItem): string {
  return it.arg ? `${it.name} ${it.arg}` : it.name;
}

/** Why a step failed, in one line (pure): what the result said first. */
export function stepReason(it: WorkItem): string {
  const first = (it.summary ?? it.detail ?? "").split(String.fromCharCode(10)).map((l) => l.trim()).find(Boolean) ?? "";
  return first.replace(/^Error:\s*/, "");
}

/**
 * What an MCP call's line says at its right (pure): the mark, then how long it took when it
 * worked. A failure is the mark alone: the reason goes under the line in red (`mcpReason`),
 * because a verdict column too narrow for a sentence is what cut it to nothing before.
 */
export function mcpVerdict(it: WorkItem): string {
  if (it.status === "error") return "✗";
  const took = (it.summary ?? "").trim();
  return took ? `✓ ${took}` : "✓";
}

/**
 * A line with its indentation kept (pure). Wrapping a line to the band's width trims the
 * spaces it starts with, which flattened a JSON result into one column; a non-breaking space
 * is not trimmed and is drawn as a space.
 */
export function keepIndent(line: string): string {
  const lead = line.length - line.trimStart().length;
  return lead > 0 ? String.fromCharCode(160).repeat(lead) + line.slice(lead) : line;
}

/** A server change that was not carried out because the user said no. */
export function wasDeclined(it: WorkItem): boolean {
  return isServerChange(it) && it.status !== "error" && /^declined\b/i.test((it.summary ?? "").trim());
}

/**
 * What a server change's line says at its right (pure): the mark and what came of it
 * ("connected · 170 tools"). A refusal by the user is not a success and gets no tick.
 */
export function serverVerdict(it: WorkItem): string {
  const said = (it.summary ?? "").trim();
  if (wasDeclined(it)) return "declined";
  if (it.status === "error") return "\u2717";
  return said ? `\u2713 ${said}` : "\u2713";
}

/** Why a server change failed, in words (pure). Empty when it did not fail. */
export function serverReason(it: WorkItem): string {
  return isServerChange(it) && it.status === "error" ? (it.summary ?? "").trim() : "";
}

/**
 * One MCP line, as it is drawn (pure): a mark in front, the words after the name, and how to colour the mark.
 *
 * Every line of this kind has the SAME shape (mark, name, one line of words), so a list of
 * twenty reads down the left edge: the marks say what happened and the words say why. The
 * reason used to sit under its line in red, so a list of failures was a staircase of red
 * sentences wrapping into one another, and the rest of the row was green and white besides.
 * The words are dim and cut to the line; the whole of it is a click away.
 */
export function compactLine(it: WorkItem): { mark: string; tone: "ok" | "error" | "skipped" | "running"; text: string } {
  if (it.status === "running") return { mark: "", tone: "running", text: "" };
  const said = (it.summary ?? "").trim();
  if (wasDeclined(it)) return { mark: "\u00b7", tone: "skipped", text: "declined" };
  if (it.status === "error") return { mark: "\u2717", tone: "error", text: said };
  return { mark: "\u2713", tone: "ok", text: said };
}

/** Why an MCP call failed, in the server's own words (pure). Empty when it did not fail. */
export function mcpReason(it: WorkItem): string {
  return it.status === "error" ? (it.summary ?? "").trim() : "";
}

/** Splits a control kind from its names on a folded line. A control character real output never holds. */
export const FOLD_SEP = String.fromCharCode(31);

/** What a command printed, made safe to draw (pure): no carriage returns (they send the cursor back to the
 *  left edge and break the band), tabs as spaces, no other control characters. */
export function plainLine(line: string): string {
  const kept = line.split(String.fromCharCode(13)).join("").split(String.fromCharCode(9)).join("    ");
  return Array.from(kept).filter((c) => (c.charCodeAt(0) >= 32 || c.charCodeAt(0) === 27) && c.charCodeAt(0) !== 127).join("");
}

/** A control as the page list prints it: `[7] button "Grid view"`. */
const CONTROL = /^\s*\[\d+\]\s+(.+?)\s+("[^"]*".*)$/;

/**
 * A page's list of controls, folded by kind (pure): sixteen numbered lines become a line per kind,
 * `kind<TAB>name · name · name`. The numbers are for the model; a person reads what is there.
 * Lines that are not controls (the headings, what a step did) are left as they are.
 */
export function foldControls(lines: string[]): string[] {
  const groups = new Map<string, string[]>();
  const out: (string | { kind: string })[] = [];
  for (const line of lines) {
    const m = CONTROL.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const kind = m[1]!;
    if (!groups.has(kind)) {
      groups.set(kind, []);
      out.push({ kind });
    }
    groups.get(kind)!.push(m[2]!);
  }
  return out.map((o) => (typeof o === "string" ? o : `${o.kind}${FOLD_SEP}${groups.get(o.kind)!.join(" · ")}`));
}
