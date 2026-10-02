/**
 * toolBatches.test.ts — how one step's tool calls are scheduled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PARALLEL_CALLS, partitionCalls, runLimited } from "./toolBatches.js";

const safe = (c: string) => c.startsWith("r"); // r1, r2 … are read-only; w1 … mutate

test("consecutive read-only calls are one parallel batch; every other call is alone", () => {
  assert.deepEqual(partitionCalls(["r1", "r2", "w1", "r3", "r4", "w2", "w3"], safe), [
    { parallel: true, calls: ["r1", "r2"] },
    { parallel: false, calls: ["w1"] },
    { parallel: true, calls: ["r3", "r4"] },
    { parallel: false, calls: ["w2"] },
    { parallel: false, calls: ["w3"] },
  ]);
});

test("the model's order is the execution order: a read written after a write is in a later batch", () => {
  const batches = partitionCalls(["w1", "r1"], safe);
  assert.deepEqual(batches.map((b) => b.calls), [["w1"], ["r1"]]);
  // And a read written BEFORE the write still overlaps nothing it should not.
  assert.deepEqual(partitionCalls(["r1", "w1"], safe).map((b) => b.calls), [["r1"], ["w1"]]);
});

test("nothing, one call and an all-read-only step", () => {
  assert.deepEqual(partitionCalls([], safe), []);
  assert.deepEqual(partitionCalls(["w1"], safe), [{ parallel: false, calls: ["w1"] }]);
  assert.deepEqual(partitionCalls(["r1", "r2", "r3"], safe), [{ parallel: true, calls: ["r1", "r2", "r3"] }]);
});

test("runLimited never runs more than the limit at once, and returns results in input order", async () => {
  let live = 0;
  let peak = 0;
  const items = Array.from({ length: 25 }, (_, i) => i);
  const out = await runLimited(items, 4, async (n) => {
    live++;
    peak = Math.max(peak, live);
    // Later items finish FIRST, so a result list built in finishing order would be reversed.
    await new Promise((r) => setTimeout(r, 25 - n));
    live--;
    return n * 2;
  });
  assert.equal(peak, 4, "the cap was not reached or was exceeded");
  assert.deepEqual(out, items.map((n) => n * 2));
});

test("the default cap is bounded, and a rejection stops new starts", async () => {
  assert.ok(MAX_PARALLEL_CALLS >= 4 && MAX_PARALLEL_CALLS <= 32);
  const started: number[] = [];
  await assert.rejects(
    runLimited([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
    }),
    /boom/,
  );
  assert.ok(started.length < 8, "it kept starting calls after one had failed");
});
