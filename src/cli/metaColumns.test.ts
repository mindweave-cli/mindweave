/**
 * metaColumns.test.ts — the right-hand details of a picker row line up from row to row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { columnsOf, metaColumnWidths } from "./components/Picker.js";

test("times and counts each start in the same column on every row", () => {
  const descs = ["5 minutes ago · 330 msgs", "5 minutes ago · 95 msgs", "11 days ago · 4 msgs"];
  const w = metaColumnWidths(descs);
  const rows = descs.map((d) => columnsOf(d, w));
  assert.equal(new Set(rows.map((r) => r.length)).size, 1, "same width");
  assert.equal(new Set(rows.map((r) => r.indexOf(" · "))).size, 1, "separator in one column");
  assert.deepEqual(rows, ["5 minutes ago · 330 msgs", "5 minutes ago ·  95 msgs", "11 days ago   ·   4 msgs"]);
});

test("a description with no separator is left as it is", () => {
  assert.equal(columnsOf("just text", metaColumnWidths(["just text"])), "just text");
});
