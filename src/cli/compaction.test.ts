/**
 * compaction.test.ts — the one line a compaction leaves in the chat, and its arithmetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { percent, compactionLine, compactingLine } from "./compaction.js";

test("a manual compaction reads as before → after with what it freed", () => {
  assert.equal(compactionLine({ before: 128_000, after: 22_000, window: 128_000 }), "Compaction complete · context 100% → 17%, 106K tokens freed");
});

test("an automatic one says why it ran", () => {
  const line = compactionLine({ before: 67_000, after: 28_000, window: 192_000, why: "idle for 18h, the provider's cache expired" });
  assert.match(line, /^Compaction complete · idle for 18h, the provider's cache expired · context 35% → 15%, 39K tokens freed$/);
});

test("a pass that recovered nothing reports zero, never a negative", () => {
  assert.match(compactionLine({ before: 40_000, after: 44_000, window: 128_000 }), /0 tokens freed/);
});

test("percentages clamp, and a zero window does not divide by zero", () => {
  assert.equal(percent(200_000, 128_000), "100%");
  assert.equal(percent(1000, 0), "0%");
});

test("a compaction the agent continues after says so, and a running one has its own line", () => {
  assert.match(compactionLine({ before: 100, after: 50, window: 200 }, true), /^Compaction complete, continuing · context 50% → 25%/);
  assert.equal(compactingLine(false), "Compacting the conversation…");
  assert.notEqual(compactingLine(true), compactingLine(false));
});
