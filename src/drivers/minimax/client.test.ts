/**
 * client.test.ts — MiniMax's binding to the shared OpenAI-compatible layer.
 *
 * The shared plumbing is already pinned by Qwen's test file. What is genuinely
 * MiniMax's own: M3.1 Flash can never be put into a non-reasoning state and takes its
 * depth as a top-level `reasoning_effort`, while M3 takes the nested `thinking: {type}`
 * field both ways — and either way the field is sent explicitly, because the provider's
 * own default is the deepest setting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { minimaxProvider, reasoningFields } from "./client.js";
import { DEFAULT_MODEL, M31F, M3, MODELS, contextWindow, normalize, price, thinkLevels } from "./manifest.js";
import type { ModelRequest } from "../types.js";

const base: ModelRequest = { system: "S", messages: [] };
const ALL = MODELS.map((m) => m.id);

test("the default is M3.1 Flash, and the retired M2.x models are not offered", () => {
  assert.equal(DEFAULT_MODEL, M31F);
  assert.deepEqual(ALL, [M31F, M3]);
});

test("M3.1 Flash can never be normalized into a non-reasoning state", () => {
  assert.equal(normalize({ model: M31F, thinking: false, effort: "high" }).thinking, true);
  for (const level of thinkLevels(M31F)) {
    assert.equal(level.thinking, true, `"${level.label}" claims to be a non-reasoning rung`);
  }
});

test("M3.1 Flash offers the five effort rungs, lightest first", () => {
  assert.deepEqual(
    thinkLevels(M31F).map((l) => l.effort),
    ["low", "medium", "high", "xhigh", "max"],
  );
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(normalize({ model: M31F, thinking: true, effort }).effort, effort);
  }
});

test("M3 genuinely offers both states, and no effort dial", () => {
  assert.deepEqual(
    thinkLevels(M3).map((l) => l.thinking),
    [false, true],
  );
  assert.equal(normalize({ model: M3, thinking: false, effort: "max" }).thinking, false);
  assert.equal(normalize({ model: M3, thinking: true, effort: "max" }).thinking, true);
  assert.equal(normalize({ model: M3, thinking: true, effort: "max" }).effort, "high");
});

test("M3.1 Flash is sent reasoning_effort and never a thinking field", () => {
  assert.deepEqual(reasoningFields({ model: M31F, thinking: true, effort: "xhigh" }), { reasoning_effort: "xhigh" });
  // Even a stored "off" cannot reach the wire: the provider rejects it.
  const off = reasoningFields({ model: M31F, thinking: false, effort: "high" });
  assert.equal("thinking" in off, false);
  assert.deepEqual(off, { reasoning_effort: "high" });
});

test("an internal call with no config reasons at the lightest rung, not the provider's deepest default", () => {
  assert.deepEqual(reasoningFields(undefined), { reasoning_effort: "low" });
});

test("M3's thinking is sent EXPLICITLY, in both directions", () => {
  assert.deepEqual(reasoningFields({ model: M3, thinking: false, effort: "high" }), { thinking: { type: "disabled" } });
  assert.deepEqual(reasoningFields({ model: M3, thinking: true, effort: "high" }), { thinking: { type: "adaptive" } });
});

test("an unknown model id falls back to the default rather than reaching the wire", () => {
  assert.equal(normalize({ model: "minimax-nightly", thinking: false, effort: "high" }).model, DEFAULT_MODEL);
  // A conversation saved on a retired model lands on the default too.
  assert.equal(normalize({ model: "MiniMax-M2.7", thinking: true, effort: "high" }).model, DEFAULT_MODEL);
});

test("M3's window stays clear of the 512K tier its price table quotes", () => {
  assert.ok(contextWindow(M3) < 512_000);
  assert.ok(contextWindow(M31F) < 512_000);
});

test("prices match MiniMax's published list", () => {
  assert.deepEqual(price(M31F), { cacheHit: 0.015, cacheMiss: 0.15, output: 0.6 });
  assert.deepEqual(price(M3), { cacheHit: 0.06, cacheMiss: 0.3, output: 1.2 });
});

test("every model discounts cached input, and reports the split", () => {
  for (const choice of MODELS) {
    const p = price(choice.id);
    assert.ok(p.cacheHit < p.cacheMiss, `${choice.id} should discount cached input`);
  }
  assert.equal(typeof minimaxProvider.cacheSplit, "function");
});

test("cached input is read from prompt_tokens_details, as MiniMax's OpenAI-style responses report it", () => {
  assert.deepEqual(minimaxProvider.cacheSplit!({ prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 800 } }), { hit: 800, miss: 400 });
  assert.equal(minimaxProvider.cacheSplit!({ prompt_tokens: 300 }), undefined);
});

test("MiniMax's buffered ceiling is actually sent", () => {
  assert.equal(buildBody(minimaxProvider, base, minimaxProvider.bufferedMaxTokens).max_tokens, 8_000);
});

test("the base URL points at MiniMax's own platform by default", () => {
  assert.equal(minimaxProvider.baseUrl, "https://api.minimax.io/v1");
  assert.equal(minimaxProvider.apiKeyEnv, "MINIMAX_API_KEY");
});

test("no config can settle on a rung its model's /think does not list", () => {
  for (const model of ALL) {
    for (const thinking of [true, false]) {
      const moved = normalize({ model, thinking, effort: "high" });
      assert.ok(
        thinkLevels(moved.model).some((l) => l.thinking === moved.thinking && l.effort === moved.effort),
        `${model}: thinking=${thinking} landed on ${JSON.stringify(moved)}, which is not listed`,
      );
    }
  }
});
