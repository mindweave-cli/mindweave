/**
 * inputText.test.ts — the prompt box only ever holds plain text.
 *
 * A terminal sends the line breaks of a paste as carriage returns, and a carriage return that
 * reaches the screen moves the cursor home: the box drew its own text over its own border.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanInputText } from "./inputText.js";

test("every kind of line break becomes a newline", () => {
  assert.equal(cleanInputText("a\rb\rc"), "a\nb\nc");
  assert.equal(cleanInputText("a\r\nb\r\nc"), "a\nb\nc");
  assert.equal(cleanInputText("a\nb"), "a\nb");
  assert.equal(cleanInputText("a b c"), "a\nb\nc");
});

test("escape sequences are dropped whole, not left behind as typed text", () => {
  assert.equal(cleanInputText("x\u001b[2Jy"), "xy");
  assert.equal(cleanInputText("x\u001b[1;31mred\u001b[0my"), "xredy");
  assert.equal(cleanInputText("x\u001b]0;HACKED\u0007y"), "xy");
  assert.equal(cleanInputText("x\u001b]0;HACKED\u001b\\y"), "xy");
  assert.equal(cleanInputText("tail\u001b"), "tail");
});

test("tabs become spaces and other control characters go", () => {
  assert.equal(cleanInputText("a\tb"), "a    b");
  assert.equal(cleanInputText("a\u0007b\u0008c\u007fd\u0000e"), "abcde");
  assert.equal(cleanInputText("a\u0085b\u009bc"), "abc");
});

test("ordinary text, including wide and combining characters, is returned untouched", () => {
  for (const s of ["hello world", "日本語 テキスト", "👍🏽 🧑‍💻", "é ñ", "multi\nline\n\n  indent", ""]) assert.equal(cleanInputText(s), s);
});
