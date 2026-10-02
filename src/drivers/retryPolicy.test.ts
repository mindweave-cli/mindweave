/**
 * retryPolicy.test.ts — what gets another go, and how long we are willing to wait.
 *
 * Two failure directions, both bad. Retrying too much turns a malformed request of ours
 * into a slow malformed request and hammers a provider that is already struggling.
 * Retrying too little is the behaviour this replaces, where one 429 ended a turn and
 * the user retyped their work.
 *
 * The transport half is exercised against a real `node:http` server in
 * `retryTransport.test.ts`, because "does a second attempt actually go out" is not a
 * property of a pure function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAbortLike,
  isRetryable,
  isSpentBalance,
  nextDelayMs,
  retryAfterMs,
  RETRY_TOTAL_BUDGET_MS,
} from "./retryPolicy.js";

test("transient provider failures are retried", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryable(new Error("x"), status), true, String(status));
  }
});

test("failures that will not change are not retried", () => {
  // Retrying a malformed request three times makes a bug of ours slower to see, and
  // retrying a dead key or a spent balance just delays telling the user the truth.
  for (const status of [400, 401, 402, 403, 404, 409, 413, 422]) {
    assert.equal(isRetryable(new Error("x"), status), false, String(status));
  }
});

test("a dropped connection is retried; an unknown thrown value is not", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ECONNREFUSED"]) {
    assert.equal(isRetryable(Object.assign(new Error("boom"), { code })), true, code);
  }
  assert.equal(isRetryable(new Error("socket hang up")), true);
  // Node wraps the real cause of a failed fetch one level down.
  assert.equal(isRetryable(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), true);
  // Anything we cannot recognise stays fatal: silently retrying an unknown fault is how
  // a real defect turns into an intermittent one.
  assert.equal(isRetryable(new Error("Cannot read properties of undefined")), false);
  assert.equal(isRetryable(null), false);
});

test("a cancelled request is never retried", () => {
  // The user pressed Esc. Sleeping and trying again is the opposite of what was asked.
  const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  assert.equal(isAbortLike(abort), true);
  assert.equal(isRetryable(abort), false);
  assert.equal(isRetryable(abort, 503), false, "even on an otherwise retryable status");
});

test("Retry-After is read in both spellings the wild uses", () => {
  assert.equal(retryAfterMs("2"), 2_000);
  assert.equal(retryAfterMs("0.5"), 500);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs(""), null);
  assert.equal(retryAfterMs("not-a-date"), null);
  const future = new Date(Date.now() + 3_000).toUTCString();
  const ms = retryAfterMs(future)!;
  assert.ok(ms > 1_000 && ms <= 3_500, `expected ~3s, got ${ms}`);
  // A date already past means "now", not a negative wait.
  assert.equal(retryAfterMs(new Date(Date.now() - 10_000).toUTCString()), 0);
});

test("backoff grows, stays bounded, and is jittered", () => {
  const hi = () => 1;
  const lo = () => 0;
  assert.ok(nextDelayMs(1, 0, null, 60_000, hi)! < nextDelayMs(3, 0, null, 60_000, hi)!, "grows");
  assert.ok(nextDelayMs(9, 0, null, 60_000, hi)! <= 8_000, "and stops growing");
  // Full jitter: several drivers can be in flight at once and identical backoff would
  // march them into the provider together on every step.
  assert.notEqual(nextDelayMs(3, 0, null, 60_000, hi), nextDelayMs(3, 0, null, 60_000, lo));
  assert.ok(nextDelayMs(3, 0, null, 60_000, lo)! > 0, "jitter never produces a zero wait");
});

test("the wait never outruns the budget", () => {
  assert.equal(nextDelayMs(1, RETRY_TOTAL_BUDGET_MS, null), null, "budget spent");
  assert.equal(nextDelayMs(1, RETRY_TOTAL_BUDGET_MS + 1, null), null, "and past it");
  const left = nextDelayMs(9, RETRY_TOTAL_BUDGET_MS - 200, null, RETRY_TOTAL_BUDGET_MS, () => 1);
  assert.ok(left !== null && left <= 200, `a final wait is clamped to what is left, got ${left}`);
});

test("a cooldown longer than the budget is reported, not slept through", () => {
  // Sleeping "as long as we can" would wake and fail anyway, having spent the user's
  // time to learn nothing. The provider's own sentence usually names the wait.
  assert.equal(nextDelayMs(1, 0, 120_000, 30_000), null);
  assert.equal(nextDelayMs(1, 0, 5_000, 30_000), 5_000, "one we CAN honour is obeyed exactly");
  assert.equal(nextDelayMs(1, 28_000, 5_000, 30_000), null, "measured against what is left, not the whole budget");
});

test("a spent balance is never retried, even when the provider sends it as a 429", () => {
  // GLM and OpenAI both answer an empty account with a 429. Waiting cannot fix it, so the
  // retry only delayed the explanation and sent requests that could not succeed.
  const glm = { detail: '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}' };
  const openai = { detail: '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}' };
  const anthropic = { detail: "Your credit balance is too low to access the API" };
  for (const e of [glm, openai, anthropic]) {
    assert.equal(isSpentBalance(e), true);
    assert.equal(isRetryable(e, 429), false, JSON.stringify(e).slice(0, 60));
  }
});

test("an ordinary rate limit and a per-minute quota keep their retries", () => {
  // "exceeded your current quota" alone is how some providers word a limit that clears, so
  // it must NOT be treated as an empty balance.
  for (const detail of [
    '{"error":{"message":"Rate limit reached for requests","code":"rate_limit_exceeded"}}',
    '{"error":{"message":"You exceeded your current quota, please retry in 20s","status":"RESOURCE_EXHAUSTED"}}',
    "Too Many Requests",
  ]) {
    assert.equal(isRetryable({ detail }, 429), true, detail.slice(0, 50));
  }
  assert.equal(isRetryable({ detail: "Service Unavailable" }, 503), true);
  assert.equal(isRetryable({ detail: "Insufficient balance" }, 503), false, "a spent balance is not retried on any status");
});
