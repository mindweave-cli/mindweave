/**
 * uiLines.test.ts — how a UI test's lines are told apart for colouring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { uiSegments } from "./uiLines.js";

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join("");
const kinds = (line: string) => uiSegments(line).map((s) => `${s.kind}:${s.text}`);

test("no line loses or gains a character by being coloured", () => {
  for (const line of [
    "Steps · 3 of 3 ran",
    '  1. Clicked [18] text box "Chapter text".',
    '  2. Typed "One paragraph here.↵↵And a second one." into [18] text box "Chapter text".',
    '  [18] text box "Chapter text" = "One paragraph here." [type]',
    '  [4] button "Title Page" (disabled)',
    "  [9] button (no name)",
    "page: 22 elements — 14 buttons, 3 tabs",
    "  something else entirely",
    'In "Dialog":',
    "",
  ]) {
    assert.equal(text(uiSegments(line)), line, line);
  }
});

test("a section title is bold and what follows it is dim", () => {
  assert.deepEqual(kinds("Steps · 3 of 3 ran"), ["title:Steps", "dim: · 3 of 3 ran"]);
  assert.deepEqual(kinds("Page · 22 elements (4 out of view)")[0], "title:Page");
  assert.deepEqual(kinds("Page reported"), ["title:Page reported"]);
});

test("a step is plain text, with the control numbers and the quoted names standing out", () => {
  assert.deepEqual(kinds('  1. Clicked [18] text box "Chapter text".'), [
    "dim:  1. ",
    "plain:Clicked ",
    "ref:[18]",
    "plain: text box ",
    'name:"Chapter text"',
    "plain:.",
  ]);
});

test("a control is dim, with its number and its name standing out", () => {
  assert.deepEqual(kinds('  [4] button "Title Page" (disabled)'), ["dim:  ", "ref:[4]", "dim: ", "dim:button ", 'name:"Title Page"', "dim: (disabled)"]);
  assert.deepEqual(kinds("  [9] button (no name)").map((k) => k.split(":")[0]), ["dim", "ref", "dim", "dim"]);
});

test("a value after the name stays dim, and a name that holds a quote is read to its end", () => {
  const segs = uiSegments('  [19] dropdown "Page size" = "Trade 6 × 9\\"" [type]');
  assert.equal(segs.find((s) => s.kind === "name")!.text, '"Page size"');
  assert.ok(segs.filter((s) => s.kind === "dim").some((s) => s.text.includes("Trade 6")));
});

test("anything else is dim, as it always was", () => {
  assert.deepEqual(kinds("page: 22 elements — 14 buttons"), ["dim:page: 22 elements — 14 buttons"]);
  assert.deepEqual(kinds("  Stopped at step 3; 0 later steps were not run."), ["dim:  Stopped at step 3; 0 later steps were not run."]);
});
