/**
 * blockBoxes.test.ts — the registry a selection reads to learn which block a screen row is.
 *
 * The case that matters: React lets go of a box and takes hold of the next one on EVERY
 * commit, and the frame is written between the two. A registry that honoured the "let go"
 * was empty exactly when the frame was being captured, so rows scrolled past mid-drag
 * belonged to no block and were never copied.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DOMElement } from "ink";
import { blockSpans, registerBlockBox, registeredBlocks } from "./blockBoxes.js";

/** A box that measures as `height` rows tall, `top` rows below its parent (which sits at row 10). */
function box(top: number, height: number, attached = true): DOMElement {
  const parent = { yogaNode: { getComputedLeft: () => 0, getComputedTop: () => 10, getComputedWidth: () => 80, getComputedHeight: () => 100 } };
  return {
    parentNode: attached ? parent : undefined,
    yogaNode: { getComputedLeft: () => 0, getComputedTop: () => top, getComputedWidth: () => 80, getComputedHeight: () => height },
  } as unknown as DOMElement;
}

test("a box that is let go of between two commits is still there for the frame written in between", () => {
  const node = box(0, 3);
  registerBlockBox(9001, node);
  registerBlockBox(9001, null); // the commit lets go...
  assert.deepEqual(blockSpans(0).filter((s) => s.id === 9001), [{ id: 9001, top: 10, height: 3 }], "...and the frame still finds it");
  registerBlockBox(9001, node); // ...and takes hold again
  assert.equal(blockSpans(0).filter((s) => s.id === 9001).length, 1);
});

test("spans are in screen rows, ordered from the top, offset by where the layout starts", () => {
  registerBlockBox(9010, box(5, 2));
  registerBlockBox(9011, box(0, 5));
  const mine = blockSpans(4).filter((s) => s.id >= 9010 && s.id <= 9011);
  assert.deepEqual(mine, [{ id: 9011, top: 14, height: 5 }, { id: 9010, top: 19, height: 2 }]);
});

test("a box that has really gone (no longer in the tree) is dropped when next looked at", () => {
  const before = registeredBlocks();
  registerBlockBox(9020, box(0, 1, false));
  assert.equal(registeredBlocks(), before + 1);
  assert.equal(blockSpans(0).some((s) => s.id === 9020), false);
  assert.equal(registeredBlocks(), before, "and forgotten, so the registry cannot grow without bound");
});

test("blocks that were drawn and left are forgotten even when nothing ever looks at the registry", () => {
  // A long session scrolls through thousands of blocks; none of them may be kept alive.
  for (let i = 0; i < 600; i++) registerBlockBox(20_000 + i, box(0, 1, false));
  assert.ok(registeredBlocks() < 300, `${registeredBlocks()} boxes still held`);
});
