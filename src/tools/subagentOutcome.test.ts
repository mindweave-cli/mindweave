import { test } from "node:test";
import assert from "node:assert/strict";
import { verifierOutcome, workerOutcome } from "./subagentOutcome.js";

test("a verifier's verdict is a headline and a colour", () => {
  assert.deepEqual(verifierOutcome("pass", 3), { headline: "Verified · 3 checks", verdict: "pass" });
  assert.deepEqual(verifierOutcome("fail", 1), { headline: "Failed verification · 1 check", verdict: "fail" });
  assert.deepEqual(verifierOutcome("partial", 8), { headline: "Could not fully verify · 8 checks", verdict: "partial" });
  assert.deepEqual(verifierOutcome("???", 0), { headline: "No verdict", verdict: "unknown" });
});

test("a worker that finished cleanly is done, and the other endings say why they are not", () => {
  assert.deepEqual(workerOutcome({ status: "complete", trustworthy: true, exhausted: false }), { headline: "Done", verdict: "pass" });
  assert.equal(workerOutcome({ status: "failed", trustworthy: false, exhausted: false }).verdict, "fail");
  assert.equal(workerOutcome({ status: "complete", trustworthy: false, exhausted: true }).headline, "Stopped at its step limit");
  assert.equal(workerOutcome({ status: "partial", trustworthy: false, exhausted: false }).headline, "Only part of it");
  assert.equal(workerOutcome({ status: "unstated", trustworthy: false, exhausted: false }).verdict, "unknown");
});
