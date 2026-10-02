/**
 * wheelAccel.test.ts — the faster the wheel turns, the further each notch scrolls,
 * and a slow notch is exactly what it always was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_LINES, FAST_RATE, GESTURE_GAP_MS, MAX_FACTOR, SLOW_RATE, linesPerNotch, wheelLines, wheelStart, type WheelState } from "./wheelAccel.js";

/** Feed notches one at a time, `gapMs` apart, all the same direction; returns lines per batch. */
function spin(count: number, gapMs: number, dir = 1, start = 1000): number[] {
  let state: WheelState = wheelStart();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = wheelLines(state, dir, start + i * gapMs);
    state = r.state;
    out.push(r.lines);
  }
  return out;
}

test("a slow, deliberate notch moves exactly three lines, every time", () => {
  // Five notches a second: careful reading. Nothing about it may change.
  assert.deepEqual(spin(10, 200), Array(10).fill(BASE_LINES));
  assert.deepEqual(spin(10, 120), Array(10).fill(BASE_LINES));
});

test("the first notch of any gesture is the base step, never a jump", () => {
  assert.equal(spin(1, 0)[0], BASE_LINES);
  // Even a first chunk carrying three reports moves three notches at the base rate.
  assert.equal(wheelLines(wheelStart(), 3, 0).lines, 3 * BASE_LINES);
});

test("spinning faster moves further per notch, and never by less as speed rises", () => {
  const brisk = spin(20, 40).at(-1)!; // 25 notches a second
  const fast = spin(20, 15).at(-1)!; // about 67 a second
  assert.ok(brisk > BASE_LINES, `25/s should go further than the base, got ${brisk}`);
  assert.ok(fast > brisk, `faster should go further: ${fast} vs ${brisk}`);
  // The step never shrinks as the rate climbs.
  let last = 0;
  for (let rate = 0; rate <= 200; rate += 1) {
    const n = linesPerNotch(rate);
    assert.ok(n >= last, `step fell at ${rate}/s`);
    last = n;
  }
});

test("the step has a ceiling, so a free-spinning wheel cannot fling the view arbitrarily far", () => {
  assert.equal(linesPerNotch(FAST_RATE), BASE_LINES * MAX_FACTOR);
  assert.equal(linesPerNotch(10_000), BASE_LINES * MAX_FACTOR);
  assert.equal(linesPerNotch(SLOW_RATE), BASE_LINES);
  for (const n of spin(200, 2)) assert.ok(n <= BASE_LINES * MAX_FACTOR);
});

test("reversing direction or pausing starts over at the base", () => {
  let state = wheelStart();
  for (let i = 0; i < 15; i++) state = wheelLines(state, 1, 1000 + i * 10).state;
  assert.ok(Math.abs(wheelLines(state, 1, 1150).lines) > BASE_LINES, "sanity: it had sped up");
  // The other way, immediately: a correction, not a fling.
  assert.equal(wheelLines(state, -1, 1150).lines, -BASE_LINES);
  // Same way after a pause: a new gesture.
  assert.equal(wheelLines(state, 1, 1140 + GESTURE_GAP_MS + 50).lines, BASE_LINES);
});

test("direction is kept and nothing moves for a batch that nets to zero", () => {
  assert.ok(spin(5, 30, -1).every((n) => n < 0));
  const s = wheelStart();
  assert.deepEqual(wheelLines(s, 0, 5), { lines: 0, state: s });
});

test("one chunk of several reports does not spike the speed on its own", () => {
  // A terminal often delivers a flick as one chunk of three reports. Arriving at a normal
  // pace, that is still a moderate rate, so the step stays modest rather than maxing out.
  let state = wheelStart();
  let r = wheelLines(state, 3, 0);
  state = r.state;
  r = wheelLines(state, 3, 150); // three notches 150ms later: 20 a second
  assert.ok(r.lines <= 3 * BASE_LINES * 2, `a normal flick jumped to ${r.lines}`);
});
