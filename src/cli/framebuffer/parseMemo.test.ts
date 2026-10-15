/**
 * parseMemo.test.ts — reading a frame from remembered lines must give the same grid as reading every line.
 *
 * Between two frames nearly every line is the same, so a line read before is copied in rather than read again.
 * That is only right if the copy writes exactly what reading would have: the same cells, the same pen left
 * behind for the next line. These feed the same frames through both and compare every cell.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Screen } from "./screen.js";
import { parseFrame } from "./parse.js";

const ESC = String.fromCharCode(27);
const sgr = (...p: number[]) => `${ESC}[${p.join(";")}m`;

function read(frame: string, width: number, height: number, memo: boolean, into?: Screen): Screen {
  const screen = into ?? new Screen(width, height);
  screen.clear();
  parseFrame(screen, frame, 0, memo);
  return screen;
}

function same(a: Screen, b: Screen): boolean {
  return (
    a.chars.every((v, i) => v === b.chars[i]) &&
    a.fg.every((v, i) => v === b.fg[i]) &&
    a.bg.every((v, i) => v === b.bg[i]) &&
    a.attrs.every((v, i) => v === b.attrs[i])
  );
}

/** Frames with the awkward cases: styles carried across lines, wide characters, overflow, controls, cursor moves. */
const FRAMES = [
  ["plain line", "second", "third"].join("\n"),
  [`${sgr(1, 38, 2, 10, 20, 30)}bold colour`, "still bold, nothing reset it", `${sgr(0)}reset`].join("\n"),
  [`${sgr(7)}inverse`, `${sgr(27)}normal ${sgr(48, 5, 200)}bg ${sgr(49)}`, "x"].join("\n"),
  ["日本語の行 wide", "ab日c", "toolonglinetoolonglinetoolonglinetoolonglinetoolongline"].join("\n"),
  ["tab\there", "carriage\rreturn", `cursor${ESC}[3Cmove`, `erase${ESC}[Kto end`].join("\n"),
  ["a", "", "c", "", ""].join("\n"),
  [`${ESC}[2J${ESC}[3J${ESC}[H`, "after a clear", "next"].join("\n"),
  [`${sgr(2)}dim carried`, "next keeps dim", `${sgr(22)}`, "plain again"].join("\n"),
  Array.from({ length: 12 }, (_, i) => `row ${i} ${sgr(i % 7 + 30)}coloured${sgr(0)}`).join("\n"),
];

test("every frame reads the same with remembered lines as without, first time and when repeated", () => {
  for (const [n, frame] of FRAMES.entries()) {
    for (const [w, h] of [[20, 6], [60, 14]] as const) {
      const expected = read(frame, w, h, false);
      for (let pass = 0; pass < 3; pass++) {
        assert.ok(same(read(frame, w, h, true), expected), `frame ${n} at ${w}x${h}, pass ${pass}, differs from reading it line by line`);
      }
    }
  }
});

test("a line read at one width is not reused at another", () => {
  const frame = "toolonglinetoolonglinetoolonglinetoolongline\nsecond";
  read(frame, 20, 4, true);
  const narrow = read(frame, 10, 4, true);
  assert.ok(same(narrow, read(frame, 10, 4, false)));
});

test("the same line after a different pen is read again, not copied", () => {
  const a = [`${sgr(1)}head`, "body"].join("\n");
  const b = ["head", "body"].join("\n");
  read(a, 20, 4, true);
  assert.ok(same(read(b, 20, 4, true), read(b, 20, 4, false)), "a line took the style it had last time");
  assert.ok(same(read(a, 20, 4, true), read(a, 20, 4, false)));
});

test("a frame longer than the grid leaves the rows below it unwritten, and keeps the pen straight", () => {
  const frame = [`${sgr(1)}one`, "two", "three", "four", `${sgr(0)}five`].join("\n");
  assert.ok(same(read(frame, 12, 3, true), read(frame, 12, 3, false)));
  assert.ok(same(read(frame, 12, 3, true), read(frame, 12, 3, false)));
});

test("rows the frame does not reach are left as they were", () => {
  const screen = new Screen(12, 4);
  screen.clear();
  parseFrame(screen, "kept\nkept too\nkept three\nkept four", 0, false);
  const before = screen.chars.slice();
  parseFrame(screen, "new", 0, true);
  parseFrame(screen, "new", 0, true);
  assert.equal(screen.chars[0], "n".charCodeAt(0));
  assert.deepEqual([...screen.chars.slice(12)], [...before.slice(12)]);
});
