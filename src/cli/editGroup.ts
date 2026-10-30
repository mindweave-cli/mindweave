/**
 * editGroup.ts — what a row of several edits says (pure).
 *
 * Edits that follow each other, with nothing between them but more edits, are ONE row from the third on:
 *
 *   ● Wrote 7 files  +492  tsconfig.main.json, tsconfig.json, vite.config.ts, …  ▸
 *
 * Only writing and editing files joins it. A command, a read, a search or a sentence from the agent ends it, so what
 * the row says is always only about changes to files. One or two edits are not grouped: they stay the rows they were.
 */
import type { WorkItem } from "./transcript.js";

/**
 * The fewest edits that make one row. There is none: every edit is its own row, however many follow each other, so the single
 * "Edited 3 files ▸" row is never drawn. The grouped layout below stays for a time it is wanted again; raising this to a number
 * brings it back.
 */
export const GROUP_FROM = Number.POSITIVE_INFINITY;

/** Whether this block's items are drawn as one row (and not as the separate rows of one or two edits). */
export const isGrouped = (items: readonly unknown[]): boolean => items.length >= GROUP_FROM;

const WORDS: Record<string, [string, string]> = { Update: ["Editing", "Edited"], Write: ["Writing", "Wrote"] };
const word = (name: string, going: boolean): string => (WORDS[name] ?? ["Changing", "Changed"])[going ? 0 : 1];

/** The file's own name: the end of its path. */
export function baseName(path: string | undefined): string {
  const parts = String(path ?? "").split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : String(path ?? "");
}

/** Lines added and removed by one edit, from the text it left behind (pure). */
export function editStats(it: WorkItem): { add: number; del: number } {
  const text = it.full ?? it.detail ?? "";
  if (!text) return { add: 0, del: 0 };
  const lines = text.split("\n");
  const label = /^[+\- ]/.test(lines[0] ?? "") ? "" : (lines[0] ?? "");
  const counted = /[−-](\d+)\s*\+(\d+)|\+(\d+)\s*[−-](\d+)/.exec(label);
  if (counted) return { del: Number(counted[1] ?? counted[4]), add: Number(counted[2] ?? counted[3]) };
  const whole = /(?:new|whole) file · (\d+) lines?/.exec(label);
  if (whole) return { add: Number(whole[1]), del: 0 };
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (/^\+(?!\+\+)/.test(l)) add++;
    else if (/^-(?!--)/.test(l)) del++;
  }
  return { add, del };
}

/** Totals over the whole row. */
export function editTotals(items: readonly WorkItem[]): { add: number; del: number; failed: number } {
  let add = 0;
  let del = 0;
  let failed = 0;
  for (const it of items) {
    const s = editStats(it);
    add += s.add;
    del += s.del;
    if (it.status === "error") failed++;
  }
  return { add, del, failed };
}

/** The files in the row, each once, in the order they were first changed; `index` is the first edit of it. */
export function editFiles(items: readonly WorkItem[]): { path: string; name: string; index: number }[] {
  const seen = new Map<string, { path: string; name: string; index: number }>();
  items.forEach((it, index) => {
    const path = it.arg ?? it.name;
    if (!seen.has(path)) seen.set(path, { path, name: baseName(path), index });
  });
  return [...seen.values()];
}

/** The words at the start of the row: "Wrote 7 files", "Edited 3 files · 5 edits", "Wrote 2, edited 5 files". */
export function editsHead(items: readonly WorkItem[], live: boolean | undefined): string {
  const going = !!live && items.some((it) => it.status === "running");
  const order: string[] = [];
  for (const it of items) if (!order.includes(it.name)) order.push(it.name);
  if (order.length === 1) {
    const files = editFiles(items).length;
    return `${word(order[0]!, going)} ${files} files${items.length > files ? ` · ${items.length} edits` : ""}`;
  }
  // Still going, with both kinds in it: one word for all of it until it settles.
  if (going) return `Changing ${editFiles(items).length} files`;
  const parts = order.map((n, i) => {
    const w = word(n, going);
    return `${i === 0 ? w : w.toLowerCase()} ${items.filter((it) => it.name === n).length}`;
  });
  return `${parts.join(", ")} files`;
}

export interface NameSpan {
  label: string;
  /** The edit it opens. */
  index: number;
  /** The columns it covers: from `start`, up to but not including `end`. */
  start: number;
  end: number;
}

/** Columns kept free at the right of the header for the arrow. */
const ARROW_ROOM = 4;
/** What stands for the names that do not fit. A click on it, like one anywhere else on the row, opens the list. */
const CUT = "…";

/**
 * Where everything sits in the closed header (pure), so the row is drawn from it and a click is found in it:
 * `● ` then the words, two spaces, the lines added and removed, two spaces, the names. As many names as fit,
 * the rest counted. The same numbers draw the row and answer the click, so they cannot disagree.
 */
export function headerLayout(items: readonly WorkItem[], columns: number, live: boolean | undefined) {
  const head = editsHead(items, live);
  const t = editTotals(items);
  const failed = t.failed > 0 ? `${t.failed} failed` : "";
  const stat = [failed, t.add ? `+${t.add}` : "", t.del ? `−${t.del}` : ""].filter(Boolean).join(" ");
  let col = 2 + head.length;
  if (stat) col += 2 + stat.length;
  col += 2;
  const files = editFiles(items);
  const limit = columns - ARROW_ROOM;
  const names: NameSpan[] = [];
  let more = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const lead = names.length === 0 ? 0 : 2;
    const left = files.length - i - 1;
    const tail = left > 0 ? `, ${CUT}`.length : 0;
    if (col + lead + f.name.length + tail > limit && names.length > 0) break;
    const start = col + lead;
    const room = Math.max(4, limit - start - tail);
    const label = f.name.length > room ? `${f.name.slice(0, Math.max(1, room - 1))}…` : f.name;
    names.push({ label, index: f.index, start, end: start + label.length });
    col = start + label.length;
  }
  more = files.length - names.length;
  return { head, stat, add: t.add, del: t.del, failed: t.failed, names, more, cut: CUT };
}

/** The edit a click at column `x` on the closed header opens, or -1 when it landed on the row itself. */
export function nameAt(items: readonly WorkItem[], columns: number, x: number, live?: boolean): number {
  const hit = headerLayout(items, columns, live).names.find((n) => x >= n.start && x < n.end);
  return hit ? hit.index : -1;
}
