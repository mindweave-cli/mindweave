/**
 * chatAnchor.ts — where the transcript sits inside the chat viewport.
 *
 * The viewport is a fixed-height clipped box and the transcript renders in FULL
 * inside it; a vertical offset decides which part shows. That mechanism is
 * deliberately dumb — no height estimation, no per-block scrolling — because both
 * of those were tried and both are why it broke. This module owns the decision that
 * positions it, so the rule can be tested instead of eyeballed.
 *
 * Two regimes, and the whole point of the shape below is that they cannot interfere:
 *
 *   - The transcript OVERFLOWS. Then it scrolls, and the offset is negative:
 *     `-shift` slides the content up so the newest lines are on screen. `scrollUp`
 *     counts lines back from the bottom, so 0 always means pinned to the newest and
 *     fresh output stays put with no special case.
 *   - The transcript FITS. Then there is nothing to scroll, and the only question is
 *     where the spare rows go. They used to go below the text, stranding a short
 *     conversation at the top of the screen with a growing void above the input box.
 *     They now go above it, so the conversation rests on the input the way a chat is
 *     expected to.
 *
 * HOW the spare rows are moved matters more than it looks. The obvious version — pad
 * the transcript down by `chatRows - contentHeight` — was written first and a render
 * probe rejected it: `chatRows` is a MEASURED value that lags a frame, and on the
 * first render it is not yet known at all. Padding by a stale number leaves a gap on
 * a good frame and, when the number is too large, pushes the whole conversation down
 * past the clip edge and off the screen.
 *
 * So the offset here is only ever the scroll offset, and the resting case is done in
 * the layout instead: `restsOnFooter` tells the view to put a flex-grow spacer ABOVE
 * the transcript. Yoga then measures the leftover space itself, in the same pass that
 * lays the frame out, and no stale measurement can be wrong about it.
 */

/** Where the transcript sits, and how far it can travel. */
export interface ChatLayout {
  /** Vertical offset for the transcript box. Never positive: 0 when the transcript
   *  fits, negative to slide scrolled content up. */
  marginTop: number;
  /**
   * True when the transcript fits and should be pushed to the bottom of the viewport
   * by a flex spacer, rather than left floating at the top.
   *
   * Deliberately a FLAG and not a row count — see the file note. A count would have
   * to come from a measurement that lags the frame it is used in.
   */
  restsOnFooter: boolean;
  /** Lines of content that do not fit. 0 when the transcript fits entirely. */
  maxScroll: number;
  /** Lines actually scrolled back, clamped to what exists. */
  scrolled: number;
}

/**
 * Position the transcript.
 *
 * @param contentHeight measured height of the whole transcript, in rows
 * @param chatRows      measured height of the viewport it renders into
 * @param scrollUp      lines the user has scrolled back from the newest
 */
export function chatLayout(contentHeight: number, chatRows: number, scrollUp: number): ChatLayout {
  // A viewport of zero rows would compute an offset that slides the ENTIRE
  // transcript off the top — every line hidden, with nothing on screen to explain
  // it. App already clamps this, but a positioning rule should not depend on its
  // caller to stay sane: one row always shows the newest line, which is the right
  // failure for a viewport too small to be useful.
  const rows = Math.max(1, chatRows);
  const maxScroll = Math.max(0, contentHeight - rows);
  const scrolled = Math.min(Math.max(0, scrollUp), maxScroll);
  const shift = maxScroll - scrolled;
  return {
    // `|| 0` because negating zero yields `-0`, which is the same frame but a
    // different value to anything comparing with Object.is.
    marginTop: -shift || 0,
    // Nothing to scroll means nothing to scroll TO — the transcript is short, and
    // the spare rows belong above it.
    restsOnFooter: maxScroll === 0,
    maxScroll,
    scrolled,
  };
}

/**
 * Where the reader should sit after the transcript grows without a resize — a reply
 * streaming in, a tool row landing, anything that appends below the fold.
 *
 * `scrollUp` counts lines back from the newest, so it names a DISTANCE from a point
 * that keeps moving: every line a running turn appends pushes "the newest" further
 * down, and holding the distance constant slides the window itself toward the new
 * content. A reader who scrolled back to read something drifts toward the bottom with
 * no wheel touched, and a long-running turn can carry them all the way down before it
 * finishes — which is the whole difference between "reading" and "watching it happen
 * to me". Adding the growth to `scrollUp` holds the same absolute rows on screen,
 * because growth (unlike a re-wrap) does not change what a line IS — only a resize
 * needs the proportion `reflowScroll` computes instead.
 *
 * Pinned to the newest (`scrollUp === 0`) is left alone: that reader wants the growth,
 * not to be insulated from it.
 */
export function growScroll(scrollUp: number, prevHeight: number, height: number): number {
  if (scrollUp <= 0 || height <= prevHeight) return scrollUp;
  return scrollUp + (height - prevHeight);
}

/**
 * Where the reader should sit after the transcript re-wraps at a new width.
 *
 * `scrollUp` counts LINES back from the newest, and a line is not a stable unit
 * across a resize: narrow the terminal and every wrapped paragraph grows more rows,
 * so the same count lands somewhere else entirely. Being at the bottom survives that
 * by luck, because zero is zero at any width, but any scrolled-back reader is moved
 * without touching anything.
 *
 * The position is therefore carried as a PROPORTION of the scrollable range, which is
 * the one thing about "where I was reading" that a re-wrap preserves. It is not exact
 * — the same fraction of a taller transcript is a slightly different paragraph — but
 * it keeps the reader within a line or two of where they were, where a raw line count
 * can move them by pages.
 *
 * Pinned to the newest stays pinned, though that falls out of the arithmetic on its
 * own — a red-check showed the guard below is not what produces it. What the guard is
 * really for is a NEGATIVE position, which the proportion would carry through into a
 * negative offset and slide the transcript off the top of the viewport.
 */
export function reflowScroll(scrolled: number, oldMaxScroll: number, newMaxScroll: number): number {
  if (scrolled <= 0) return 0;
  if (newMaxScroll <= 0) return 0;
  // Nothing scrollable before means there is no proportion to carry; the reader was
  // looking at the whole transcript, and the bottom is where they still belong.
  if (oldMaxScroll <= 0) return 0;
  const fraction = Math.min(1, scrolled / oldMaxScroll);
  return Math.min(newMaxScroll, Math.round(fraction * newMaxScroll));
}
