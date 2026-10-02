/**
 * sessionMemoryCompact.ts — compacting without a model call.
 *
 * Session memory is already a structured, continuously-refreshed picture of what this
 * session is doing, maintained outside the transcript (see `sessionMemory.ts`). When
 * the transcript crosses the autocompact bar, the usual answer is to spend a whole
 * summarizer call producing... a structured picture of what this session is doing.
 * If the notes are current, that call is buying something we already own.
 *
 * So this runs first. It replaces the summarized prefix with the notes themselves and
 * keeps the recent tail verbatim, for zero tokens and zero latency. Only when the
 * notes are missing, still the untouched template, or too stale to have covered
 * enough of the transcript does the summarizer get called.
 *
 * WHAT MAKES IT SAFE. The notes cover everything up to the entry index they were last
 * refreshed at, and everything AFTER that index is kept verbatim. So the split is not
 * a guess about what matters; it is the boundary between what has been written down
 * and what has not. Stale notes do not lose work, they simply mean more of the tail
 * has to be kept, which is exactly the case where this declines and lets the
 * summarizer do its job.
 *
 * Pure except for reading the session object: it returns a new transcript or null and
 * makes no model call, no I/O, and no decision about when to run.
 */
import { estimateEntriesTokens, groupByRound } from "./compaction.js";
import { SESSION_MEMORY_TEMPLATE } from "./sessionMemory.js";
import type { Entry } from "./types.js";

const env = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * Least recent transcript we are willing to keep verbatim.
 *
 * Below this the notes are carrying nearly everything, and a compaction that leaves
 * the model almost no raw recent context is the one that reads as amnesia even when
 * the notes are good. If this cannot be met under the bar, decline and summarize.
 */
export const SM_KEEP_MIN_TOKENS = env("MINDWEAVE_SM_COMPACT_MIN", 10_000);

/**
 * Most recent transcript we are willing to keep verbatim.
 *
 * The point of compacting is to reclaim room; keeping an unbounded tail because it
 * happens to fit would leave the next compaction due almost immediately.
 */
export const SM_KEEP_MAX_TOKENS = env("MINDWEAVE_SM_COMPACT_MAX", 40_000);

/** Prepended to the notes when they stand in for the summarized prefix. Deliberately
 *  close to the summary's own resume prefix: from the model's side this IS the summary,
 *  and telling it which machinery produced its context would only invite commentary. */
const RESUME_PREFIX =
  "[Earlier conversation compacted to save context. Your maintained session notes " +
  "below are the record of it. Continue as if the break never happened — do not " +
  "acknowledge the compaction or recap it.]\n\n";

/**
 * Are these notes real, or just the skeleton nobody has filled in yet (pure)?
 *
 * The template ships with headers and italic `_descriptions_` that the model leaves
 * intact and writes beneath, so "non-empty" is not the same as "has content". Strip
 * everything the template already contained and see whether anything is left.
 */
export function hasRealNotes(notes: string | undefined): boolean {
  const substance = (text: string): string =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !(line.startsWith("_") && line.endsWith("_")))
      .join("\n");
  const written = substance(notes ?? "");
  if (!written) return false;
  // A model that echoes a stretch of the template verbatim has still written nothing.
  return written !== substance(SESSION_MEMORY_TEMPLATE);
}

/**
 * The most recent whole rounds that fit in `budget` tokens (pure).
 *
 * Rounds rather than entries, for the reason `groupByRound` exists: a round with six
 * parallel tool calls is seven entries, so counting entries can sever a call from its
 * result and turn a merely-long request into a malformed one. Whole rounds only, taken
 * from the end.
 */
export function recentRoundsWithin(entries: readonly Entry[], budget: number): Entry[] {
  const groups = groupByRound(entries);
  const kept: Entry[][] = [];
  let total = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    const cost = estimateEntriesTokens(group);
    if (total + cost > budget && kept.length > 0) break;
    // The newest round is taken even if it alone exceeds the budget: returning nothing
    // would hand the model a summary and no working context at all, which is worse
    // than being slightly over. The caller's own bar check is what catches that.
    kept.unshift(group);
    total += cost;
    if (total >= budget) break;
  }
  return kept.flat();
}

export interface SessionMemoryCompaction {
  /** The replacement transcript: the notes as a summary entry, then the kept tail. */
  readonly entries: Entry[];
  /** How many recent entries were kept verbatim, for the caller's bookkeeping. */
  readonly kept: number;
}

/**
 * Compact using the session notes instead of a summarizer call (pure), or null to
 * decline.
 *
 * Declines when there is nothing written down, when the notes cover none of the
 * transcript, or when the result would not actually get under `targetTokens` — in
 * which case spending the summarizer call is the right answer and this must not
 * pretend otherwise. `overhead` is everything outside the transcript, so the target
 * is measured in the same currency the compaction bars use.
 */
export function compactFromSessionMemory(
  entries: readonly Entry[],
  notes: string | undefined,
  coveredEntries: number | undefined,
  targetTokens: number,
  overhead: number,
): SessionMemoryCompaction | null {
  if (!hasRealNotes(notes)) return null;
  // Without a boundary we cannot say which part of the transcript the notes describe,
  // and keeping the wrong half is the one failure this must never risk.
  if (coveredEntries === undefined || coveredEntries <= 0) return null;
  if (coveredEntries > entries.length) return null;

  const summaryEntry: Entry = { role: "summary", content: RESUME_PREFIX + (notes ?? "").trim(), ts: Date.now() };
  const fixed = estimateEntriesTokens([summaryEntry]) + overhead;

  // What the tail may cost and still leave us under the bar, capped so a compaction
  // that technically fits does not leave the next one due immediately.
  const budget = Math.min(SM_KEEP_MAX_TOKENS, targetTokens - fixed);
  if (budget < SM_KEEP_MIN_TOKENS) return null;

  // Only the uncovered tail is a candidate: anything earlier is already in the notes,
  // and keeping it verbatim as well would pay for it twice.
  const uncovered = entries.slice(coveredEntries);
  const tail = recentRoundsWithin(uncovered.length > 0 ? uncovered : entries.slice(-1), budget);
  if (tail.length === 0) return null;

  const result = [summaryEntry, ...tail];
  // The decisive check. Everything above is an attempt; this is whether it worked.
  if (estimateEntriesTokens(result) + overhead > targetTokens) return null;
  return { entries: result, kept: tail.length };
}
