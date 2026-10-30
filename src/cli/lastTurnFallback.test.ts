/**
 * lastTurnFallback.test.ts — the end-of-turn line for a session saved before it was kept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastTurnFromEntries } from "./App.js";
import type { Entry } from "../memory/types.js";

const e = (x: unknown) => x as Entry;

test("from the last message the person sent to the last reply written", () => {
  const entries = [
    e({ role: "user", content: "old", ts: 1_000 }),
    e({ role: "assistant", content: "old reply", ts: 2_000 }),
    e({ role: "user", content: "new", ts: 10_000 }),
    e({ role: "user", content: "a nudge", synthetic: true, ts: 50_000 }),
    e({ role: "assistant", content: "done", ts: 98_000 }),
  ];
  assert.deepEqual(lastTurnFromEntries(entries), { ms: 88_000, at: 98_000 });
});

test("no line when the conversation does not end on a reply, or the times are missing", () => {
  assert.equal(lastTurnFromEntries([e({ role: "user", content: "x", ts: 1 })]), undefined);
  assert.equal(lastTurnFromEntries([e({ role: "user", content: "x" }), e({ role: "assistant", content: "y" })]), undefined);
  assert.equal(lastTurnFromEntries([]), undefined);
});
