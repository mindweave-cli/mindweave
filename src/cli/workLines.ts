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

/** Whether this call read a file (or a symbol of one), rather than ran something. */
export function isRead(it: WorkItem): boolean {
  return it.kind === "read";
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
 * What the header says (pure): commands and files each with their own tense and count, in the
 * order they began.
 *
 * While some of a kind are still working and some are done, the count says so: "Running 1 of 3
 * commands", not "Running 3 commands" above a mark that shows two of them finished.
 */
export function workHeader(items: WorkItem[], live: boolean | undefined): { text: string; working: boolean } {
  const order: ("run" | "read")[] = [];
  for (const it of items) {
    const k = isRead(it) ? "read" : "run";
    if (!order.includes(k)) order.push(k);
  }
  const parts = order.map((k, i) => {
    const mine = items.filter((it) => (k === "read") === isRead(it));
    const going = !live ? [] : mine.filter((it) => it.status === "running");
    const n = k === "read" ? fileCount(mine) : mine.length;
    const nGoing = k === "read" ? fileCount(going) : going.length;
    const noun = k === "read" ? (n === 1 ? "file" : "files") : n === 1 ? "command" : "commands";
    const count = going.length > 0 && nGoing < n ? `${nGoing} of ${n}` : `${n}`;
    const verb = going.length > 0 ? (k === "read" ? "Reading" : "Running") : k === "read" ? "Read" : "Ran";
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
