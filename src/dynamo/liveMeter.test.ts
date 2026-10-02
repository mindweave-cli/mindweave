/**
 * liveMeter.test.ts — the counter that moves while a turn works.
 *
 * Two properties, and the first one is a lesson rather than a preference: the figure
 * must track ONLY what streams. An earlier version showed the turn's billed cost so the
 * live number and the receipt would agree, which meant the prompt landed on the counter
 * the instant a call went out — the number leapt by twenty thousand and then sat still
 * for the rest of the call. It also invited the question "what were those spent on?"
 * about tokens that were mostly cache reads. Output is the only thing that grows while a
 * turn runs, so it is the only thing animated.
 *
 * The second is that the counter is eased and must still converge: a display that chases
 * a moving target has to catch it, and must never pass it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { meterReset, meterDelta, meterTick, meterValue, meterSettled, meterUsage } from "./liveMeter.js";

/** Run the render clock until the counter catches up, with a bound so a non-converging
 *  easing fails the test instead of hanging it. */
function settle(s: ReturnType<typeof meterReset>, maxFrames = 10_000) {
  let cur = s;
  for (let i = 0; i < maxFrames; i++) {
    if (meterSettled(cur)) return { state: cur, frames: i };
    cur = meterTick(cur);
  }
  throw new Error("the eased counter never caught up");
}

test("nothing has streamed, nothing is shown", () => {
  assert.equal(meterValue(meterReset()), 0);
});

test("the counter does not jump to the new total on the first frame", () => {
  // The whole point of the easing: a provider can deliver a paragraph in one chunk, and
  // rendering it as one leap is what reads as a stutter rather than as counting.
  const s = meterDelta(meterReset(), 4_000);
  const oneFrame = meterTick(s);
  assert.ok(meterValue(oneFrame) < meterValue(settle(s).state), "the counter arrived in a single frame");
  assert.ok(meterValue(oneFrame) > 0, "the counter did not move at all");
});

test("it always catches up, and never overshoots", () => {
  for (const chars of [1, 12, 69, 199, 5_000, 250_000]) {
    const { state } = settle(meterDelta(meterReset(), chars));
    assert.equal(state.shownChars, chars, `overshot or stalled at ${chars} characters`);
  }
});

test("a big backlog is absorbed over frames, not seconds", () => {
  // At a 50ms clock, a counter that crawled would still be climbing long after the reply
  // finished — the animation has to keep up with a real stream, not merely look smooth.
  const { frames } = settle(meterDelta(meterReset(), 20_000));
  assert.ok(frames < 500, `20k characters took ${frames} frames to display`);
});

test("characters are reported as tokens, not as characters", () => {
  const { state } = settle(meterDelta(meterReset(), 400));
  assert.equal(meterValue(state), 100);
});

test("deltas arriving mid-catch-up are picked up", () => {
  // A stream does not pause for the animation. The target moves while the counter chases.
  let s = meterDelta(meterReset(), 1_000);
  s = meterTick(meterTick(s));
  s = meterDelta(s, 1_000);
  assert.equal(settle(s).state.shownChars, 2_000);
});

test("a turn starts from zero", () => {
  const s = settle(meterDelta(meterReset(), 800)).state;
  assert.ok(meterValue(s) > 0);
  assert.equal(meterValue(meterReset()), 0);
});

test("the figure never counts the prompt", () => {
  // Guards the specific regression: only output may move this number. It takes streamed
  // characters (meterDelta) and a finished call's reported OUTPUT tokens (meterUsage); there is
  // deliberately no way to hand it an input-token count, and the state has no field for one.
  const empty = meterReset();
  assert.equal(meterValue(settle(empty).state), 0, "a turn that produced no output must read 0");
  assert.deepEqual(Object.keys(empty).sort(), ["chars", "doneChars", "shownChars"]);
});

test("a finished call's real output size replaces its streamed estimate, so tool-heavy work is counted", () => {
  // The model streamed 40 chars of prose but wrote a 4000-char edit into a tool call: nothing
  // streamed for that, so the estimate says 10 tokens while the call really produced ~1010.
  let s = meterReset();
  s = meterDelta(s, 40);
  s = meterUsage(s, 1010);
  for (let i = 0; i < 200; i++) s = meterTick(s);
  assert.equal(meterValue(s), 1010, "the real figure is what the counter arrives at");
  assert.ok(meterSettled(s));
  // the next call streams on top of it
  s = meterDelta(s, 400);
  for (let i = 0; i < 200; i++) s = meterTick(s);
  assert.equal(meterValue(s), 1110);
});

test("an estimate that ran ahead of the real figure is never counted back down", () => {
  let s = meterReset();
  s = meterDelta(s, 4000); // ~1000 tokens estimated
  for (let i = 0; i < 200; i++) s = meterTick(s);
  assert.equal(meterValue(s), 1000);
  s = meterUsage(s, 600); // the call really produced less
  const after = meterValue(meterTick(s));
  assert.ok(after >= 1000, "the shown figure holds rather than dropping");
});

test("the counter closes the same distance in the same time whatever the tick length", () => {
  let slow = meterDelta(meterReset(), 4000);
  let fast = slow;
  // 400ms of the counter chasing, as 8 ticks of 50ms or as 25 ticks of 16ms.
  for (let i = 0; i < 8; i++) slow = meterTick(slow, 50);
  for (let i = 0; i < 25; i++) fast = meterTick(fast, 16);
  assert.ok(Math.abs(slow.shownChars - fast.shownChars) <= slow.shownChars * 0.1, `${slow.shownChars} vs ${fast.shownChars}`);
  assert.ok(fast.shownChars <= 4000, "never past the real total");
  assert.equal(meterTick(meterReset(), 16).shownChars, 0, "nothing to chase, nothing moves");
});
