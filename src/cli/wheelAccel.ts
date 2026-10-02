/**
 * wheelAccel.ts — the faster the wheel turns, the further each notch scrolls.
 *
 * A fixed three lines a notch is right for reading: a deliberate notch moves a short,
 * predictable distance. It is wrong for travel. Getting back through a long conversation
 * took dozens of turns of the wheel, because spinning it harder moved the view no faster
 * per notch, only more often.
 *
 * So the distance per notch follows the wheel's speed, the way desktop scrolling does:
 *
 *   - Slow, separate notches (up to about ten a second) move exactly BASE lines each,
 *     the same as before, so careful reading is unchanged.
 *   - Above that, each notch moves more, rising smoothly with the rate, up to MAX_FACTOR
 *     times the base, reached by a fast spin.
 *   - Changing direction, or pausing, starts over at the base, so the first notch of a new
 *     gesture is never a jump.
 *
 * The rate is measured from when notches ARRIVE, smoothed across a gesture so one chunk
 * that happens to carry several reports does not spike it. Pure: the caller keeps the
 * state between events and passes the clock in, which is what makes it testable.
 */

/** Lines a single slow notch moves. */
export const BASE_LINES = 3;
/** Notches per second below which a notch moves exactly BASE_LINES. */
export const SLOW_RATE = 10;
/** Notches per second at which a notch reaches its largest step. */
export const FAST_RATE = 60;
/** The largest step, as a multiple of BASE_LINES. */
export const MAX_FACTOR = 8;
/** A pause longer than this ends the gesture: the next notch starts from the base again. */
export const GESTURE_GAP_MS = 180;

export interface WheelState {
  /** When the last notches arrived (ms), or -Infinity before the first. */
  at: number;
  /** Direction of the gesture in progress: 1 up, -1 down, 0 none yet. */
  dir: 1 | -1 | 0;
  /** Smoothed notches per second for this gesture. */
  rate: number;
}

export function wheelStart(): WheelState {
  return { at: Number.NEGATIVE_INFINITY, dir: 0, rate: 0 };
}

/** Lines per notch at a given rate (pure). BASE below SLOW_RATE, rising to BASE * MAX_FACTOR at FAST_RATE. */
export function linesPerNotch(rate: number): number {
  if (rate <= SLOW_RATE) return BASE_LINES;
  const t = Math.min(1, (rate - SLOW_RATE) / (FAST_RATE - SLOW_RATE));
  // Eased in (t to the 1.5): the step grows gently just above the slow range, so a brisk
  // read is not thrown, and steeply toward the top, where the hand is clearly travelling.
  // About 6 lines a notch at 25 a second, 13 at 40, and 24 at a full spin.
  return Math.round(BASE_LINES * (1 + (MAX_FACTOR - 1) * t ** 1.5));
}

/**
 * How far a batch of notches scrolls, and the state to carry to the next batch.
 *
 * `net` is the batch's notches with direction (+ up, - down), as the handler already sums
 * them; `now` is the clock in ms. Returns signed lines.
 */
export function wheelLines(state: WheelState, net: number, now: number): { lines: number; state: WheelState } {
  if (net === 0) return { lines: 0, state };
  const dir: 1 | -1 = net > 0 ? 1 : -1;
  const count = Math.abs(net);
  const gap = now - state.at;
  const sameGesture = dir === state.dir && gap <= GESTURE_GAP_MS;

  let rate: number;
  if (!sameGesture) {
    // A new gesture starts slow, whatever the first batch looks like: one report or three
    // in a chunk is still the first notch of a movement, never a reason to jump.
    rate = 0;
  } else {
    // Notches per second over the gap since the last batch, floored at 4ms so a burst of
    // reports in one tick is a high rate rather than a division by zero.
    const instant = (count * 1000) / Math.max(4, gap);
    rate = state.rate === 0 ? instant : state.rate * 0.5 + instant * 0.5;
  }
  const lines = dir * count * linesPerNotch(rate);
  return { lines, state: { at: now, dir, rate } };
}
