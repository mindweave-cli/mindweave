/**
 * diffRows.ts — reading a numbered diff row, and finding the words that changed inside a changed line (pure).
 *
 * The edit tools write each row as `<+|-| > <number> │ <text>` (see tools/detail.ts), a gap between two groups of
 * changes as a `⋯` row, and anything else (the scope line, a "more lines" marker, a diff saved by an older version,
 * which has no numbers) as a row of its own. This tells them apart so the screen can draw the gutter dim, tint only the
 * lines that changed, and mark the words that differ between a removed line and the line that replaced it.
 */

import { myers } from "../tools/lineDiff.js";

export type DiffRowKind = "add" | "del" | "ctx";

export interface DiffRow {
  kind: DiffRowKind;
  /** The number field, already padded to the gutter's width. */
  num: string;
  text: string;
}

/** `+ 210 │ text`, `-  12 │ text`, `  207 │ text`: the sign, the number, the gutter mark, the line. */
const ROW = /^([+\- ]) ( *\d*) │ ?(.*)$/;

/** The row a gap between two groups of changes is written as. */
const GAP = /^ +⋯$/;

export function isGapRow(line: string): boolean {
  return GAP.test(line);
}

/** The row's parts, or null when it is not a numbered diff row. */
export function parseDiffRow(line: string): DiffRow | null {
  const m = ROW.exec(line);
  if (!m) return null;
  return { kind: m[1] === "+" ? "add" : m[1] === "-" ? "del" : "ctx", num: m[2]!, text: m[3]! };
}

/** Where the gutter ends in a row, so a continuation of a long line can be indented to match (0 when it has none). */
export function gutterWidth(line: string): number {
  const m = ROW.exec(line);
  if (!m) return 0;
  return 2 + m[2]!.length + 3;
}

/** A half-open range of characters in a line. */
export type Span = readonly [number, number];

/** Words, runs of spaces, and single marks: the pieces two lines are compared by. */
const TOKEN = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g;

/** The ranges of each line that differ, comparing them piece by piece (pure). */
function tokenSpans(oldText: string, newText: string): { old: Span[]; new: Span[] } | null {
  const tokens = (t: string): { text: string; at: number }[] => Array.from(t.matchAll(TOKEN), (m) => ({ text: m[0], at: m.index! }));
  const a = tokens(oldText);
  const b = tokens(newText);
  const script = myers(a.map((t) => t.text), b.map((t) => t.text), 400);
  if (!script) return null;
  const oldSpans: Span[] = [];
  const newSpans: Span[] = [];
  const push = (list: Span[], from: number, to: number): void => {
    // Changes with only spaces between them are one change: "a b" -> "x y" is marked whole, not as two words and a gap.
    const last = list[list.length - 1];
    if (last && last[1] <= from) {
      const gap = (list === oldSpans ? oldText : newText).slice(last[1], from);
      if (gap.trim() === "") {
        list[list.length - 1] = [last[0], to];
        return;
      }
    }
    list.push([from, to]);
  };
  for (const op of script) {
    if (op.kind === "del") push(oldSpans, a[op.at]!.at, a[op.at]!.at + a[op.at]!.text.length);
    else if (op.kind === "add") push(newSpans, b[op.at]!.at, b[op.at]!.at + b[op.at]!.text.length);
  }
  return { old: oldSpans, new: newSpans };
}

const covered = (spans: readonly Span[]): number => spans.reduce((n, [from, to]) => n + (to - from), 0);

/**
 * The parts of each line that differ, as ranges (pure). Null when the two lines are too different for a highlight to say
 * anything (most of a line changed), or when they are the same.
 */
export function changedSpans(oldText: string, newText: string): { old: Span[]; new: Span[] } | null {
  if (oldText === newText) return null;
  const spans = tokenSpans(oldText, newText);
  if (!spans || (spans.old.length === 0 && spans.new.length === 0)) return null;
  // Most of the line changed: marking nearly all of it is the same as marking none.
  const longest = Math.max(oldText.length, newText.length);
  if (longest > 0 && Math.max(covered(spans.old), covered(spans.new)) / longest > 0.7) return null;
  return spans;
}

/**
 * For each changed row, the parts of it to mark (pure). A run of removed rows followed directly by as many added rows is
 * read as those lines having been rewritten, and each pair is compared; anything else is left unmarked.
 */
export function markChangedWords(rows: readonly (DiffRow | null)[]): (readonly Span[] | null)[] {
  const marks: (readonly Span[] | null)[] = rows.map(() => null);
  let i = 0;
  while (i < rows.length) {
    if (rows[i]?.kind !== "del") {
      i++;
      continue;
    }
    let dels = i;
    while (rows[dels]?.kind === "del") dels++;
    let adds = dels;
    while (rows[adds]?.kind === "add") adds++;
    const count = dels - i;
    if (adds - dels === count) {
      for (let k = 0; k < count; k++) {
        const pair = changedSpans(rows[i + k]!.text, rows[dels + k]!.text);
        if (pair) {
          marks[i + k] = pair.old;
          marks[dels + k] = pair.new;
        }
      }
    }
    i = Math.max(adds, i + 1);
  }
  return marks;
}
