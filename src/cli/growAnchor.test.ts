/**
 * growAnchor.test.ts — the reading position survives the agent still working.
 *
 * Reported from a real session: scrolling back to read while a turn was running, the
 * view kept sliding toward the newest content on its own, with no wheel touched. The
 * cause is that `scrollUp` counts lines back from the newest, and the newest moves
 * every time a line is appended — holding the count fixed holds a DISTANCE from a
 * moving point, which is not the same as holding a POSITION.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { growScroll } from "./chatAnchor.js";

test("pinned to the newest is left alone — that reader wants the growth", () => {
  assert.equal(growScroll(0, 100, 400), 0);
});

test("a scrolled reader holds the same rows as the transcript grows", () => {
  // Read the derivation in chatLayout: `scrolled` (clamped scrollUp) has to grow by
  // exactly what the transcript grew by, or `shift` changes and the window moves.
  assert.equal(growScroll(30, 100, 150), 80);
  assert.equal(growScroll(30, 100, 101), 31);
});

test("sitting at the very top stays at the very top", () => {
  // scrollUp == the old maxScroll (fully scrolled back). It must track the growth
  // exactly like any other position, or the oldest content drifts down the screen
  // even though it never moved.
  assert.equal(growScroll(100, 100, 220), 220);
});

test("no growth is a no-op", () => {
  assert.equal(growScroll(30, 100, 100), 30);
});

test("shrinking is left alone, not subtracted from", () => {
  // Not a case the transcript produces in practice, but a shrink is not the growth
  // this function exists to compensate for, and subtracting could push scrollUp
  // negative.
  assert.equal(growScroll(30, 100, 90), 30);
});
