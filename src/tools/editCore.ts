/**
 * editCore.ts — the pure matching/splice logic shared by the edit tool.
 *
 * One source of truth for HOW a find-and-replace is applied, kept pure (string in,
 * string out — no fs, no EOL handling) so it's unit-tested once and both tools inherit
 * the same guarantees. The tools wrap it with the disk/EOL/approval concerns; deciding
 * WHAT to change stays the model's job.
 *
 * ── Matching is TIERED, and the tiers are deliberately shallow ──────────────────
 *
 * Two failures dominate in practice, and they need opposite treatments:
 *
 *   1. The model's text is right but its INDENTATION drifted (it retyped a block from
 *      memory, or copied out of a context where leading space was normalized). An
 *      exact matcher rejects this, the model retries with the same mistake, and a turn
 *      burns. Tier 2 fixes it: compare line-by-line with each line trimmed.
 *   2. The text genuinely appears more than once. No amount of cleverness resolves
 *      that — only more context or an explicit replace_all does.
 *
 * The temptation is to keep adding ever-looser tiers until something always matches.
 * That is what the widely-copied "many replacers, first hit wins" design does, and it
 * has a known, unfixed failure mode: a loose tier silently matches the WRONG block and
 * corrupts the file, because nothing checks whether a stricter reading was ambiguous.
 * A wrong edit applied confidently is far worse than a refused edit, so this module
 * takes the opposite stance:
 *
 *   - Tiers run strictest-first and STOP at the first tier that finds anything.
 *     A tier that finds 2 matches reports an ambiguity; it never falls through to a
 *     looser tier hoping for a cleaner answer, because "looser" only ever means "more
 *     ways to be wrong".
 *   - Every tier counts matches across the WHOLE text before touching anything, so
 *     ambiguity is detected rather than raced past.
 *   - No block-anchor tier (match on first/last line, guess the middle). That is the
 *     specific mechanism behind the corruption reports, and the cases it rescues are
 *     exactly the cases most likely to hit the wrong function.
 *
 * When a match can't be made unambiguously, the failure carries the actual candidate
 * LOCATIONS back to the model (see `describeMatches`), so its retry is informed rather
 * than another guess at the same string.
 */

export interface EditOp {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** How a match was found. `exact` is byte-for-byte; `line-trimmed` ignored each line's
 *  leading/trailing whitespace (the file's own indentation is preserved on write). */
export type MatchTier = "exact" | "line-trimmed";

/** One place in the text where `old_string` could apply. */
export interface Match {
  /** Char offset of the match start in the normalized text. */
  start: number;
  /** Char offset just past the match end. */
  end: number;
  /** 1-based line number of the match start, for reporting. */
  line: number;
}

/** A successful splice on normalized (LF) text. */
export interface EditApplied {
  ok: true;
  /** The whole text after the edit (still LF-normalized). */
  updated: string;
  /** How many occurrences were replaced. */
  count: number;
  /** Char offset where the (first) change landed, and where it ends. */
  changeStart: number;
  changeEnd: number;
}

export type EditResult = EditApplied | { ok: false; reason: string };

/** Normalize CRLF → LF so a model's LF `old_string` matches a CRLF file. */
export function normalizeLf(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

/** 1-based line number of a char offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Every exact occurrence of `needle`, as spans. */
function exactMatches(haystack: string, needle: string): Match[] {
  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push({ start: at, end: at + needle.length, line: lineAt(haystack, at) });
    from = at + needle.length;
  }
}

/**
 * Every occurrence where each line matches after trimming (pure).
 *
 * This is the one concession to imprecision, and it is a narrow one: the SEQUENCE of
 * lines and their trimmed content must correspond exactly, so only the surrounding
 * whitespace is forgiven. It cannot skip lines, reorder them, or match a different
 * number of them, which is what keeps it from wandering onto the wrong block the way a
 * first-line/last-line anchor does.
 *
 * The span returned covers the file's OWN lines, so the replacement splices against
 * real file text and the file's indentation is never silently rewritten.
 */
function lineTrimmedMatches(haystack: string, needle: string): Match[] {
  const needleLines = needle.split("\n");
  // A trailing newline in the needle produces an empty last element that should not be
  // required to correspond to a real line.
  if (needleLines.length > 1 && needleLines[needleLines.length - 1] === "") needleLines.pop();
  if (needleLines.length === 0) return [];
  const wanted = needleLines.map((l) => l.trim());

  const fileLines = haystack.split("\n");
  // Char offset of the start of each line, so a line index converts back to a span.
  const offsets: number[] = [];
  let acc = 0;
  for (const l of fileLines) {
    offsets.push(acc);
    acc += l.length + 1; // +1 for the newline
  }

  const out: Match[] = [];
  for (let i = 0; i + wanted.length <= fileLines.length; i++) {
    let hit = true;
    for (let j = 0; j < wanted.length; j++) {
      if (fileLines[i + j]!.trim() !== wanted[j]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    const start = offsets[i]!;
    const lastIdx = i + wanted.length - 1;
    // End at the last matched line's end, excluding its newline — mirrors how an exact
    // match that stops mid-file behaves.
    const end = offsets[lastIdx]! + fileLines[lastIdx]!.length;
    out.push({ start, end, line: i + 1 });
    i = lastIdx; // non-overlapping
  }
  return out;
}

/** The tier that found something, plus what it found. Strictest tier that hits wins. */
export interface MatchResult {
  tier: MatchTier;
  matches: Match[];
}

/**
 * Locate `needle` in `haystack`, strictest tier first (pure).
 *
 * Stops at the FIRST tier that finds anything at all — including a tier that finds too
 * many. Falling through an ambiguous exact match to a looser tier is precisely how a
 * matcher ends up confidently editing the wrong place.
 */
export function findMatches(haystack: string, needle: string): MatchResult {
  const exact = exactMatches(haystack, needle);
  if (exact.length > 0) return { tier: "exact", matches: exact };
  const trimmed = lineTrimmedMatches(haystack, needle);
  if (trimmed.length > 0) return { tier: "line-trimmed", matches: trimmed };
  return { tier: "exact", matches: [] };
}

/** Context lines shown around each candidate, and how far that will grow to make the
 *  candidates tell each other apart. */
const CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;

/**
 * Render the candidate locations for the model (pure).
 *
 * The reason this exists: an error that says only "matches 2 places" tells the model
 * which RULE it broke but nothing it can act on, so its retry is another guess about a
 * file it may have read many turns ago. Observed consequence — a retry that differed
 * from the original attempt by a single newline, then failed identically, costing two
 * round trips to reach a string the model could have copied straight out of this text.
 *
 * With the candidates in front of it the model can either lift a unique anchor
 * verbatim, or see that every occurrence should change and pass `replace_all`.
 */
export function describeMatches(haystack: string, matches: readonly Match[], max = 4): string {
  const lines = haystack.split("\n");
  const shown = matches.slice(0, max);

  const window = (m: Match, pad: number): { from: number; to: number } => ({
    from: Math.max(1, m.line - pad),
    to: Math.min(lines.length, m.line + pad),
  });
  /**
   * The comparable substance of a candidate's window.
   *
   * Line numbers are excluded because they differ by construction, and blank lines and
   * indentation are excluded because differing only in those is not a difference the
   * model can build a unique `old_string` out of. What counts as "distinguishable" here
   * has to mean "gives the model something to anchor on", or the widening loop stops as
   * soon as two windows are technically unequal and hands back two blocks that are, for
   * every practical purpose, the same.
   */
  const contentOf = (m: Match, pad: number): string => {
    const { from, to } = window(m, pad);
    return lines
      .slice(from - 1, to)
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
  };

  // Widen the window until the candidates are actually DISTINGUISHABLE. Duplicated code
  // usually comes with duplicated surroundings — two identical helpers on two similar
  // classes — so a fixed window can render every candidate the same and leave the model
  // exactly where it started, with no unique anchor to lift. Growing until they differ
  // is what makes this report useful rather than merely informative.
  let pad = CONTEXT_LINES;
  while (pad < MAX_CONTEXT_LINES && new Set(shown.map((m) => contentOf(m, pad))).size < shown.length) {
    pad += 2;
  }
  const blocks = shown.map((m, i) => {
    const { from, to } = window(m, pad);
    const body: string[] = [];
    for (let n = from; n <= to; n++) {
      // The match line is marked so the model can see which one is the candidate
      // rather than having to count.
      body.push(`${n === m.line ? ">" : " "} ${String(n).padStart(5)} | ${lines[n - 1]}`);
    }
    return `  ${i + 1}. line ${m.line}\n${body.join("\n")}`;
  });
  const more = matches.length > shown.length ? `\n\n  … and ${matches.length - shown.length} more.` : "";
  // Stated every time rather than only when the blocks look alike. Deciding "alike" is
  // itself unreliable — a window clipped at the start of the file always differs from
  // one in the middle, whatever the code around them says — and a conditional that
  // cannot be made to fire is worse than a sentence that is always true.
  const hint =
    "\n\nExtend old_string with a line that differs between them (a class or function name above the block), " +
    "or set replace_all: true if all of them should change.";
  return blocks.join("\n\n") + more + hint;
}

/** Most needle lines and file lines the nearest-text search looks at, so a huge paste against a huge file stays quick. */
const NEAR_MAX_NEEDLE_LINES = 60;
const NEAR_MAX_FILE_LINES = 20_000;
/** A window must be at least this alike, on average, to be called "the closest text". */
const NEAR_FLOOR = 0.55;

/** How alike two lines are, 0 to 1: 1 when equal once trimmed, otherwise the share of two-letter pairs they have in common. */
function lineSimilarity(a: string, b: string): number {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) pairs.set(x.slice(i, i + 2), (pairs.get(x.slice(i, i + 2)) ?? 0) + 1);
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const key = y.slice(i, i + 2);
    const left = pairs.get(key);
    if (left) {
      shared++;
      pairs.set(key, left - 1);
    }
  }
  return (2 * shared) / (x.length + y.length - 2);
}

const clip = (s: string, n = 150): string => (s.trim().length > n ? `${s.trim().slice(0, n)}…` : s.trim());

/**
 * What to tell the model when `old_string` is not in the file (pure).
 *
 * "Not found, copy the text from the file" sends it back to re-read the whole file and guess again, which is how a
 * 4% failure rate cost one to eleven more calls each. The two things it needs are almost always in the file already:
 * whether the change is ALREADY there (the edit was applied, or a retry repeats one that worked), and the nearest
 * text with the lines that differ, which is usually one line with a changed argument or a different quote.
 * Nothing here changes what matches; it only describes the miss.
 */
export function describeMiss(haystack: string, needle: string, replacement: string): string {
  const fileLines = haystack.split("\n");
  // The change is already in the file: say where, because re-applying it is the wrong fix.
  if (replacement.trim().length >= 12 && replacement !== needle) {
    const done = findMatches(haystack, replacement).matches;
    if (done.length > 0) {
      return (
        `The text you want to write is already in the file (line ${done[0]!.line}), so this edit may have been applied already. ` +
        `Read that part of the file before changing it again.`
      );
    }
  }
  const wanted = needle.split("\n");
  if (wanted.length > 1 && wanted[wanted.length - 1] === "") wanted.pop();
  const asked = wanted.slice(0, NEAR_MAX_NEEDLE_LINES);
  if (asked.length === 0 || asked.every((l) => !l.trim()) || fileLines.length > NEAR_MAX_FILE_LINES) return "";

  // Comparing every window with every line is too slow on a big file (8 s for 20,000 lines), so the search is
  // anchored: the few longest lines of the request are matched against every file line, and only the windows
  // those lines point at are scored whole. A longest line is the one least likely to be the line that changed.
  const anchors = asked
    .map((l, j) => ({ j, len: l.trim().length }))
    .filter((a) => a.len > 0)
    .sort((a, b) => b.len - a.len)
    .slice(0, 3);
  const starts = new Set<number>();
  for (const { j } of anchors) {
    const near = fileLines
      .map((l, k) => ({ k, s: lineSimilarity(l, asked[j]!) }))
      .filter((x) => x.s >= NEAR_FLOOR)
      .sort((a, b) => b.s - a.s)
      .slice(0, 6);
    for (const { k } of near) if (k - j >= 0 && k - j + asked.length <= fileLines.length) starts.add(k - j);
  }
  let best = { at: -1, score: 0 };
  for (const i of starts) {
    let sum = 0;
    for (let j = 0; j < asked.length; j++) sum += lineSimilarity(fileLines[i + j]!, asked[j]!);
    const score = sum / asked.length;
    if (score > best.score) best = { at: i, score };
  }
  if (best.at < 0 || best.score < NEAR_FLOOR) {
    return "Nothing in the file is close to it, so the text may be in another file or may have been removed. Search for a distinctive line of it.";
  }

  const differing: string[] = [];
  let same = 0;
  for (let j = 0; j < asked.length; j++) {
    const there = fileLines[best.at + j]!;
    if (there.trim() === asked[j]!.trim()) same++;
    else if (differing.length < 3) differing.push(`  line ${j + 1} of yours: ${clip(asked[j]!)}\n  the file has:    ${clip(there)}`);
  }
  const from = best.at + 1;
  const to = best.at + asked.length;
  const shown = fileLines
    .slice(best.at, best.at + Math.min(asked.length, 8))
    .map((l, k) => `  ${String(from + k).padStart(5)} | ${l}`)
    .join("\n");
  return (
    `The closest text is at line${to > from ? `s ${from}-${to}` : ` ${from}`} (${same} of ${asked.length} line${asked.length === 1 ? "" : "s"} match):\n${shown}` +
    (asked.length > 8 ? "\n        …" : "") +
    (differing.length > 0 ? `\nWhere it differs:\n${differing.join("\n")}` : "") +
    `\nCopy the file's own text from here.`
  );
}

/**
 * Apply one exact edit to already-LF-normalized `text`. The `oldString`/`newString`
 * are normalized here too. Returns the updated text and where the change landed, or
 * a `reason` describing why it couldn't apply (identical / not found / ambiguous).
 * Splices by index so a `$` in the replacement is never a special pattern.
 */
export function applyOneEdit(text: string, op: EditOp): EditResult {
  // Normalize BOTH sides to LF: the file on disk may be CRLF while the model's
  // old_string (copied from LF text it was shown) is LF. This is a representation
  // fix, not fuzzy matching.
  const haystack = normalizeLf(text);
  const needle = normalizeLf(op.oldString);
  const replacement = normalizeLf(op.newString);

  if (needle === "") return { ok: false, reason: "old_string is empty — it must identify the text to replace" };
  if (needle === replacement) return { ok: false, reason: "old_string and new_string are identical — nothing to change" };

  const { matches } = findMatches(haystack, needle);
  if (matches.length === 0) {
    const miss = describeMiss(haystack, needle, replacement);
    return {
      ok: false,
      reason:
        "old_string not found. It must match the file's text, allowing only for differences in each line's " +
        "leading/trailing whitespace." +
        (miss ? `\n${miss}` : " Re-read the file and copy the target text from what you are shown"),
    };
  }
  if (matches.length > 1 && !op.replaceAll) {
    // Hand back WHERE, not just how many. See `describeMatches`.
    return {
      ok: false,
      reason:
        `old_string matches ${matches.length} places. Either extend it with surrounding lines until it is ` +
        `unique, or set replace_all: true to change every occurrence. The candidates:\n\n` +
        describeMatches(haystack, matches),
    };
  }

  // Splice by index, right-to-left so earlier spans keep their offsets. Never via
  // string.replace: a `$` in the replacement would be read as a pattern reference.
  const targets = op.replaceAll ? matches : [matches[0]!];
  let updated = haystack;
  for (let i = targets.length - 1; i >= 0; i--) {
    const m = targets[i]!;
    updated = updated.slice(0, m.start) + replacement + updated.slice(m.end);
  }
  const changeStart = targets[0]!.start;
  const changeEnd = targets[targets.length - 1]!.start + replacement.length;
  return { ok: true, updated, count: targets.length, changeStart, changeEnd };
}

/** The outcome of applying a whole sequence of edits to one file. */
export interface SequenceApplied {
  ok: true;
  updated: string;
  /** Total replacements across all edits. */
  total: number;
  /** Char span (in the final text) from the first edit's start to the last edit's end. */
  spanStart: number;
  spanEnd: number;
}

export type SequenceResult = SequenceApplied | { ok: false; index: number; reason: string };

/**
 * Apply edits in order to normalized `text`, each seeing the result of the one
 * before (so a later edit can target text an earlier edit produced). ATOMIC: the
 * first failure aborts the whole sequence with the offending edit's index and
 * reason — the caller writes nothing, so a file is never left half-edited.
 */
export function applyEditSequence(text: string, ops: EditOp[]): SequenceResult {
  let current = normalizeLf(text);
  let total = 0;
  let spanStart = -1;
  let spanEnd = 0;
  for (let i = 0; i < ops.length; i++) {
    const r = applyOneEdit(current, ops[i]!);
    if (!r.ok) return { ok: false, index: i, reason: r.reason };
    current = r.updated;
    total += r.count;
    if (spanStart < 0 && r.changeStart >= 0) spanStart = r.changeStart;
    spanEnd = Math.max(spanEnd, r.changeEnd);
  }
  return { ok: true, updated: current, total, spanStart: Math.max(0, spanStart), spanEnd };
}
