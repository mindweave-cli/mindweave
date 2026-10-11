import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalAnswer, approvalBlock, workedSeconds } from "./approvalText.js";

test("the block holds the question and what it is about, so it reads on its own", () => {
  assert.equal(approvalBlock("Run this command? It force-pushes.", "git push --force origin x"), "Run this command? It force-pushes.\ngit push --force origin x");
  assert.equal(approvalBlock("", "just the detail"), "just the detail");
  assert.equal(approvalBlock("  Q?  ", "  d  "), "Q?\nd");
});

test("the answer is recorded as allowed, declined, or as given", () => {
  assert.equal(approvalAnswer("Yes, run it"), "  allowed: Yes, run it");
  assert.equal(approvalAnswer("No"), "  declined: No");
  assert.equal(approvalAnswer("Not now, try the other way"), "  answered: Not now, try the other way", "a word that only starts with 'no' is not a no");
  assert.equal(approvalAnswer("Yes, and allow this folder for the session"), "  allowed: Yes, and allow this folder for the session");
  assert.equal(approvalAnswer(undefined), null);
  assert.equal(approvalAnswer("  "), null);
  assert.match(approvalAnswer("x".repeat(200))!, /…$/, "a long free-text answer is cut");
});

test("time spent waiting for an answer is not time spent working", () => {
  assert.equal(workedSeconds(10_000, 0, 0), 10);
  assert.equal(workedSeconds(10_000, 0, 6_000), 4);
  assert.equal(workedSeconds(10_000, 0, 20_000), 0, "never negative");
});
