/**
 * virtualWindow.test.ts — the rule that decides which blocks reach the renderer.
 *
 * The invariant that makes this safe to put under a FROZEN scroll mechanism, and the
 * one every test here is really checking: whatever the window is,
 * `padTop + heights(window) + padBottom` equals the total. If that ever drifts, the
 * measured `contentHeight` changes, `chatLayout` computes a different `marginTop`, and
 * the transcript jumps — which is precisely how the previous attempt at this failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OVERSCAN_BLOCKS, SCROLLBACK_BLOCKS, virtualWindow } from "./virtualWindow.js";

/** Sum of the heights actually rendered, plus both spacers. */
function total(heights: number[], w: ReturnType<typeof virtualWindow>): number {
  let inside = 0;
  for (let i = w.start; i < w.end; i++) inside += heights[i] ?? 0;
  return w.padTop + inside + w.padBottom;
}

const sum = (h: number[]) => h.reduce((a, b) => a + b, 0);

test("total height is preserved exactly, at every scroll position", () => {
  // THE load-bearing property. Checked across the whole scroll range rather than at a
  // sampled point, because a drift of one row is enough to make the view jitter and
  // would be easy to miss at a single offset.
  const heights = [3, 12, 1, 40, 7, 2, 9, 25, 4, 6];
  const height = sum(heights);
  for (let shift = 0; shift <= height; shift++) {
    const w = virtualWindow(heights, shift, 20);
    assert.equal(total(heights, w), height, `drifted at shift=${shift}`);
  }
});

test("every row of the viewport is covered by a rendered block", () => {
  // The other half: preserving the total is worthless if the window skips a block the
  // user is looking at. Walks the range and asserts the visible span is inside
  // [padTop, padTop + rendered).
  const heights = [5, 5, 5, 5, 5, 5, 5, 5];
  const rows = 12;
  for (let shift = 0; shift <= sum(heights) - rows; shift++) {
    const w = virtualWindow(heights, shift, rows);
    let inside = 0;
    for (let i = w.start; i < w.end; i++) inside += heights[i] ?? 0;
    assert.ok(w.padTop <= shift, `top of viewport not rendered at shift=${shift}`);
    assert.ok(w.padTop + inside >= shift + rows, `bottom of viewport not rendered at shift=${shift}`);
  }
});

test("a block taller than the whole viewport is still rendered", () => {
  // The containment bug this exists to prevent: a 60-row block seen through a 10-row
  // viewport has neither edge inside it, so a naive "is this block's start or end
  // visible" test drops it and leaves a hole where the biggest thing on screen was.
  //
  // The list is deliberately LONG and the tall block deliberately in the middle. A
  // first draft used [2, 60, 2] and was worthless: with containment the window falls
  // back to anchoring at the end, and OVERSCAN_BLOCKS then swept the whole three-item
  // list back in, so the test passed with the bug present. Red-checking caught it.
  // Here the tall block is far enough from both ends that overscan cannot reach it.
  const heights = [2, 2, 2, 2, 2, 60, 2, 2, 2, 2, 2];
  const tall = 5;
  // Mid-way down the tall block: neither of its edges is inside the viewport.
  const w = virtualWindow(heights, 10 + 25, 10);
  assert.ok(
    w.start <= tall && w.end > tall,
    `the tall block was skipped — window ${JSON.stringify(w)} does not cover index ${tall}`,
  );
  assert.equal(total(heights, w), sum(heights));
});

test("only a slice is rendered when the transcript is much taller than the viewport", () => {
  // The whole point. 150 blocks of 14 rows is the real worst case measured at ~2,100
  // rows and ~109ms per frame; the window must be a small constant of that.
  const heights = Array.from({ length: 150 }, () => 14);
  const w = virtualWindow(heights, 1000, 30);
  assert.ok(w.end - w.start <= 4 + OVERSCAN_BLOCKS * 2, `rendered ${w.end - w.start} blocks`);
  assert.equal(total(heights, w), 150 * 14);
});

test("a transcript that fits renders entirely, with no spacers", () => {
  const heights = [4, 4, 4];
  const w = virtualWindow(heights, 0, 40);
  assert.deepEqual(w, { start: 0, end: 3, padTop: 0, padBottom: 0 });
});

test("pinned to the bottom keeps the newest block mounted", () => {
  // scrollUp === 0 is the common case and must always show the newest output.
  const heights = Array.from({ length: 40 }, () => 10);
  const rows = 25;
  const w = virtualWindow(heights, sum(heights) - rows, rows);
  assert.equal(w.end, 40, "the newest block must be rendered when pinned to the bottom");
  assert.equal(w.padBottom, 0);
});

test("an offset past the end of the content anchors to the newest block, never to nothing", () => {
  // Reachable for a frame when a measurement is stale mid-resize. Rendering nothing
  // would blank the screen with no way for the user to tell why.
  const heights = [5, 5, 5];
  const w = virtualWindow(heights, 999, 10);
  assert.ok(w.end - w.start >= 1, "must still render something");
  assert.equal(total(heights, w), 15);
});

test("degenerate inputs do not produce a blank or inconsistent frame", () => {
  assert.deepEqual(virtualWindow([], 0, 20), { start: 0, end: 0, padTop: 0, padBottom: 0 });
  // A zero-row viewport still names a block, matching chatLayout's own clamp.
  const w = virtualWindow([3, 3, 3], 0, 0);
  assert.ok(w.end > w.start);
  assert.equal(total([3, 3, 3], w), 9);
  // A negative offset cannot pull the window off the front of the list.
  const neg = virtualWindow([3, 3, 3], -50, 5);
  assert.equal(neg.start, 0);
  assert.equal(total([3, 3, 3], neg), 9);
});

test("a long session keeps its beginning reachable, and the window stays cheap", () => {
  // The cap used to be 150 blocks, so a long project lost its own start: scrolling up ended at
  // block N-150 and nothing older could be reached.
  assert.ok(SCROLLBACK_BLOCKS >= 5000, `cap is ${SCROLLBACK_BLOCKS}: a long session would lose its start again`);
  const heights = Array.from({ length: 5000 }, (_, i) => 1 + (i % 7));
  const all = heights.reduce((a, b) => a + b, 0);
  // Scrolled all the way up: the window must include block 0.
  const top = virtualWindow(heights, 0, 40);
  assert.equal(top.start, 0, "the first block is in the window at the top of the transcript");
  assert.equal(top.padTop, 0);
  // And at the bottom the window is the end, with every earlier block as padding.
  const bottom = virtualWindow(heights, all - 40, 40);
  assert.equal(bottom.end, heights.length);
  assert.equal(bottom.padTop + (bottom.padBottom), all - heights.slice(bottom.start, bottom.end).reduce((a, b) => a + b, 0));
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) virtualWindow(heights, (i * 97) % (all - 40), 40);
  assert.ok((performance.now() - t0) / 100 < 5, "a frame's window maths at 5,000 blocks stays well under a few ms");
});
