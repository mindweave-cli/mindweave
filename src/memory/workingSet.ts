/**
 * workingSet.ts — which files the session has been working in, most recent first.
 *
 * Only this selection is left. The block that used to be built from it (the current contents
 * of the active files, re-read from disk and re-sent at the end of every request) cost up to 12K
 * uncached tokens a call and was removed; the engine no longer builds or sends it. What survives
 * is the ranking, which picks the folders whose notes are worth loading (see
 * memory/projectNotes.ts and dynamo/engine.ts).
 */
import type { ReadRecord } from "../tools/types.js";

/** The most-recently-touched files, most-recent first, capped at `max`. Pure. */
export function selectActiveFiles(reads: Map<string, ReadRecord>, max: number): { path: string; record: ReadRecord }[] {
  return [...reads.entries()]
    .map(([path, record]) => ({ path, record }))
    .sort((a, b) => (b.record.touchedAt ?? 0) - (a.record.touchedAt ?? 0))
    .slice(0, max);
}
