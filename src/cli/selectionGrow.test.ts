/**
 * selectionGrow.test.ts — a selection anchored to the conversation, and copied across scrolls.
 *
 * The rules that matter, each of which fails quietly if it is wrong: the two ends name rows
 * by BLOCK and row-in-block (so what is above or below can change without moving them), the
 * rows that pass through the screen are kept, and a row that never did is reported instead
 * of leaving a hole in what was copied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTR, Screen } from "./framebuffer/screen.js";
import {
  RowStore,
  applyGrowSelection,
  compareKeys,
  coverage,
  edgeLines,
  focusFromPointer,
  isEmptyGrow,
  keyAtRow,
  normalizeGrow,
  rowOfKey,
  sortSpans,
  type BlockSpan,
  type GrowSel,
  type View,
} from "./selectionGrow.js";

const WIDTH = 20;

/** A screen showing these lines from the top, padded with blanks. */
function screenOf(lines: string[], height = lines.length): Screen {
  const s = new Screen(WIDTH, height);
  lines.forEach((line, y) => {
    Array.from(line).forEach((ch, x) => {
      if (x < WIDTH) s.chars[s.index(x, y)] = ch.codePointAt(0)!;
    });
  });
  return s;
}

const sel = (a: [number, number, number], f: [number, number, number], dragging = false): GrowSel => ({
  anchor: { id: a[0], off: a[1], x: a[2] },
  focus: { id: f[0], off: f[1], x: f[2] },
  dragging,
});

test("a screen row names a block and a row inside it, and the name finds the row again", () => {
  const spans: BlockSpan[] = [
    { id: 4, top: 0, height: 3 },
    { id: 9, top: 3, height: 2 },
  ];
  assert.deepEqual(keyAtRow(spans, 0), { id: 4, off: 0 });
  assert.deepEqual(keyAtRow(spans, 2), { id: 4, off: 2 });
  assert.deepEqual(keyAtRow(spans, 3), { id: 9, off: 0 });
  assert.equal(keyAtRow(spans, 5), null, "below the last block there is nothing to select");
  assert.equal(rowOfKey(spans, { id: 9, off: 1 }), 4);
  assert.equal(rowOfKey(spans, { id: 9, off: 2 }), null, "a row past the end of its block is not on screen");
  assert.equal(rowOfKey(spans, { id: 77, off: 0 }), null, "a block that is not on screen is not there");
});

test("the name of a row survives the blocks around it changing size", () => {
  // The reason the position is block + row-in-block and not a row counted from the top: the
  // block above grows by four rows, and the SAME row still has the SAME name.
  const before: BlockSpan[] = [{ id: 1, top: 0, height: 3 }, { id: 2, top: 3, height: 3 }];
  const after: BlockSpan[] = [{ id: 1, top: 0, height: 7 }, { id: 2, top: 7, height: 3 }];
  const k = keyAtRow(before, 4)!;
  assert.deepEqual(k, { id: 2, off: 1 });
  assert.equal(rowOfKey(after, k), 8, "it moved on screen, and is still found");
});

test("selecting upwards and downwards is the same selection", () => {
  const down = sel([1, 2, 5], [3, 0, 9]);
  const up = sel([3, 0, 9], [1, 2, 5]);
  assert.deepEqual(normalizeGrow(down), normalizeGrow(up));
  assert.equal(compareKeys({ id: 1, off: 9 }, { id: 2, off: 0 }) < 0, true, "block order beats row order");
  assert.equal(isEmptyGrow(sel([1, 1, 4], [1, 1, 4])), true);
  assert.equal(isEmptyGrow(sel([1, 1, 4], [1, 1, 5])), false);
});

test("a middle row is covered end to end and the first and last are cut by the ends", () => {
  const s = sel([1, 0, 5], [2, 1, 8]);
  assert.deepEqual(coverage(s, { id: 1, off: 0 }, WIDTH), { from: 5, to: WIDTH });
  assert.deepEqual(coverage(s, { id: 1, off: 1 }, WIDTH), { from: 0, to: WIDTH });
  assert.deepEqual(coverage(s, { id: 2, off: 1 }, WIDTH), { from: 0, to: 9 }, "the focus cell itself is included");
  assert.equal(coverage(s, { id: 2, off: 2 }, WIDTH), null);
  assert.equal(coverage(s, { id: 0, off: 5 }, WIDTH), null);
});

test("a pointer pulled past an edge keeps selecting whole lines", () => {
  const spans: BlockSpan[] = [{ id: 1, top: 2, height: 10 }];
  const view: View = { top: 2, bottom: 12 };
  assert.deepEqual(focusFromPointer(spans, view, 7, 5, WIDTH), { id: 1, off: 3, x: 7 });
  assert.deepEqual(focusFromPointer(spans, view, 7, 0, WIDTH), { id: 1, off: 0, x: 0 }, "above: the start of the first row");
  assert.deepEqual(focusFromPointer(spans, view, 7, 20, WIDTH), { id: 1, off: 9, x: WIDTH - 1 }, "below: the end of the last row");
  assert.equal(focusFromPointer([], view, 3, 5, WIDTH), null, "nothing to select where there is no block");
});

test("the view scrolls while the pointer is held past an edge, faster the further it is", () => {
  const view: View = { top: 3, bottom: 30 };
  assert.equal(edgeLines(10, view, 40), 0, "inside the view: no scrolling");
  assert.equal(edgeLines(2, view, 40), 2, "just above: slowly back");
  assert.equal(edgeLines(0, view, 40), 3);
  assert.equal(edgeLines(30, view, 40), -2, "just below: slowly forward");
  assert.equal(edgeLines(36, view, 40), -6);
  assert.equal(edgeLines(3, view, 40), 0, "the top row is still inside when something lies above it");
});

test("with nothing beyond the view, its edge row asks to scroll, gently", () => {
  const full: View = { top: 0, bottom: 40 };
  assert.equal(edgeLines(0, full, 40), 2);
  assert.equal(edgeLines(39, full, 40), -2);
  assert.equal(edgeLines(20, full, 40), 0);
});

test("text is assembled from the rows that passed through the screen, across scrolls", () => {
  // Two blocks of three and two rows, and a three-row window that scrolls down through them.
  const store = new RowStore();
  const frame = (lines: string[], spans: BlockSpan[]) => store.capture(screenOf(lines), spans, { top: 0, bottom: 3 });
  frame(["alpha one", "alpha two", "alpha three"], [{ id: 1, top: 0, height: 3 }, { id: 2, top: 3, height: 2 }]);
  frame(["alpha three", "beta one", "beta two"], [{ id: 1, top: -2, height: 3 }, { id: 2, top: 1, height: 2 }]);
  // From the middle of "alpha two" to the end of "beta one".
  const s = sel([1, 1, 6], [2, 0, 3]);
  const got = store.text(s, [1, 2]);
  assert.equal(got.text, "two\nalpha three\nbeta");
  assert.equal(got.complete, true);
});

test("a row that never reached the screen is reported, not quietly left out", () => {
  const store = new RowStore();
  store.capture(screenOf(["first", "second", "third"]), [{ id: 1, top: 0, height: 3 }], { top: 0, bottom: 3 });
  // Rows 3 and 4 of the block were never shown (the view jumped past them).
  store.capture(screenOf(["sixth", "seventh", ""]), [{ id: 1, top: -5, height: 8 }], { top: 0, bottom: 3 });
  const got = store.text(sel([1, 0, 0], [1, 7, 6]), [1]);
  assert.equal(got.complete, false);
  assert.match(got.text, /first\nsecond\nthird/);
});

test("a block that was never drawn or measured makes the selection incomplete", () => {
  const store = new RowStore();
  store.capture(screenOf(["a", "b"]), [{ id: 1, top: 0, height: 1 }, { id: 3, top: 1, height: 1 }], { top: 0, bottom: 2 });
  assert.equal(store.text(sel([1, 0, 0], [3, 0, 0]), [1, 2, 3]).complete, false, "block 2 was skipped");
  assert.equal(store.text(sel([1, 0, 0], [3, 0, 0]), [1, 2, 3], (id) => (id === 2 ? 0 : undefined)).complete, true, "unless it is known to have no rows");
});

test("rows keep their place when a block ABOVE them changes height between two frames", () => {
  // The estimate-corrected case: block 1 turns out four rows taller after the first frame.
  const store = new RowStore();
  store.capture(screenOf(["B one", "B two"]), [{ id: 2, top: 0, height: 2 }], { top: 0, bottom: 2 });
  store.capture(screenOf(["A x", "A y", "A z", "A w", "A v", "A u"], 6), [{ id: 1, top: 0, height: 4 }, { id: 2, top: 4, height: 2 }], { top: 0, bottom: 4 });
  const got = store.text(sel([1, 3, 0], [2, 1, 9]), [1, 2]);
  assert.equal(got.text, "A w\nB one\nB two", "no row twice, none lost, none out of order");
});

test("a row seen again is the latest version of it", () => {
  const store = new RowStore();
  const spans: BlockSpan[] = [{ id: 1, top: 0, height: 1 }];
  store.capture(screenOf(["hello"]), spans, { top: 0, bottom: 1 });
  store.capture(screenOf(["hello world"]), spans, { top: 0, bottom: 1 });
  assert.equal(store.text(sel([1, 0, 0], [1, 0, 19]), [1]).text, "hello world", "text still being written is not frozen at its first draw");
});

test("the catch-up chip never reaches what is copied", () => {
  const store = new RowStore();
  const spans: BlockSpan[] = [{ id: 1, top: 0, height: 2 }];
  // The chip covers columns 6..16 of the last row.
  const covered = screenOf(["clean top", "abc  Catch up  xyz"]);
  store.capture(covered, spans, { top: 0, bottom: 2 }, { y: 1, x0: 5, x1: 15 });
  const first = store.text(sel([1, 1, 0], [1, 1, 19]), [1]).text;
  assert.doesNotMatch(first, /Catch/);
  // A row that was captured clean earlier is not replaced by the covered one.
  const store2 = new RowStore();
  store2.capture(screenOf(["clean top", "abc whole line xyz"]), spans, { top: 0, bottom: 2 });
  store2.capture(covered, spans, { top: 0, bottom: 2 }, { y: 1, x0: 5, x1: 15 });
  assert.equal(store2.text(sel([1, 1, 0], [1, 1, 19]), [1]).text, "abc whole line xyz");
});

test("trailing padding is cut and a wide character is not doubled", () => {
  const store = new RowStore();
  const s = new Screen(6, 1);
  s.chars[s.index(0, 0)] = "日".codePointAt(0)!;
  s.chars[s.index(1, 0)] = 0x110000 + 5; // stands in for the right half / unknown cell, which must be skipped
  s.chars[s.index(2, 0)] = "x".codePointAt(0)!;
  for (let x = 3; x < 6; x++) s.chars[s.index(x, 0)] = 32;
  store.capture(s, [{ id: 1, top: 0, height: 1 }], { top: 0, bottom: 1 });
  assert.equal(store.text(sel([1, 0, 0], [1, 0, 5]), [1]).text, "日x");
});

test("the highlight lands on the right screen rows, and an empty selection draws nothing", () => {
  const s = screenOf(["row zero", "row one", "row two", "row three"]);
  const spans = sortSpans([{ id: 2, top: 2, height: 2 }, { id: 1, top: 0, height: 2 }]);
  applyGrowSelection(s, sel([1, 1, 4], [2, 0, 2]), spans, { top: 0, bottom: 4 });
  const inverse = (x: number, y: number) => (s.attrs[s.index(x, y)]! & ATTR.inverse) !== 0;
  assert.equal(inverse(0, 0), false, "above the start");
  assert.equal(inverse(3, 1), false, "left of the start on its row");
  assert.equal(inverse(4, 1), true, "the start cell");
  assert.equal(inverse(2, 2), true, "the focus cell");
  assert.equal(inverse(3, 2), false, "past the focus cell");
  assert.equal(inverse(0, 3), false, "below the end");

  const t = screenOf(["row zero"]);
  applyGrowSelection(t, sel([1, 0, 3], [1, 0, 3]), [{ id: 1, top: 0, height: 1 }], { top: 0, bottom: 1 });
  assert.equal((t.attrs[t.index(3, 0)]! & ATTR.inverse) !== 0, false);
});
