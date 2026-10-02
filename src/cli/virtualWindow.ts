/**
 * virtualWindow.ts — which transcript blocks are worth handing to the renderer.
 *
 * THE PROBLEM THIS SOLVES, measured before it existed: the transcript rendered in
 * FULL inside a clipped viewport, so a 150-block conversation laid out ~2,100 rows
 * on every frame in order to show about 30 of them. Cost tracks total rendered rows
 * and goes superlinear — bare Ink, no Mindweave code involved:
 *
 *      700 rows ->   8.1 ms/frame
 *     1000 rows ->  52.8 ms/frame
 *     2100 rows -> 109.1 ms/frame
 *
 * Against Ink's 32ms frame throttle, that is the typing lag and the scroll stutter.
 * Memoizing the block components removed the markdown work but not this: Yoga still
 * lays out every node it is given, whether or not React re-rendered it.
 *
 * Gemini CLI hit the same wall and answered it the same way — for its alternate-buffer
 * path it renders through a VirtualizedList that keeps a cumulative offsets array and
 * draws only the slice covering the viewport. This is that idea, in the shape this
 * codebase already has.
 *
 * WHY THIS IS SAFE, given that an earlier attempt at virtualization is exactly why the
 * scroll mechanism was frozen. That attempt ESTIMATED each block's height and rendered
 * only what it thought would fit, so any drift between the estimate and the real render
 * made content shift around, and it scrolled a whole block per step so a long block
 * jumped the view past its own contents.
 *
 * This one does neither:
 *
 *   - It estimates NOTHING. It is given exact, already-measured row heights, and the
 *     caller renders nothing it has not measured (see App.tsx: a block is measured on
 *     the frame it first appears, which it always does at the bottom of the transcript
 *     before it can scroll anywhere).
 *   - It does not scroll. `scrollUp`, `chatLayout` and the negative-margin slide are
 *     untouched. The blocks outside the window are replaced by SPACERS of their exact
 *     summed height, so `contentHeight` is identical to what it was when every block
 *     was rendered in full, and therefore so is `marginTop`. The scroll mechanism
 *     cannot tell the difference; only Yoga's workload changes.
 */

/** The slice to render, and the exact empty space standing in for the rest. */
export interface VirtualWindow {
  /** Index of the first block to render. */
  start: number;
  /** Index one past the last block to render. */
  end: number;
  /** Rows occupied by blocks before `start`, to be rendered as one spacer. */
  padTop: number;
  /** Rows occupied by blocks after `end`, to be rendered as one spacer. */
  padBottom: number;
}

/**
 * How many blocks beyond each edge of the viewport to keep mounted.
 *
 * Not a performance knob — a correctness margin. A block is measured on the frame it
 * is rendered, so keeping a couple in hand on each side means the ones about to come
 * into view are already mounted and measured rather than appearing on the frame they
 * are first needed. Two is enough because the caller never virtualizes a block it has
 * not already measured.
 */
export const OVERSCAN_BLOCKS = 2;

/**
 * The most blocks the transcript keeps reachable. It used to be 150, which is only a few dozen
 * turns of tool work, and everything older was simply unreachable by scrolling: a long project
 * lost its own beginning.
 *
 * It can be this large because only the window is ever laid out. Everything else is a spacer,
 * and the cost of the rest is one pass over a list of numbers per frame. Measured: a wheel
 * notch costs the same at 150, 1,000, 3,000 and 8,000 blocks. This is a safety valve for
 * runaway sessions, not a working limit.
 */
export const SCROLLBACK_BLOCKS = 10_000;

/**
 * The blocks covering rows `[shift, shift + rows)` of the transcript, plus overscan.
 *
 * @param heights exact rendered height of every block, in rows, in transcript order
 * @param shift   first visible content row (from `chatLayout`: `maxScroll - scrolled`)
 * @param rows    viewport height in rows
 */
export function virtualWindow(heights: readonly number[], shift: number, rows: number): VirtualWindow {
  if (heights.length === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  // A viewport of no rows still has to name a block, or the caller renders an empty
  // transcript and the screen goes blank with nothing to explain it. Same reasoning as
  // chatLayout's own clamp, and the same failure it is avoiding.
  const height = Math.max(1, rows);
  const top = Math.max(0, shift);
  const bottom = top + height;

  // Walk once, accumulating offsets. A binary search over a prefix-sum array would be
  // asymptotically better and is what a list of thousands would need; this list is
  // capped at SCROLLBACK_BLOCKS, where one pass over a number array is still far
  // cheaper than the allocation a prefix-sum table would cost every frame (measured flat
  // up to 8,000 blocks).
  let first = -1;
  let last = -1;
  let offset = 0;
  for (let i = 0; i < heights.length; i++) {
    const start = offset;
    const end = offset + (heights[i] ?? 0);
    // Overlap, not containment: a block taller than the whole viewport contains no
    // visible edge and would be skipped by a containment test — leaving a hole exactly
    // where the biggest thing on screen should be.
    if (end > top && start < bottom) {
      if (first === -1) first = i;
      last = i;
    }
    offset = end;
  }

  // Nothing overlaps: the offset is past the end of the content (a stale measurement
  // during a resize can do this for a frame). Anchor to the last block rather than
  // rendering nothing, so the newest output stays on screen while it settles.
  if (first === -1) {
    first = heights.length - 1;
    last = heights.length - 1;
  }

  const start = Math.max(0, first - OVERSCAN_BLOCKS);
  const end = Math.min(heights.length, last + 1 + OVERSCAN_BLOCKS);

  let padTop = 0;
  for (let i = 0; i < start; i++) padTop += heights[i] ?? 0;
  let padBottom = 0;
  for (let i = end; i < heights.length; i++) padBottom += heights[i] ?? 0;

  return { start, end, padTop, padBottom };
}
