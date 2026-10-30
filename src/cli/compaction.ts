/**
 * compaction.ts — how a compaction reports itself: one line of plain text (no React).
 *
 *   ● Compacting the conversation…                        (the dot pulses while it runs)
 *   ● Compaction complete · context 35% → 14%, 39K tokens freed
 *
 * Compaction is the one piece of background machinery worth showing. A summarizing pass REWRITES the
 * conversation, so a person who did not see it happen is left wondering why the model forgot the middle.
 * It is one settled line: there is no "compacting…" state that later fills in.
 *
 * The figures are the SAME arithmetic the compaction thresholds run on (transcript estimate + measured
 * overhead), so what is shown is what the system believed.
 */
import { formatTokens } from "../dynamo/pricing.js";
import type { CompactionReport } from "../dynamo/contextWindow.js";

export type { CompactionReport };

/** A share of the window as a whole percent, clamped to 0–100. */
export function percent(used: number, window: number): string {
  const pct = window > 0 ? Math.round((used / window) * 100) : 0;
  return `${Math.min(100, Math.max(0, pct))}%`;
}

/** The line while a compaction is running (pure). `auto` when the agent carries on with its work afterwards. */
export function compactingLine(auto: boolean): string {
  return auto ? "Compacting the conversation to free up room…" : "Compacting the conversation…";
}

/**
 * The finished line (pure). `why` is set when the engine compacted on its own, and says what made it;
 * `auto` when the agent's turn goes on afterwards.
 */
export function compactionLine(r: CompactionReport, auto = false): string {
  const freed = Math.max(0, r.before - r.after);
  const done = auto ? "Compaction complete, continuing" : "Compaction complete";
  const head = r.why ? `${done} · ${r.why}` : done;
  return `${head} · context ${percent(r.before, r.window)} → ${percent(r.after, r.window)}, ${formatTokens(freed)} tokens freed`;
}
