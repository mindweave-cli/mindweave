/**
 * liveMeter.ts — the token figure that moves while a turn is working.
 *
 * Shaped by how the best terminal agents do it, and by a previous attempt here that was
 * worse in a way worth recording.
 *
 * THE QUANTITY IS OUTPUT ONLY, estimated from the characters that have streamed back, and
 * accumulated across the whole task (reset only at task start). It is the task's OWN work.
 * Not the prompt, not the context, not a billed total: the conversation is re-sent on every
 * tool round, so a running billed figure counts the whole session's context once per round
 * and reports the session, not the task — the very thing the display must not do.
 *
 * What streams is what moves. Output is the only quantity that grows continuously while a
 * turn runs, so it is the only honest thing to animate; input does not "arrive". How full
 * the context is — the last prompt's size, which drives compaction — is a separate measure,
 * not this one.
 *
 * THE COUNTER IS EASED. Deltas arrive in lumps — a provider may deliver a whole sentence
 * in one chunk — so a counter that renders the raw total ticks in visible jerks. The
 * displayed value chases the real one a step at a time on the render clock, moving
 * faster the further behind it is, so it reads as counting rather than as stuttering.
 * It always converges: the step is never smaller than the gap's own growth for the
 * lumps a stream actually produces, and it is clamped so it can never overshoot.
 */

/** Characters per token. Deliberately the crude ratio rather than a tokenizer: this is a
 *  moving indicator, and being 10% off is invisible where being slow is not. */
const CHARS_PER_TOKEN = 4;

/** The meter's whole state. Plain data, so the reducers are testable without a UI. */
export interface MeterState {
  /** Characters of the call STILL STREAMING (estimated from what has been received). */
  chars: number;
  /** Calls already finished, at their real size (their reported output tokens, as
   *  characters). What a call writes into tool arguments never streams as text, so the
   *  estimate alone falls far behind in a tool-heavy turn; the true count replaces it. */
  doneChars: number;
  /** Characters the counter has caught up to. Trails the total, never exceeds it. */
  shownChars: number;
}

export function meterReset(): MeterState {
  return { chars: 0, doneChars: 0, shownChars: 0 };
}

/** Everything the counter is heading for: finished calls at their real size plus the
 *  estimate for the one still streaming. */
function target(s: MeterState): number {
  return s.doneChars + s.chars;
}

/** A model call finished and reported its real output size: it replaces that call's
 *  streamed estimate. The shown figure never counts down, so an estimate that ran ahead
 *  is simply caught up to rather than corrected backwards. */
export function meterUsage(s: MeterState, completionTokens: number): MeterState {
  if (!(completionTokens > 0)) return s;
  return { ...s, doneChars: s.doneChars + completionTokens * CHARS_PER_TOKEN, chars: 0 };
}

/** `count` more characters of model output have streamed in. */
export function meterDelta(s: MeterState, count: number): MeterState {
  return count > 0 ? { ...s, chars: s.chars + count } : s;
}

/** The tick length the step bands below were tuned for. */
const TICK_REFERENCE_MS = 50;

/**
 * Advance the displayed counter one render frame toward the real total.
 *
 * The three bands are the shape that reads as smooth: a near-caught-up counter creeps
 * so the last few characters do not snap into place, a moderate gap closes
 * proportionally so it never crawls behind a steady stream, and a large gap moves at a
 * flat ceiling so a big lump is absorbed over a handful of frames instead of one.
 */
export function meterTick(s: MeterState, dtMs: number = TICK_REFERENCE_MS): MeterState {
  const gap = target(s) - s.shownChars;
  if (gap <= 0) return s;
  const base = gap < 70 ? 3 : gap < 200 ? Math.max(8, Math.ceil(gap * 0.15)) : 50;
  // The bands were tuned for a tick every 50ms. The status line now ticks at the display's pace,
  // so the step is scaled by the time actually elapsed: the counter closes the same distance in
  // the same time, in smaller and more frequent steps, which is what reads as smooth.
  const step = Math.max(1, Math.round(base * Math.min(Math.max(dtMs, 1), 100) / TICK_REFERENCE_MS));
  return { ...s, shownChars: Math.min(s.shownChars + step, target(s)) };
}

/** The figure to render: estimated output tokens, as far as the counter has caught up. */
export function meterValue(s: MeterState): number {
  return Math.round(s.shownChars / CHARS_PER_TOKEN);
}

/** Has the counter finished catching up? Lets the UI stop ticking when nothing moves. */
export function meterSettled(s: MeterState): boolean {
  return s.shownChars >= target(s);
}
