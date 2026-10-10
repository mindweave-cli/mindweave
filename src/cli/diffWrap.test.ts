/**
 * diffWrap.test.ts — a long diff line carried on without looking like another change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapDiffLine } from "./diffWrap.js";

test("a line that fits is left alone", () => {
  assert.deepEqual(wrapDiffLine("+ short", 20), ["+ short"]);
});

test("a long line keeps its mark once, and the rest hangs under it with a blank mark", () => {
  const body = "abcdefghijklmnopqrstuvwxyz";
  const rows = wrapDiffLine(`- ${body}`, 12);
  assert.ok(rows[0]!.startsWith("- "));
  for (const r of rows.slice(1)) assert.ok(r.startsWith("    "), r);
  assert.ok(rows.every((r) => r.length <= 12));
  assert.equal(rows.map((r, i) => (i === 0 ? r.slice(2) : r.slice(4))).join(""), body);
});
