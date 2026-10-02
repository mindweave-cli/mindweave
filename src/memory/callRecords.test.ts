/**
 * callRecords.test.ts — a session's calls, including the ones its capped log has forgotten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callRecords } from "./allMetas.js";
import type { SessionMeta } from "./types.js";

const call = (at: number, miss: number, out: number) => ({ at, prompt: miss, hit: 0, miss, out, model: "m" });
const meta = (over: Partial<SessionMeta>): SessionMeta => ({ id: "s", cwd: "c", entryCount: 1, updatedAt: 1000, ...over }) as SessionMeta;
const billed = (m: SessionMeta) => callRecords(m).reduce((s, c) => s + c.miss + c.out, 0);

test("a session whose log holds every call is counted as logged, nothing added", () => {
  const m = meta({ callLog: [call(1, 900, 100), call(2, 400, 50)], spend: { billed: 1450, output: 150 } as SessionMeta["spend"] });
  assert.equal(callRecords(m).length, 2);
  assert.equal(billed(m), 1450);
});

test("a long session that outgrew its log keeps its whole total, not just the newest calls", () => {
  // 200 calls kept of 260: the log holds 200 * 1000, the session's own total says 260 * 1000
  const log = Array.from({ length: 200 }, (_, i) => call(5000 + i, 900, 100));
  const m = meta({ callLog: log, spend: { billed: 260_000, output: 26_000 } as SessionMeta["spend"] });
  assert.equal(billed(m), 260_000, "nothing the session spent has gone missing");
  const recs = callRecords(m);
  assert.equal(recs.length, 201);
  assert.equal(recs[0]!.at, 5000, "the forgotten part sits where the oldest kept call began, not in the present");
  assert.equal(recs[0]!.out + recs.slice(1).reduce((s, c) => s + c.out, 0), 26_000, "output is put back as output");
});

test("a session from before the per-call log is one lump where it was last touched", () => {
  const m = meta({ updatedAt: 777, model: "x", spend: { billed: 5000, output: 1200 } as SessionMeta["spend"] });
  assert.deepEqual(callRecords(m), [{ at: 777, model: "x", hit: 0, miss: 3800, out: 1200 }]);
});

test("a log that says more than the total never invents a negative amount", () => {
  const m = meta({ callLog: [call(1, 900, 100)], spend: { billed: 500, output: 50 } as SessionMeta["spend"] });
  assert.equal(callRecords(m).length, 1);
  assert.equal(billed(m), 1000);
  assert.deepEqual(callRecords(meta({})), [], "no log and no total is no calls");
});
