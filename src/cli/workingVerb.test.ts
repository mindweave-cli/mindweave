import { test } from "node:test";
import assert from "node:assert/strict";
import { VERB_SWAP_MS, workingVerb, WORKING_VERBS } from "./workingVerb.js";

test("the word is steady inside a window, so the once-a-frame clock cannot make it flicker", () => {
  const start = 1_755_000_123_456;
  const picks = new Set(Array.from({ length: 200 }, (_, i) => workingVerb(start, (i * (VERB_SWAP_MS - 1)) / 200)));
  assert.equal(picks.size, 1);
});

test("the word changes through a long turn, and does not repeat for a long time", () => {
  const start = 1_755_000_123_456;
  const seen: string[] = [];
  for (let i = 0; i < 100; i++) seen.push(workingVerb(start, i * VERB_SWAP_MS));
  assert.equal(new Set(seen).size, 100, "100 windows in a row, 100 different words");
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
});

test("the pool is big enough that nobody sees through it", () => {
  assert.ok(WORKING_VERBS.length >= 300, `only ${WORKING_VERBS.length} words`);
  assert.equal(new Set(WORKING_VERBS).size, WORKING_VERBS.length, "no duplicates");
});

test("different turns walk different orders, so a NEW turn reads as new", () => {
  const picks = new Set(Array.from({ length: 40 }, (_, i) => workingVerb(1_755_000_000_000 + i * 137, 0)));
  assert.ok(picks.size >= 20, `expected variety across turns, saw ${picks.size}`);
});

test("the same turn always walks the same order", () => {
  const a = Array.from({ length: 10 }, (_, i) => workingVerb(1_755_000_123_456, i * VERB_SWAP_MS));
  const b = Array.from({ length: 10 }, (_, i) => workingVerb(1_755_000_123_456, i * VERB_SWAP_MS));
  assert.deepEqual(a, b);
});

test("no word claims progress the harness cannot see, and every one is a plain word", () => {
  for (const v of WORKING_VERBS) {
    assert.match(v, /^[A-Za-zé-]+ing$/, `${v} must be one present participle`);
    assert.doesNotMatch(v, /almost|finish|complet|nearly|done/i, `${v} claims progress nothing measures`);
  }
});

test("a zero, negative or missing time still yields a real word", () => {
  assert.ok(WORKING_VERBS.includes(workingVerb(0)));
  assert.ok(WORKING_VERBS.includes(workingVerb(-5, -100)));
  assert.ok(WORKING_VERBS.includes(workingVerb(1_755_000_000_000, 1e12)));
});
