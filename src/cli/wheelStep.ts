/**
 * wheelStep.ts — how far the wheel moves the view.
 *
 * One notch is `LINES_PER_NOTCH` lines, always, and the view moves at once. No speed-up, no
 * animation. The wheel used to accelerate (a hard spin moved the view 24 lines in a single
 * frame, about 1,400 lines a second), which is what made it easy to lose your place; a
 * glide was tried after that and read as slow, because it made the view arrive later than
 * the hand did. What is left is the plain version: turn the wheel a little, the view moves
 * a little, straight away, the same every time.
 *
 * The one guard is a ceiling on what a SINGLE input chunk may move. A touchpad can deliver
 * dozens of reports in one burst, and applied whole that is a screenful in one frame,
 * which is the old problem again. Capped, the rest of the spin simply arrives in the next
 * chunks, a few milliseconds later.
 *
 * Pure.
 */

/** Lines one notch of the wheel moves. */
export const LINES_PER_NOTCH = 4;
/** The most one input chunk moves, in lines (four notches). */
export const MAX_LINES_PER_CHUNK = 16;

/**
 * The signed distance for a chunk carrying `net` notches (up positive).
 */
export function wheelLines(net: number): number {
  const lines = net * LINES_PER_NOTCH;
  return Math.max(-MAX_LINES_PER_CHUNK, Math.min(MAX_LINES_PER_CHUNK, lines));
}
