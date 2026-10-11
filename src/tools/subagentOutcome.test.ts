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

test("a verifier that answered in prose says how many commands it ran, not '0 checks'", () => {
  assert.deepEqual(verifierOutcome("fail", 0, false, 5), { headline: "Failed verification · ran 5 commands", verdict: "fail" });
  assert.equal(verifierOutcome("unstated", 0, true, 1).headline, "Stopped at its step limit · ran 1 command");
  // With real checks counted, or with nothing run at all, the old wording stands.
  assert.equal(verifierOutcome("pass", 3, false, 9).headline, "Verified · 3 checks");
  assert.equal(verifierOutcome("fail", 0, false, 0).headline, "Failed verification · 0 checks");
});
