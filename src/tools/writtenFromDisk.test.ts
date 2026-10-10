/**
 * writtenFromDisk.test.ts — an old write row opens onto the file only while the file is still
 * what the row said it wrote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writtenFromDisk } from "./rebuildDetail.js";
import { hasMore } from "../cli/transcript.js";
import { withScope, writeDetail } from "./detail.js";

const file = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
const detail = withScope("whole file · 100 lines", writeDetail(file));

test("a file with the same line count opens, and has more than the row shows", () => {
  const full = writtenFromDisk(detail, file);
  assert.ok(full && full.includes("line 99"));
  assert.ok(hasMore(detail, full));
});

test("a file that has changed size does not open onto text that was not written", () => {
  assert.equal(writtenFromDisk(detail, file + "\nextra"), undefined);
});

test("a row with no scope line is left alone", () => {
  assert.equal(writtenFromDisk(writeDetail(file), file), undefined);
});
