/**
 * revealOpen.test.ts — opening a row moves the view to show what opened, and folding it moves back.
 *
 * Reported: with the newest command at the bottom, opening it put its output below the
 * screen and the reader had to scroll down to see what they had just asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { revealScroll } from "./chatAnchor.js";

// A 20-row viewport. The transcript is 100 rows with the opened row at rows 80..100 etc.

test("the newest row, opened from the bottom, stays pinned when everything fits", () => {
  // Row at content rows 90..100 (10 tall), pinned to the newest: it is all on screen.
  assert.equal(revealScroll(0, 100, 20, 90, 10), 0);
});

test("the newest row, opened and taller than the screen, brings its first line to the top", () => {
  // 40 rows tall in a 20 row view, pinned: the header would be 20 rows above the top.
  assert.equal(revealScroll(0, 100, 20, 60, 40), 20, "scrolled back 20 so the header is the first line shown");
});

test("a row opened below the fold scrolls down by exactly what was hidden", () => {
  // Reader is 30 rows back (viewport shows content rows 50..70); the opened row is at 60..75.
  // Its bottom is 5 rows below the fold, so the view moves down by 5.
  assert.equal(revealScroll(30, 100, 20, 60, 15), 25);
});

test("a row already fully on screen does not move the view", () => {
  assert.equal(revealScroll(30, 100, 20, 55, 10), 30);
});

test("a row whose top is above the screen is brought back into view", () => {
  // Viewport shows rows 50..70; the row starts at 45 and is 10 tall: scroll back by 5.
  assert.equal(revealScroll(30, 100, 20, 45, 10), 35);
});

test("never past either end of the transcript", () => {
  assert.equal(revealScroll(0, 100, 20, 95, 5), 0, "cannot scroll below the newest");
  assert.equal(revealScroll(80, 100, 20, 0, 10), 80, "cannot scroll above the first row");
  assert.equal(revealScroll(5, 10, 20, 0, 10), 0, "a transcript that fits has nothing to scroll");
});

test("a row is revealed by its whole box when it has one, a command inside it by its own", async () => {
  const { registerExpandable, registerRowBox, revealNode } = await import("./expandHits.js");
  const header = { name: "header" } as never;
  const whole = { name: "whole" } as never;
  const item = { name: "item" } as never;
  registerExpandable(7, header);
  assert.equal(revealNode(7), header, "a row with no whole box falls back to its click target");
  registerRowBox(7, whole);
  assert.equal(revealNode(7), whole, "the header says nothing of the list under it, so the whole box wins");
  registerExpandable(-5, item);
  assert.equal(revealNode(-5), item, "one command in a row is its own box");
  registerRowBox(7, null);
  registerExpandable(7, null);
  registerExpandable(-5, null);
  assert.equal(revealNode(7), undefined, "a row that went away is gone");
});
