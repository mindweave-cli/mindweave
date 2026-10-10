import { test } from "node:test";
import assert from "node:assert/strict";
import { readMouse, readWheel, stripMouse } from "./mouse.js";

test("reads a wheel-up and a wheel-down report", () => {
  assert.deepEqual(readWheel("[<64;10;5M"), ["up"]);
  assert.deepEqual(readWheel("[<65;10;5M"), ["down"]);
});

test("every notch in one chunk is kept — a flick arrives as several reports", () => {
  const chunk = "[<64;1;1M[<64;1;1M[<64;1;1M";
  assert.deepEqual(readWheel(chunk), ["up", "up", "up"]);
});

test("ordinary clicks and drags are not wheel events", () => {
  assert.deepEqual(readWheel("[<0;10;5M"), [], "left press");
  assert.deepEqual(readWheel("[<0;10;5m"), [], "left release");
  assert.deepEqual(readWheel("[<32;10;5M"), [], "drag");
});

test("a modifier held during a wheel turn still reads as that wheel turn", () => {
  // Shift adds 4, alt 8, ctrl 16 — bit 6 still marks the wheel, bit 0 the direction.
  assert.deepEqual(readWheel("[<68;1;1M"), ["up"], "shift+wheel up");
  assert.deepEqual(readWheel("[<81;1;1M"), ["down"], "ctrl+wheel down");
});

test("typed text is never mistaken for a wheel event", () => {
  assert.deepEqual(readWheel("hello world"), []);
  assert.deepEqual(readWheel(""), []);
  assert.deepEqual(readWheel("[A[B\r\n"), [], "arrow keys and enter");
});

test("a wheel report mixed in with typed text is still found", () => {
  assert.deepEqual(readWheel("ab[<65;3;4Mcd"), ["down"]);
});

// ── stripMouse: the reports must never reach the text buffer ──────────────────
// A scroll used to type `[<64;25;26M` straight into the prompt, because Ink's key
// parser hands an unrecognised escape sequence on as if the user had typed it.

test("a mouse report is removed whether or not the ESC survived Ink's parser", () => {
  assert.equal(stripMouse("\x1b[<64;25;26M"), "", "raw, ESC intact");
  assert.equal(stripMouse("[<64;25;26M"), "", "as Ink re-emits it, ESC stripped");
});

test("a whole flick's worth of reports strips to nothing", () => {
  const flick = "[<64;25;26M".repeat(12) + "[<65;25;27M".repeat(9);
  assert.equal(stripMouse(flick), "");
});

test("real typing survives untouched", () => {
  assert.equal(stripMouse("hello world"), "hello world");
  assert.equal(stripMouse(""), "");
  assert.equal(stripMouse("npm run build"), "npm run build");
});

test("typing mixed with a report keeps only the typing", () => {
  assert.equal(stripMouse("ab[<65;3;4Mcd"), "abcd");
});

test("a report split across chunks does not leak its fragment as text", () => {
  // A chunk boundary can land mid-report; half of one is still not typing.
  assert.equal(stripMouse("hi\x1b[<64;25"), "hi");
  assert.equal(stripMouse("[<6"), "");
});

test("state does not leak between calls (the regex is reused)", () => {
  const chunk = "[<64;1;1M";
  assert.deepEqual(readWheel(chunk), ["up"]);
  assert.deepEqual(readWheel(chunk), ["up"], "a second identical chunk must parse the same");
});

// ── Pointer events ───────────────────────────────────────────────────────────
// Added with selection.ts: a drag needs the movement between press and release, which
// only motion reporting (1002) delivers.

test("a press, a drag and a release are told apart", () => {
  assert.deepEqual(readMouse("\x1b[<0;10;5M"), [{ kind: "press", x: 9, y: 4 }]);
  assert.deepEqual(readMouse("\x1b[<32;12;5M"), [{ kind: "drag", x: 11, y: 4 }]);
  assert.deepEqual(readMouse("\x1b[<0;12;5m"), [{ kind: "release", x: 11, y: 4 }]);
});

test("coordinates arrive 1-based and come out 0-based", () => {
  // The top-left cell is column 1, row 1 on the wire and (0, 0) in the grid.
  assert.deepEqual(readMouse("\x1b[<0;1;1M"), [{ kind: "press", x: 0, y: 0 }]);
});

test("a wheel notch is not a pointer event", () => {
  // Both readers see the same bytes; each must ignore what the other owns.
  assert.deepEqual(readMouse("\x1b[<64;5;5M"), []);
  assert.deepEqual(readMouse("\x1b[<65;5;5M"), []);
  assert.deepEqual(readWheel("\x1b[<0;5;5M"), []);
});

test("movement with no button held is a move, and is not mistaken for a drag or a click", () => {
  assert.deepEqual(readMouse("\x1b[<35;12;5M"), [{ kind: "move", x: 11, y: 4 }]);
  assert.deepEqual(readWheel("\x1b[<35;12;5M"), []);
  assert.equal(stripMouse("a\x1b[<35;12;5Mb"), "ab", "it must not reach the input box as text");
  // Held-right-button movement (34) and held-middle (33) are still not ours.
  assert.deepEqual(readMouse("\x1b[<34;12;5M"), []);
  assert.deepEqual(readMouse("\x1b[<33;12;5M"), []);
});

test("only the left button selects", () => {
  assert.deepEqual(readMouse("\x1b[<1;5;5M"), [], "middle");
  assert.deepEqual(readMouse("\x1b[<2;5;5M"), [], "right");
});

test("a whole drag in one chunk keeps its order", () => {
  const events = readMouse("\x1b[<0;2;1M\x1b[<32;5;1M\x1b[<32;9;1M\x1b[<0;9;1m");
  assert.deepEqual(events.map((e) => e.kind), ["press", "drag", "drag", "release"]);
  assert.deepEqual(events.map((e) => e.x), [1, 4, 8, 8]);
});

test("reports with the ESC already eaten by Ink's parser still read", () => {
  // The same bytes reach us twice, and Ink strips the ESC from a start-of-chunk
  // sequence. Both spellings have to parse or half the events are invisible.
  assert.deepEqual(readMouse("[<0;3;2M"), [{ kind: "press", x: 2, y: 1 }]);
});

test("pointer reports are stripped from typed text like wheel reports are", () => {
  assert.equal(stripMouse("hi\x1b[<0;3;2Mthere\x1b[<0;3;2m"), "hithere");
});
