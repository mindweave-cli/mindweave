/**
 * statusKey.test.ts — when the working line has to be drawn again.
 *
 * The line is made of the verb, the seconds worked and the tokens received, and it is redrawn only when
 * that text would change. Two states that draw the same text must give the same key, or the line is redrawn
 * for nothing sixty times a second; two that draw different text must differ, or the line stops moving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusKey } from "./App.js";

const T0 = 1_000_000_000;
const realNow = Date.now;
function at<T>(ms: number, run: () => T): T {
  Date.now = () => T0 + ms;
  try {
    return run();
  } finally {
    Date.now = realNow;
  }
}
const key = (ms: number, got = 0, waiting = false, user = false, waitedMs = 0) => at(ms, () => statusKey(user, waiting, T0, waitedMs, got));

test("a few milliseconds later draws the same line", () => {
  assert.equal(key(1200), key(1230));
});

test("a new second draws a different line", () => {
  assert.notEqual(key(1900), key(2100));
});

test("a token count that reads the same draws the same line, and one that reads differently does not", () => {
  assert.equal(key(3000, 20_000), key(3000, 20_010), "a change below what the figure shows redrew the line");
  assert.notEqual(key(3000, 100), key(3000, 5_000));
});

test("the first tokens add the count to the line", () => {
  assert.notEqual(key(3000, 0), key(3000, 1));
});

test("waiting for an answer, and the person's own command, are different lines", () => {
  assert.notEqual(key(3000, 5, false), key(3000, 5, true));
  assert.notEqual(key(3000, 5, false, false), key(3000, 5, false, true));
  // A user's command shows no verb and no tokens: only the clock.
  assert.equal(key(3000, 5, false, true), key(3000, 900, false, true));
});

test("time spent waiting does not count as time worked", () => {
  assert.equal(key(5000, 5, false, false, 4000), key(1000, 5, false, false, 0));
});
