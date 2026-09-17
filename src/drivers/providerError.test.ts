/**
 * providerError.test.ts — which failures get the calm notice, and which stay loud.
 *
 * The whole value of this module is the line it draws. Getting it wrong in one
 * direction shows a JSON blob where a sentence belongs; getting it wrong in the
 * OTHER direction tells someone their account is at fault when the bug is ours, and
 * hides a real defect behind a reassuring message. So the statuses are pinned
 * exhaustively, and the wording is pinned for what it must never say.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessRefusal, detailOf, providerMessage, providerOutage, statusOf } from "./providerError.js";
import { ProviderHttpError, upstreamError } from "./openaiCompat/wire.js";

/** What the compat layer throws for a non-2xx response. */
const httpError = (status: number, body: string) => new ProviderHttpError(status, body, "DeepSeek", "");

/** What an SDK throws: a status plus the body already parsed onto `error`. */
const sdkError = (status: number, message: string) =>
  Object.assign(new Error(`${status} ${message}`), { status, error: { type: "error", message } });

// ── The line between "your account" and "our bug" ─────────────────────────────

test("account statuses become a notice", () => {
  for (const status of [401, 402, 403, 429]) {
    const refusal = accessRefusal(httpError(status, "nope"), "DeepSeek", true);
    assert.ok(refusal, `${status} should be recognised as an account refusal`);
  }
});

test("a malformed request stays LOUD — it is our bug, not the account's", () => {
  // The direction that matters most. A 400 is a parameter we chose being rejected,
  // which is exactly the class of defect the per-model driver rules exist to catch.
  // Dressing it as a calm account notice would hide it.
  for (const status of [400, 404, 409, 422, 500, 502, 503]) {
    assert.equal(accessRefusal(httpError(status, "bad"), "DeepSeek", true), null, `${status} must stay an error`);
  }
});

test("a REAL 400 parameter rejection still stays loud, phrased as providers phrase it", () => {
  // The exact shapes this project has actually produced while adding providers.
  const rejections = [
    '{"error":{"message":"Invalid parameter: reasoning_effort","type":"invalid_request_error"}}',
    '{"error":{"message":"Function tools with reasoning_effort are not supported for gpt-5.6-sol"}}',
    '{"error":{"message":"thinking.type: Input should be enabled"}}',
    '{"error":{"message":"max_tokens must be greater than thinking.budget_tokens"}}',
  ];
  for (const body of rejections) {
    assert.equal(accessRefusal(httpError(400, body), "OpenAI", true), null, `must stay loud: ${body}`);
  }
});

test("Anthropic's 400 for a spent balance IS recognised — it does not use 402", () => {
  // Anthropic returns a spent balance as 400 invalid_request_error. Excluding every
  // 400 would leave the single most likely provider showing a red crash for a
  // billing state. LiteLLM shipped exactly that and it broke their fallback routing.
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  });
  const refusal = accessRefusal(httpError(400, body), "Anthropic", true);
  assert.ok(refusal, "a 400 naming a credit balance is an account refusal");
  assert.match(refusal!.body, /credit balance is too low/);
});

test("the 400 exception needs the provider's own words, not just the status", () => {
  // The exception is granted by the MESSAGE, so a 400 with an empty or unrelated
  // body cannot slip through on the status alone.
  assert.equal(accessRefusal(httpError(400, ""), "Anthropic", true), null);
  assert.equal(accessRefusal(httpError(400, "some other problem"), "Anthropic", true), null);
});

test("an error with no status at all stays loud", () => {
  // A thrown string, a network failure, a bug in our own code.
  assert.equal(accessRefusal(new Error("socket hang up"), "DeepSeek", true), null);
  assert.equal(accessRefusal("something", "DeepSeek", true), null);
  assert.equal(accessRefusal(null, "DeepSeek", true), null);
});

test("statusOf reads a number and refuses anything else", () => {
  assert.equal(statusOf(httpError(429, "")), 429);
  assert.equal(statusOf({ status: "429" }), null, "a string status is not a status");
  assert.equal(statusOf(new Error("x")), null);
  assert.equal(statusOf(undefined), null);
});

// ── Quoting the provider instead of guessing ──────────────────────────────────

test("the provider's sentence is lifted out of its JSON envelope", () => {
  const refusal = accessRefusal(
    httpError(402, JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } })),
    "DeepSeek",
    true,
  )!;
  assert.match(refusal.body, /Insufficient Balance/);
  assert.ok(!refusal.body.includes("unknown_error"), "the envelope must not survive");
  assert.ok(!refusal.body.includes("{"), `raw JSON leaked into the notice: ${refusal.body}`);
});

test("an SDK error is read from its pre-parsed body, not its concatenated message", () => {
  const refusal = accessRefusal(sdkError(400 + 1, "Your credit balance is too low"), "Anthropic", true)!;
  assert.match(refusal.body, /Your credit balance is too low/);
  assert.ok(!/^401/.test(refusal.body), "the status prefix must not survive into the sentence");
});

test("a plain-text body is used as-is", () => {
  const refusal = accessRefusal(httpError(429, "Rate limit exceeded, retry in 30s"), "Groq", true)!;
  assert.match(refusal.body, /Rate limit exceeded, retry in 30s/);
});

test("several envelope shapes are all understood", () => {
  assert.equal(providerMessage('{"error":{"message":"a"}}'), "a");
  assert.equal(providerMessage('{"error":"b"}'), "b");
  assert.equal(providerMessage('{"message":"c"}'), "c");
  assert.equal(providerMessage('{"detail":"d"}'), "d");
  assert.equal(providerMessage("plain words"), "plain words");
  assert.equal(providerMessage(""), "");
});

test("an unbounded body cannot evict the input box", () => {
  // The notice renders in the FOOTER. An HTML error page or a stack trace put there
  // unbounded is the same failure the plan-approval overlay hit: the frame grows
  // past the terminal and the input box goes off screen.
  const huge = providerMessage("x".repeat(5000));
  assert.ok(huge.length <= 240, `body was ${huge.length} chars`);
  assert.ok(!providerMessage("a\nb\nc\nd").includes("\n"), "newlines would break the rail");
});

test("a refusal with an unreadable body still says something useful", () => {
  const refusal = accessRefusal(httpError(403, ""), "Kimi", true)!;
  assert.ok(refusal.body.trim().length > 0);
  assert.match(refusal.title, /Kimi/);
});

// ── What it must never say ────────────────────────────────────────────────────

test("the title names the provider, so a BYOK tool is never mistaken for the biller", () => {
  const refusal = accessRefusal(httpError(402, "no funds"), "Anthropic", true)!;
  assert.match(refusal.title, /^Anthropic /, `title must lead with the provider: ${refusal.title}`);
  assert.ok(!/mindweave/i.test(refusal.title + refusal.body), "we are not the one charging them");
});

test("it never claims to know WHY, because it does not", () => {
  // A rate limit and a spent balance arrive looking alike. Telling someone to top up
  // when they only need to wait is the failure this design exists to avoid.
  const rateLimited = accessRefusal(httpError(429, "Rate limit reached"), "Groq", true)!;
  const all = `${rateLimited.title} ${rateLimited.body}`.toLowerCase();
  for (const word of ["credit", "top up", "out of money", "billing", "unpaid"]) {
    assert.ok(!all.includes(word), `our own wording must not diagnose: found "${word}"`);
  }
});

test("/provider is offered only when there is something to switch to", () => {
  const withKey = accessRefusal(httpError(402, "no funds"), "Anthropic", true)!;
  assert.match(withKey.body, /\/provider/);

  const alone = accessRefusal(httpError(402, "no funds"), "Anthropic", false)!;
  assert.ok(!alone.body.includes("/provider"), "suggesting a switch with no second key is noise");
  assert.ok(alone.body.trim().length > 0, "there must still be an action");
});

test("detailOf prefers the raw body, then the SDK's parsed one, then the message", () => {
  assert.equal(detailOf({ detail: "raw", error: { message: "parsed" }, message: "msg" }), "raw");
  assert.match(detailOf({ error: { message: "parsed" }, message: "msg" }), /parsed/);
  assert.equal(detailOf({ message: "msg" }), "msg");
});


test("a rejected key points at the fix; a spent account points at the provider", () => {
  // The commonest way a first run dies is a mistyped key or one pasted for the wrong
  // provider. Sending that person to a billing page is the wrong steer, and until /key
  // existed there was no way to retype it at all — eighteen commands, none of them keys.
  const rejected = accessRefusal(httpError(401, "Authentication Fails"), "DeepSeek", false);
  assert.match(rejected!.body, /\/key/, "a rejected key does not say how to replace it");
  assert.doesNotMatch(rejected!.body, /provider's side/, "it still blames the account");

  // A balance or a rate limit genuinely is on the provider's side, and offering to
  // retype a key that works would send someone chasing the wrong thing.
  for (const status of [402, 429]) {
    const account = accessRefusal(httpError(status, "no balance"), "DeepSeek", false);
    assert.match(account!.body, /provider's side/, `${status} should point at the account`);
    assert.doesNotMatch(account!.body, /\/key/, `${status} should not suggest retyping a working key`);
  }
});

test("switching is only suggested when there is something to switch to", () => {
  const alone = accessRefusal(httpError(401, "bad"), "DeepSeek", false);
  assert.doesNotMatch(alone!.body, /\/provider/, "offered a switch with nothing to switch to");
  const spoiled = accessRefusal(httpError(401, "bad"), "DeepSeek", true);
  assert.match(spoiled!.body, /\/provider/, "another usable key exists and is not mentioned");
});

// ── The provider falling over ────────────────────────────────────────────────

test("a 5xx after the retries becomes a calm notice naming the model", () => {
  for (const status of [500, 502, 503, 504, 529]) {
    const outage = providerOutage(new ProviderHttpError(status, "ERROR", "OpenRouter", ""), "OpenRouter", "Union Alpha");
    assert.ok(outage, `${status} should read as the provider failing`);
    assert.match(outage!.title, /Union Alpha isn't responding/);
    assert.match(outage!.body, /provider's side, not your key/);
    assert.match(outage!.body, /\/model/, "the notice must say what to do");
  }
});

test("a bare ERROR from the provider is not quoted back as if it explained anything", () => {
  const outage = providerOutage(new ProviderHttpError(502, JSON.stringify({ error: { message: "ERROR" } }), "OpenRouter", ""), "OpenRouter", "Union Alpha");
  assert.doesNotMatch(outage!.body, /said:/);
});

test("a provider sentence that does explain is quoted", () => {
  const outage = providerOutage(new ProviderHttpError(503, JSON.stringify({ error: { message: "No endpoints available for this model" } }), "OpenRouter", ""), "OpenRouter", "Union Alpha");
  assert.match(outage!.body, /OpenRouter said: "No endpoints available for this model"/);
});

test("a failure reported inside a successful reply is the provider's too", () => {
  const outage = providerOutage(upstreamError("OpenRouter API error: the reply ended with an error"), "OpenRouter", "Union Alpha");
  assert.match(outage!.body, /part way through the reply/);
  assert.doesNotMatch(outage!.body, /said:/);
});

test("a request that never got through says so", () => {
  const outage = providerOutage(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), "OpenRouter", "Union Alpha");
  assert.match(outage!.title, /Can't reach OpenRouter/);
});

test("our own bugs and account refusals never get the outage notice", () => {
  for (const status of [400, 401, 402, 403, 404, 422, 429]) {
    assert.equal(providerOutage(new ProviderHttpError(status, "x", "OpenRouter", ""), "OpenRouter", "M"), null, `${status}`);
  }
  assert.equal(providerOutage(new Error("Cannot read properties of undefined"), "OpenRouter", "M"), null);
  assert.equal(providerOutage(Object.assign(new Error("aborted"), { name: "AbortError" }), "OpenRouter", "M"), null);
});
