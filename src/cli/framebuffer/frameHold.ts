/**
 * frameHold.ts — keep ONE in-between frame off the screen.
 *
 * Opening or folding a row takes two renders. The first draws the new content with the
 * view still positioned for the old height (the real height is only known once the frame is
 * laid out), so for a moment the text sits lower than it will end up; an effect then
 * measures it and moves the view, and the second render is the right picture. Ink writes
 * the first at once and the second a frame later, so the wrong one was on screen for as
 * long as that gap, which is the "quick part where the text shows even lower".
 *
 * The first render cannot be made right (nothing can know the new height before it is
 * laid out), but it does not have to be SEEN. The caller holds frames before it dispatches
 * the change and releases them from the effect that corrects it; the writer drops what
 * arrives in between, and the next frame, being a complete statement about every row, is
 * the whole picture. If no further frame comes (the correction left everything as it was),
 * the held one is painted after a short wait, so a frame can be delayed but never lost.
 *
 * Bounded on purpose: a hold that is never released ends by itself.
 */

/** The longest a hold lasts without being released. */
const HOLD_MAX_MS = 150;
/** How long after a release to wait for the corrected frame before painting the held one.
 *  Longer than Ink's render throttle, which is what spaces the two frames apart. */
const FLUSH_AFTER_MS = 80;

let heldUntil = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let flush: (() => void) | null = null;

function arm(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    heldUntil = 0;
    flush?.();
  }, ms);
  timer.unref?.();
}

/** Start dropping frames. Call BEFORE the change that causes the in-between frame. */
export function holdFrames(): void {
  heldUntil = Date.now() + HOLD_MAX_MS;
  arm(HOLD_MAX_MS + 5);
}

/** Whether frames are being held right now. Read by the writer for every frame. */
export function framesHeld(): boolean {
  return heldUntil > Date.now();
}

/** Let frames through again. The corrected frame is on its way; if none comes, the held one is painted. */
export function releaseFrames(): void {
  if (heldUntil === 0 && timer === null) return;
  heldUntil = 0;
  arm(FLUSH_AFTER_MS);
}

/** The writer's way to paint the frame it held. */
export function setHoldFlush(fn: (() => void) | null): void {
  flush = fn;
}
