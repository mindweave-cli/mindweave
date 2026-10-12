/**
 * diffRows.test.ts — reading a numbered diff row, and marking the words that changed inside a rewritten line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { changedSpans, gutterWidth, isGapRow, markChangedWords, parseDiffRow } from "./diffRows.js";

test("a numbered row is split into its sign, number and line", () => {
  assert.deepEqual(parseDiffRow("+ 210 │ const ceiling = 8000;"), { kind: "add", num: "210", text: "const ceiling = 8000;" });
  assert.deepEqual(parseDiffRow("-  12 │ old"), { kind: "del", num: " 12", text: "old" });
  assert.deepEqual(parseDiffRow("  207 │ const c = ctx();"), { kind: "ctx", num: "207", text: "const c = ctx();" });
  assert.deepEqual(parseDiffRow("+   1 │ "), { kind: "add", num: "  1", text: "" }, "an empty line keeps its row");
});

test("rows that are not numbered diff rows are left alone", () => {
  for (const line of ["L207-212 · −4 +6", "  … (3 more lines)", "- old text from an older version", "+ new text from an older version", "", "  ⋯"]) {
    assert.equal(parseDiffRow(line), null, line);
  }
});

test("a gap between two groups of changes is recognised", () => {
  assert.equal(isGapRow("    ⋯"), true);
  assert.equal(isGapRow("  ⋯"), true);
  assert.equal(isGapRow("+ 1 │ ⋯"), false);
});

test("the gutter is as wide as the sign, the number and the bar", () => {
  assert.equal(gutterWidth("+ 210 │ x"), 2 + 3 + 3);
  assert.equal(gutterWidth("+ 5 │ x"), 2 + 1 + 3);
  assert.equal(gutterWidth("plain"), 0);
});

test("only the words that differ are marked, each change on its own", () => {
  const oldText = "assert.ok(took < 450, `before the 500ms ceiling`);";
  const newText = "assert.ok(took < ceiling / 2, `before the ${ceiling}ms ceiling`);";
  const spans = changedSpans(oldText, newText)!;
  assert.deepEqual(spans.old.map(([a, b]) => oldText.slice(a, b)), ["450", "500ms"]);
  assert.deepEqual(spans.new.map(([a, b]) => newText.slice(a, b)), ["ceiling / 2", "${ceiling}ms"]);
});

test("an addition inside a line is marked whole, with its separator", () => {
  const oldText = 'run({ action: "click" }, c);';
  const newText = 'run({ action: "click", wait_ms: ceiling }, c);';
  const spans = changedSpans(oldText, newText)!;
  assert.deepEqual(spans.old, [], "nothing was removed from the old line");
  assert.equal(newText.slice(spans.new[0]![0], spans.new[0]![1]).trim(), ", wait_ms: ceiling".trim());
});

test("a line that was mostly rewritten is not marked at all", () => {
  assert.equal(changedSpans("alpha beta gamma delta", "one two three four five"), null);
  assert.equal(changedSpans("same", "same"), null);
});

test("removed rows followed by as many added rows are compared in pairs; other runs are not", () => {
  const rows = [
    parseDiffRow("- 1 │ let a = 1;"),
    parseDiffRow("- 2 │ let b = 2;"),
    parseDiffRow("+ 1 │ let a = 10;"),
    parseDiffRow("+ 2 │ let b = 20;"),
    parseDiffRow("  3 │ done"),
  ];
  const marks = markChangedWords(rows);
  assert.ok(marks[0] && marks[1] && marks[2] && marks[3], "all four rows of two rewritten lines are marked");
  assert.equal(marks[4], null, "context is never marked");
  // Two removed, one added: not a rewrite of each other, so nothing is guessed.
  const uneven = markChangedWords([parseDiffRow("- 1 │ x = 1"), parseDiffRow("- 2 │ y = 2"), parseDiffRow("+ 1 │ x = 5")]);
  assert.deepEqual(uneven, [null, null, null]);
});
