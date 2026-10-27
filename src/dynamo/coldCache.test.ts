/**
 * coldCache.test.ts — microcompact when the provider's cache has expired.
 *
 * The gate on microcompaction exists because clearing an old tool body rewrites the
 * transcript, and the transcript is the cached half of the request: on a warm cache
 * that trades a cheap cached read for a 1.25x prefix rewrite. Once the entry has
 * expired there is nothing left to invalidate, so the same work becomes free — and the
 * tokens never have to be paid for again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_TTL_MS,
  COLD_COMPACT_COOLDOWN_MS,
  cacheIsDiscounted,
  cacheLifetimeFor,
  cacheLikelyCold,
  cacheStatus,
  coldCompactionLine,
  shouldCompactForCold,
} from "./contextWindow.js";

const MICRO_BAR = 40_000;
const NOW = 1_000_000_000;
const MODEL = "deepseek-v4-flash";
const OTHER = "glm-5.3-flash";
const status = (lastByModel: Record<string, number> | undefined, model = MODEL, ttlMs = CACHE_TTL_MS) =>
  cacheStatus({ now: NOW, model, lastByModel, ttlMs });

test("a warm cache is left alone even with plenty of context", () => {
  // Inside the TTL the entry still exists, so rewriting the transcript would throw away
  // a cache read and pay 1.25x to rebuild it. That is the loss the gate prevents.
  const s = status({ [MODEL]: NOW - (CACHE_TTL_MS - 1000) });
  assert.equal(s, "warm");
  assert.equal(cacheLikelyCold(s, MICRO_BAR, MICRO_BAR), false);
});

test("an expired cache with real context to save compacts", () => {
  const s = status({ [MODEL]: NOW - CACHE_TTL_MS * 3 });
  assert.equal(s, "idle");
  assert.equal(cacheLikelyCold(s, MICRO_BAR, MICRO_BAR), true);
});

test("an expired cache with almost nothing in it is not worth stripping", () => {
  // Below the floor there is little to reclaim, and clearing tool bodies early costs
  // detail the model may still want. Free is not the same as worthwhile.
  assert.equal(cacheLikelyCold("idle", 1_000, MICRO_BAR), false);
});

test("a session that has never called the model is not a cold cache", () => {
  // No call means no entry to have expired, and nothing yet worth clearing. Treating
  // this as cold would compact a fresh session on its very first turn.
  assert.equal(status(undefined), "none");
  assert.equal(status({}), "none");
  assert.equal(cacheLikelyCold("none", MICRO_BAR, MICRO_BAR), false);
});

test("the lifetime is respected", () => {
  const gap = 60_000;
  assert.equal(status({ [MODEL]: NOW - gap }, MODEL, gap * 2), "warm");
  assert.equal(status({ [MODEL]: NOW - gap }, MODEL, gap / 2), "idle");
});

test("switching models starts cold, however recently the other model ran", () => {
  // Providers cache per model. The previous model's copy of the conversation is no use to the
  // new one, so its request pays for the whole history, and rewriting the history first is free.
  const s = status({ [OTHER]: NOW - 1000 });
  assert.equal(s, "switched");
  assert.equal(cacheLikelyCold(s, MICRO_BAR, MICRO_BAR), true);
});

test("returning to a model whose cache is still warm is warm", () => {
  // The old model kept its copy, so rewriting history now would throw it away.
  assert.equal(status({ [MODEL]: NOW - 1000, [OTHER]: NOW - 500 }), "warm");
});

test("each provider's own cache lifetime decides when its cache is gone", () => {
  // Anthropic keeps an entry five minutes, GLM about fifteen (measured), OpenAI about thirty, Groq two
  // hours. A provider that states nothing gets the long default, which errs toward not rewriting.
  const minutes = (m: number) => m * 60_000;
  assert.equal(cacheLifetimeFor("claude-sonnet-5-5"), minutes(5));
  assert.equal(cacheLifetimeFor("glm-5.3-flash"), minutes(15));
  assert.equal(cacheLifetimeFor("gpt-5.6-terra"), minutes(30));
  assert.equal(cacheLifetimeFor("openai/gpt-oss-120b"), 2 * 60 * 60_000);
  assert.equal(cacheLifetimeFor("deepseek-v4-flash"), CACHE_TTL_MS);
  assert.equal(cacheLifetimeFor("gemini-3.7-flash"), CACHE_TTL_MS);
  // Twenty idle minutes is gone for GLM and still warm for DeepSeek.
  assert.equal(cacheStatus({ now: NOW, model: "glm-5.3-flash", lastByModel: { "glm-5.3-flash": NOW - minutes(20) }, ttlMs: cacheLifetimeFor("glm-5.3-flash") }), "idle");
  assert.equal(cacheStatus({ now: NOW, model: "deepseek-v4-flash", lastByModel: { "deepseek-v4-flash": NOW - minutes(20) }, ttlMs: cacheLifetimeFor("deepseek-v4-flash") }), "warm");
});

test("the environment variable overrides every provider's lifetime", () => {
  const before = process.env.MINDWEAVE_CACHE_TTL_MS;
  process.env.MINDWEAVE_CACHE_TTL_MS = "1234";
  try {
    assert.equal(cacheLifetimeFor("claude-sonnet-5-5"), 1234);
    assert.equal(cacheLifetimeFor("glm-5.3-flash"), 1234);
  } finally {
    if (before === undefined) delete process.env.MINDWEAVE_CACHE_TTL_MS;
    else process.env.MINDWEAVE_CACHE_TTL_MS = before;
  }
});

test("a provider that does not discount cached input gains nothing from timing", () => {
  assert.equal(cacheIsDiscounted("deepseek-v4-flash"), true);
  assert.equal(cacheIsDiscounted("claude-sonnet-5-5"), true);
  // Cerebras charges a hit what it charges a miss; a local Ollama model charges nothing.
  assert.equal(cacheIsDiscounted("gpt-oss-120b"), false);
  assert.equal(cacheIsDiscounted("ollama:qwen3:0.6b"), false);
});

const compactArgs = { status: "idle" as const, used: MICRO_BAR, microBar: MICRO_BAR, discounted: true, idleMs: 3 * 60 * 60_000, now: NOW };

test("a big conversation with a gone cache is compacted from the notes", () => {
  assert.equal(shouldCompactForCold(compactArgs), true);
  assert.equal(shouldCompactForCold({ ...compactArgs, status: "switched" }), true);
});

test("a warm cache, a small conversation, or an undiscounted provider is left alone", () => {
  assert.equal(shouldCompactForCold({ ...compactArgs, status: "warm" }), false);
  assert.equal(shouldCompactForCold({ ...compactArgs, status: "none" }), false);
  assert.equal(shouldCompactForCold({ ...compactArgs, used: MICRO_BAR - 1 }), false);
  assert.equal(shouldCompactForCold({ ...compactArgs, discounted: false }), false);
});

test("a short break is not worth losing detail over, even where the cache is already gone", () => {
  // Anthropic keeps an entry five minutes, so a six minute pause finds it gone. Clearing old tool results is
  // still free then; compacting the conversation waits for a real break.
  assert.equal(shouldCompactForCold({ ...compactArgs, idleMs: 6 * 60_000 }), false);
  assert.equal(shouldCompactForCold({ ...compactArgs, idleMs: 20 * 60_000 }), true);
  // A model switch has no idle time to wait out.
  assert.equal(shouldCompactForCold({ ...compactArgs, status: "switched", idleMs: 0 }), true);
});

test("compaction for a gone cache does not repeat in quick succession", () => {
  // Someone moving between models should not lose detail on every switch.
  assert.equal(shouldCompactForCold({ ...compactArgs, lastColdCompactAt: NOW - 1000 }), false);
  assert.equal(shouldCompactForCold({ ...compactArgs, lastColdCompactAt: NOW - COLD_COMPACT_COOLDOWN_MS - 1 }), true);
});

test("the chat line says why, for an idle break and for a model switch", () => {
  assert.match(coldCompactionLine("idle", MODEL, 25 * 60_000), /expired after 25 minutes idle/);
  assert.match(coldCompactionLine("switched", MODEL, 0), /deepseek-v4-flash has no cached copy/);
  assert.match(coldCompactionLine("idle", MODEL, 0), /expired after 1 minutes idle|expired after 1 minute/);
});

/**
 * clearIsWorthIt — the cache economics of a microcompaction.
 *
 * Clearing rewrites the cached prefix from the first message it changes, so it is only free
 * when there is no cache to lose. On a warm one it pays when what it saves on the next calls, at
 * the cached read price, is more than the rewrite costs at the full one: the prices decide, and
 * they differ by an order of magnitude between providers. These pin the ways a clear earns its keep.
 */
import { clearIsWorthIt } from "./contextWindow.js";

const AUTO_BAR = 100_000;
/** A cached read at 10% of input and a 25% write premium. */
const READS_AT_10 = { cacheHit: 0.1, cacheMiss: 1, cacheWrite: 1.25 };
/** A cached read at 2% of input, no write premium. */
const READS_AT_2 = { cacheHit: 0.02, cacheMiss: 1 };

test("a clear that reclaims almost nothing is refused on a warm cache", () => {
  // The defect: fire on the bar, clear 2K out of 40K, and pay to rewrite the other 38K
  // at 1.25x. That is a loss dressed as an optimization.
  const worth = clearIsWorthIt({ before: 40_000, after: 38_000, cold: false, autoBar: AUTO_BAR, rewritten: 38_000, price: READS_AT_10 });
  assert.equal(worth, false);
});

test("a clear that reclaims a large fraction is taken", () => {
  const worth = clearIsWorthIt({ before: 40_000, after: 20_000, cold: false, autoBar: AUTO_BAR, rewritten: 20_000, price: READS_AT_10 });
  assert.equal(worth, true);
});

test("any reclaim is worth it once the cache is cold", () => {
  // Nothing left to invalidate, so even a small clear is pure profit — and those tokens
  // never have to be paid for again.
  const worth = clearIsWorthIt({ before: 40_000, after: 39_000, cold: true, autoBar: AUTO_BAR, rewritten: 39_000, price: READS_AT_2 });
  assert.equal(worth, true);
});

test("near the autocompact bar, fitting beats saving", () => {
  // A request that does not fit cannot be sent at any price, and clearing here is what
  // defers a far more expensive summarization pass.
  const worth = clearIsWorthIt({ before: 95_000, after: 94_000, cold: false, autoBar: AUTO_BAR, rewritten: 94_000, price: READS_AT_2 });
  assert.equal(worth, true);
});

test("a clear that reclaims nothing is never taken", () => {
  assert.equal(clearIsWorthIt({ before: 40_000, after: 40_000, cold: true, autoBar: AUTO_BAR, rewritten: 0, price: READS_AT_2 }), false);
  assert.equal(clearIsWorthIt({ before: 40_000, after: 41_000, cold: true, autoBar: AUTO_BAR, rewritten: 0, price: READS_AT_2 }), false);
});

test("the same clear is right where a cached read is dear and wrong where it is nearly free", () => {
  // A 74K prompt: clearing old material reclaims 26K and makes the provider write the 25K after the
  // first change again. At a 10% read price that is about 11 calls to break even; at 2% it is about 47,
  // longer than a run is assumed to last. A fixed fraction of the prefix cannot tell these apart.
  const clear = { before: 74_000, after: 48_000, cold: false, autoBar: 150_000, rewritten: 25_000 };
  assert.equal(clearIsWorthIt({ ...clear, price: READS_AT_10 }), true);
  assert.equal(clearIsWorthIt({ ...clear, price: READS_AT_2 }), false);
});

test("what follows the first change is what is paid for, not the whole prefix", () => {
  // The same reclaim, but near the end of the conversation: almost nothing is written again.
  const clear = { before: 74_000, after: 70_000, cold: false, autoBar: 150_000, price: READS_AT_2 };
  assert.equal(clearIsWorthIt({ ...clear, rewritten: 70_000 }), false, "a clear of something old rewrites everything after it");
  assert.equal(clearIsWorthIt({ ...clear, rewritten: 1_000 }), true, "one at the very end rewrites next to nothing");
});

test("a provider that charges the same for a hit as a miss has nothing to lose by a clear", () => {
  assert.equal(
    clearIsWorthIt({ before: 40_000, after: 39_000, cold: false, autoBar: AUTO_BAR, rewritten: 39_000, price: { cacheHit: 1, cacheMiss: 1 } }),
    true,
  );
});

test("the assumed cache lifetime errs LONG, never short", () => {
  // Direction matters more than the value. Too short and we clear tool bodies while the
  // provider still holds the prefix — destroying a live entry and paying full price to
  // rewrite it, a cost that would never have been incurred. Too long and we merely miss
  // a saving. 5 minutes is only Anthropic's default tier; DeepSeek's cache persists for
  // hours and several providers publish nothing, so a short default is wrong on most of
  // the lineup.
  assert.ok(
    CACHE_TTL_MS >= 60 * 60 * 1000,
    `CACHE_TTL_MS is ${CACHE_TTL_MS}ms — short enough to force cache misses that would not have happened`,
  );
});
