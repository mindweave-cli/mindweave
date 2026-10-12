/**
 * caretPark.test.ts — the caret takes no column, and its position comes from LAYOUT.
 *
 * Every caret the app draws has to live in a cell, because a terminal grid has no room
 * between two of them. Standing ON a character hides it for half of each blink; taking a
 * column of its own opens a gap between the characters it sits between. So nothing is
 * drawn: the terminal's own cursor is parked at the right cell after each frame.
 *
 * WHERE it goes is the part that went wrong twice. The first version searched the PAINTED
 * screen for the caret's row text, which fails the moment the paint and the text disagree
 * — a row ending in a space is painted against padding spaces, a long row is painted
 * truncated — and a failed search dropped the cursor entirely. Typing a space made the
 * caret vanish until the next keystroke.
 *
 * It reads the layout now, which already knows the answer and cannot disagree with itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { caretCell, declareCaret, caretDeclaration, parkAt, HIDE } from "./caretPark.js";
import type { DOMElement } from "ink";

/** A node measuring as a box at (x, y). `measureElement` reads yoga through the node, so
 *  a stub with the same shape is enough to drive the arithmetic under test. */
function refTo(node: DOMElement | null): { current: DOMElement | null } {
  return { current: node };
}

function boxAt(x: number, y: number, width = 40, height = 1): DOMElement {
  const layout = { getComputedWidth: () => width, getComputedHeight: () => height, getComputedLeft: () => x, getComputedTop: () => y };
  return { yogaNode: layout } as unknown as DOMElement;
}

test("the caret cell is the box's left edge plus the column", () => {
  assert.deepEqual(caretCell({ ref: refTo(boxAt(4, 20)), column: 5 }), { x: 9, y: 20 });
});

test("column zero sits at the start of the box, not on the character", () => {
  assert.deepEqual(caretCell({ ref: refTo(boxAt(4, 20)), column: 0 }), { x: 4, y: 20 });
});

test("a column past the box is clamped inside it", () => {
  // A caret cannot be parked off the end of its own row; the terminal would put it on the
  // next line, which reads as the cursor jumping somewhere else entirely.
  const at = caretCell({ ref: refTo(boxAt(4, 20, 10)), column: 999 });
  assert.deepEqual(at, { x: 4 + 9, y: 20 });
});

test("nothing declared parks nothing", () => {
  assert.equal(caretCell(null), null);
});

test("a node that was never laid out parks nothing", () => {
  // A zero-sized measurement means the node is not on screen. Trusting it would put the
  // cursor at the top-left corner, which is worse than leaving it alone.
  assert.equal(caretCell({ ref: refTo(boxAt(0, 0, 0, 0)), column: 0 }), null);
});

test("an unmounted node parks nothing rather than throwing", () => {
  // Between the declaration and the paint a node can go away — a picker opening over the
  // input, a resize. The frame must still be written.
  const gone = {} as unknown as DOMElement;
  assert.doesNotThrow(() => caretCell({ ref: refTo(gone), column: 0 }));
  assert.equal(caretCell({ ref: refTo(gone), column: 0 }), null);
});

test("the escape is a 1-based move plus a show", () => {
  // Terminals count from 1; the layout counts from 0. An off-by-one here puts the cursor
  // one cell up and left of the text on every single frame.
  assert.equal(parkAt({ x: 0, y: 0 }), "\x1b[1;1H\x1b[?25h");
  assert.equal(parkAt({ x: 9, y: 4 }), "\x1b[5;10H\x1b[?25h");
  assert.equal(HIDE, "\x1b[?25l");
});

test("the declaration is what the renderer reads, and can be cleared", () => {
  const node = boxAt(1, 1);
  declareCaret({ ref: refTo(node), column: 3 });
  assert.equal(caretDeclaration()?.column, 3);
  declareCaret(null);
  assert.equal(caretDeclaration(), null);
});

test("the position never depends on what was PAINTED", () => {
  // The regression that made a space drop the caret. The same node measures the same
  // whatever ended up on screen, so a trailing space, a truncated row, or a screen full
  // of padding cannot move or lose the cursor.
  const node = boxAt(4, 20, 40);
  const before = caretCell({ ref: refTo(node), column: 5 });
  const after = caretCell({ ref: refTo(node), column: 5 });
  assert.deepEqual(before, after);
  assert.deepEqual(before, { x: 9, y: 20 });
});

test("EVERY write path re-parks the cursor, and presents atomically without hiding it", async () => {
  // Source-enforced, because neither property is observable from a test: what a terminal
  // DISPLAYS mid-write is not in the bytes, and the failure needs a real cursor to strand.
  //
  // Three paths write to the terminal — a frame, the idle full repaint, and the overlay
  // re-tint. A repaint moves the cursor wherever its last run ended, so one that does not
  // re-park leaves it in the corner; and one that does not HIDE while writing lets it be
  // seen travelling across the screen.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./framebuffer/writer.ts", import.meta.url), "utf8");
  const writes = (source.match(/real\.write\(/g) ?? []).length;
  const parks = (source.match(/caretTail\(\)/g) ?? []).length;
  const synced = (source.match(/SYNC_START \+ escape/g) ?? []).length;
  assert.ok(writes >= 3, `expected the three write paths, found ${writes}`);
  assert.ok(parks >= 3, `only ${parks} write paths park the cursor`);
  assert.ok(synced >= 3, `only ${synced} write paths present their frame atomically`);
  // And none of them may hide the cursor to do it. Bracketing a paint with a hide/show
  // switches the caret off and on again on EVERY keystroke, which is visible as the
  // cursor blinking out whenever anything is typed.
  assert.ok(
    !/HIDE \+ escape/.test(source),
    "a paint must not HIDE the cursor — that switches the caret off on every keystroke",
  );
  assert.match(source, /escape === ""/, "an empty paint must skip the bracket, or it writes bytes for nothing");
});

test("the declaration is made during RENDER, never from a layout effect", async () => {
  // The one-keystroke lag, and the reason it is enforced in source: Ink writes its frame
  // from resetAfterCommit, which React runs BEFORE layout effects. A declaration made in
  // useLayoutEffect is therefore read by the NEXT frame — the cursor sits visibly at the
  // previous position for a moment before catching up, which is what "it appears before
  // the text, then jumps to the end" is.
  //
  // Their own hook documents defeating this by deferring the render past layout effects.
  // Stock Ink does not, so the declaration has to happen earlier instead.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./components/PromptInput.tsx", import.meta.url), "utf8");

  const call = source.indexOf("declareCaret(active");
  assert.ok(call > 0, "the input no longer declares its caret");

  // Nothing between the top of the component and the call may be a layout effect wrapping
  // it: the call must sit in the render body itself.
  const before = source.slice(0, call);
  const lastEffect = Math.max(before.lastIndexOf("useLayoutEffect("), before.lastIndexOf("useEffect("));
  const lastClose = before.lastIndexOf("});");
  assert.ok(
    lastEffect < lastClose,
    "declareCaret is inside an effect — the frame is written before effects run, so it would be a keystroke behind",
  );

  // And the box is a REF, resolved at paint time. Holding the node itself would freeze
  // whatever was current when the declaration was made.
  assert.match(source.slice(call, call + 160), /ref: caretRowRef/, "the caret must declare a ref, not a node");
});

test("the caret is parked when it MOVES, even though no frame is written", async () => {
  // The 400ms pause after typing a space. A trailing space renders to an identical Ink
  // frame — a blank at the end of a row is indistinguishable from the padding already
  // beside it — so Ink writes nothing, the framebuffer never runs, and the only thing
  // that actually changed, the cursor, never reaches the terminal. It caught up when the
  // after-burst repaint fired, which is the wait the user sees.
  const { framebufferStdout } = await import("./framebuffer/writer.js");
  const { onCaretMoved } = await import("./caretPark.js");
  const writes: string[] = [];
  const out = {
    columns: 40,
    rows: 10,
    write(data: string) { writes.push(data); return true; },
    on() { return this; },
    off() { return this; },
  };
  framebufferStdout(out as never);
  writes.length = 0;

  declareCaret({ ref: refTo(boxAt(2, 3)), column: 4 });
  await new Promise((r) => setTimeout(r, 40)); // Ink repaints on a timer: one event-loop tick was sometimes too soon on a loaded runner
  assert.equal(writes.join(""), parkAt({ x: 6, y: 3 }), "a moved caret must reach the terminal on its own");

  // And a declaration that did not move must stay silent, or every render puts bytes on
  // the wire for a screen where nothing changed.
  writes.length = 0;
  declareCaret({ ref: refTo(boxAt(2, 3)), column: 4 });
  await new Promise((r) => setTimeout(r, 40)); // Ink repaints on a timer: one event-loop tick was sometimes too soon on a loaded runner
  assert.equal(writes.join(""), "");

  declareCaret(null);
  onCaretMoved(null);
});
