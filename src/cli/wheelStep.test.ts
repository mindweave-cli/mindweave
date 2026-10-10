/**
 * wheelStep.test.ts — a notch is the same distance every time, and it happens at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LINES_PER_NOTCH, MAX_LINES_PER_CHUNK, wheelLines } from "./wheelStep.js";

test("a notch is a fixed number of lines, either way, whatever came before it", () => {
  assert.equal(wheelLines(1), LINES_PER_NOTCH);
  assert.equal(wheelLines(-1), -LINES_PER_NOTCH);
  assert.equal(wheelLines(2), 2 * LINES_PER_NOTCH);
  assert.equal(wheelLines(0), 0);
  // No state: the same call gives the same answer, which is what "constant" means.
  assert.equal(wheelLines(1), wheelLines(1));
});

test("one chunk never moves more than the ceiling, so a burst cannot replace the screen", () => {
  assert.equal(wheelLines(60), MAX_LINES_PER_CHUNK);
  assert.equal(wheelLines(-60), -MAX_LINES_PER_CHUNK);
  assert.ok(MAX_LINES_PER_CHUNK < 24, "the old single-frame jump was 24");
  // Up to the ceiling nothing is shortened.
  assert.equal(wheelLines(MAX_LINES_PER_CHUNK / LINES_PER_NOTCH), MAX_LINES_PER_CHUNK);
});

test("the wheel is applied directly: no timer, no queue, no glide", () => {
  const app = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
  const handler = app.slice(app.indexOf("const notches = readWheel(input)"), app.indexOf("let pendingDrag"));
  assert.match(handler, /wheelLines\(net\)/);
  assert.doesNotMatch(handler, /setInterval|setTimeout|glide/i, "scrolling must not be animated");
});
