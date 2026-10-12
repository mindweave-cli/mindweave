/**
 * lineDiff.ts — a real line diff, grouped into hunks with a little context (pure).
 *
 * An edit used to be shown as the old text in red and then the new text in green, so a paragraph that only gained
 * two lines was drawn twice and took a screen. This compares the file before and after, so only the lines that
 * changed are marked, with a couple of unchanged lines around each change to say where it is, and the numbers of the
 * lines as they are in the file.
 *
 * Myers' O(ND) algorithm: the cost follows how much CHANGED, not how long the file is, so a one-line edit in a
 * ten-thousand-line file is as cheap as in a ten-line one. Past `maxD` changes it gives up (null) and the caller
 * falls back to showing the old and the new text.
 */

export type DiffKind = "same" | "del" | "add";

/** One line of a hunk. `oldNo` is its number before the change (same, del), `newNo` after it (same, add). */
export interface DiffLine {
  kind: DiffKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** A run of changes with its context. A gap of unchanged lines wider than the context starts a new hunk. */
export type Hunk = DiffLine[];

export interface Op {
  kind: DiffKind;
  /** Index into the old lines (same, del) or the new lines (add). */
  at: number;
}

/** The edit script turning `a` into `b`, or null when it needs more than `maxD` insertions and deletions. */
export function myers(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const limit = Math.min(n + m, maxD);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice());
  }
  if (found < 0) return null;

  // Walk back from the end to the start, collecting the script in reverse.
  const out: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && prev[off + k - 1]! < prev[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = prev[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ kind: "same", at: x - 1 });
      x--;
      y--;
    }
    if (x === prevX) out.push({ kind: "add", at: y - 1 });
    else out.push({ kind: "del", at: x - 1 });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    out.push({ kind: "same", at: x - 1 });
    x--;
    y--;
  }
  return out.reverse();
}

/**
 * The hunks that turn `before` into `after`, each with `context` unchanged lines either side. An empty list means
 * the two are the same. Null when the change is too large to diff cheaply (the caller shows both texts instead).
 */
export function diffHunks(before: string, after: string, context = 2, maxD = 600): Hunk[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  // Whatever both ends share costs nothing: only the part between the first and the last difference is compared.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  const middle = myers(a.slice(start, endA), b.slice(start, endB), maxD);
  if (!middle) return null;

  // One flat list: the context before the first change, the changes, the context after the last. Line numbers
  // are 1-based and follow each side separately.
  const lines: DiffLine[] = [];
  for (let i = Math.max(0, start - context); i < start; i++) lines.push({ kind: "same", text: a[i]!, oldNo: i + 1, newNo: i + 1 });
  let added = 0;
  let deleted = 0;
  for (const op of middle) {
    if (op.kind === "add") {
      lines.push({ kind: "add", text: b[start + op.at]!, newNo: start + op.at + 1 });
      added++;
    } else if (op.kind === "del") {
      lines.push({ kind: "del", text: a[start + op.at]!, oldNo: start + op.at + 1 });
      deleted++;
    } else {
      // An unchanged line is at the same offset on both sides once the additions and deletions before it are counted.
      lines.push({ kind: "same", text: a[start + op.at]!, oldNo: start + op.at + 1, newNo: start + op.at + 1 + added - deleted });
    }
  }
  for (let i = 0; i < context && endA + i < a.length; i++) {
    lines.push({ kind: "same", text: a[endA + i]!, oldNo: endA + i + 1, newNo: endB + i + 1 });
  }
  return group(lines, context);
}

/** Split the flat list into hunks wherever more than `2 * context` unchanged lines separate two changes. */
function group(lines: DiffLine[], context: number): Hunk[] {
  const hunks: Hunk[] = [];
  let current: DiffLine[] = [];
  let quiet: DiffLine[] = [];
  let seenChange = false;
  for (const line of lines) {
    if (line.kind === "same") {
      quiet.push(line);
      continue;
    }
    if (!seenChange) {
      current = lastLines(quiet, context);
      seenChange = true;
    } else if (quiet.length > 2 * context) {
      hunks.push([...current, ...quiet.slice(0, context)]);
      current = lastLines(quiet, context);
    } else {
      current.push(...quiet);
    }
    quiet = [];
    current.push(line);
  }
  if (seenChange) hunks.push([...current, ...quiet.slice(0, context)]);
  return hunks;
}

/** The last `n` of `lines` (none for 0: `slice(-0)` would be all of them). */
function lastLines(lines: DiffLine[], n: number): DiffLine[] {
  return n <= 0 ? [] : lines.slice(-n);
}
