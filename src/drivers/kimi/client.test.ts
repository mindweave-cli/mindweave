/**
 * client.test.ts — Kimi's binding to the shared OpenAI-compatible layer.
 *
 * The shared stream plumbing is already tested through Qwen; what is tested here
 * is what makes Kimi different, and the difference is unusually sharp: this one
 * lineup carries THREE reasoning surfaces, and sending the wrong one is a rejected
 * request rather than a soft downgrade.
 *
 *   - K3 takes `reasoning_effort` and has no `thinking` parameter at all.
 *   - K2.7 Code and its HighSpeed tier take `thinking` but only ever `"enabled"`.
 *   - K2.6 takes `thinking` both ways, and defaults to ENABLED.
 *
 * No network, no API key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { cacheSplit, kimiProvider, reasoningFields } from "./client.js";
import { K26, K27_CODE, K27_CODE_HIGHSPEED, K3, MODELS, normalize, surfaceOf, thinkLevels } from "./manifest.js";
import type { Effort, ModelRequest } from "../types.js";

const base: ModelRequest = { system: "SYSTEM", messages: [] };
const ALL = MODELS.map((m) => m.id);
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// ── The three reasoning surfaces ──────────────────────────────────────────────

test("K3 takes an effort rung and NO thinking parameter", () => {
  const fields = reasoningFields({ model: K3, thinking: true, effort: "max" });
  assert.deepEqual(fields, { reasoning_effort: "max" });
  assert.ok(!("thinking" in fields), "K3 does not know the `thinking` parameter");
});

test("K2.7 Code (both serving tiers) is always sent enabled — `disabled` is a rejected request", () => {
  // Even when the config says otherwise. `normalize` should never produce that,
  // but the renderer must not be the thing that trusts it.
  for (const model of [K27_CODE, K27_CODE_HIGHSPEED]) {
    for (const thinking of [true, false]) {
      assert.deepEqual(reasoningFields({ model, thinking, effort: "high" }), {
        thinking: { type: "enabled" },
      });
    }
  }
});

test("thinking OFF is sent EXPLICITLY on the models that allow it", () => {
  // K2.6 defaults to ENABLED, so omitting the field means paying for reasoning the
  // UI discards on every internal call.
  for (const model of [K26]) {
    assert.deepEqual(reasoningFields({ model, thinking: false, effort: "high" }), {
      thinking: { type: "disabled" },
    });
    assert.deepEqual(reasoningFields({ model, thinking: true, effort: "high" }), {
      thinking: { type: "enabled" },
    });
  }
});

test("a request with no model config still renders the DEFAULT model's surface", () => {
  // The shared layer falls back to `defaultModel`; if this used a different
  // fallback the body could name one model and carry another's parameters.
  const fields = reasoningFields(undefined);
  const expected = reasoningFields({ model: kimiProvider.defaultModel, thinking: false, effort: "high" });
  assert.deepEqual(fields, expected);
});

test("the model named in the body always matches the surface its fields came from", () => {
  for (const model of ALL) {
    const body = buildBody(kimiProvider, { ...base, model: { model, thinking: true, effort: "high" } });
    assert.equal(body.model, model);
    const hasEffort = "reasoning_effort" in body;
    assert.equal(hasEffort, surfaceOf(model).takesEffort, `${model}: wrong reasoning shape for its surface`);
    assert.equal("thinking" in body, !surfaceOf(model).takesEffort, `${model}: wrong reasoning shape`);
  }
});

test("the buffered ceiling is sent, so core's reservation is not fiction", () => {
  // A manifest that declares `bufferedOutputTokens` while the request sends none
  // lets the provider's much larger default apply, overrunning the room core set
  // aside below the context window.
  assert.equal(buildBody(kimiProvider, base, kimiProvider.bufferedMaxTokens).max_tokens, 8_000);
  assert.equal(buildBody(kimiProvider, base).max_tokens, undefined);
});

// ── Usage ─────────────────────────────────────────────────────────────────────

test("the cache split reads either the nested or the flat field", () => {
  assert.deepEqual(cacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 700 } }), {
    hit: 700,
    miss: 300,
  });
  assert.deepEqual(cacheSplit({ prompt_tokens: 1000, cached_tokens: 400 }), { hit: 400, miss: 600 });
  assert.equal(cacheSplit({ prompt_tokens: 1000 }), undefined);
});

// ── Model rules ───────────────────────────────────────────────────────────────

test("normalize forces thinking ON for the models that cannot stop reasoning", () => {
  for (const model of [K3, K27_CODE]) {
    for (const effort of EFFORTS) {
      assert.equal(normalize({ model, thinking: false, effort }).thinking, true, `${model} at ${effort}`);
    }
  }
});

test("normalize clamps K3 to the three rungs it knows, never the shared five", () => {
  // `medium` and `xhigh` are in the shared type but not in K3's vocabulary, and
  // sending one is a rejected request rather than a downgrade.
  const accepted = new Set(["low", "high", "max"]);
  for (const effort of EFFORTS) {
    const got = normalize({ model: K3, thinking: true, effort }).effort;
    assert.ok(accepted.has(got), `${effort} became ${got}, which K3 does not accept`);
  }
  // The two it does know survive untouched.
  assert.equal(normalize({ model: K3, thinking: true, effort: "low" }).effort, "low");
  assert.equal(normalize({ model: K3, thinking: true, effort: "max" }).effort, "max");
});

test("K2.7 Code offers exactly one reasoning level, and it is honest about it", () => {
  const levels = thinkLevels(K27_CODE);
  assert.equal(levels.length, 1);
  assert.equal(levels[0]!.thinking, true);
});

test("normalize keeps every advertised reasoning level intact", () => {
  for (const model of ALL) {
    for (const level of thinkLevels(model)) {
      const config = { model, thinking: level.thinking, effort: level.effort };
      assert.deepEqual(normalize(config), config, `${model}: "${level.label}" was altered`);
    }
  }
});

test("switching between any two models leaves a config the target accepts", () => {
  // `/model` carries the reasoning intent across, and this lineup is the one where
  // that most easily produces something illegal — a no-thinking setting landing on
  // a model that cannot stop, or a `medium` rung landing on K3.
  for (const from of ALL) {
    for (const level of thinkLevels(from)) {
      for (const to of ALL) {
        const moved = normalize({ model: to, thinking: level.thinking, effort: level.effort });
        assert.deepEqual(normalize(moved), moved, `${from} "${level.label}" → ${to} is unstable`);
        assert.ok(
          thinkLevels(to).some((l) => l.thinking === moved.thinking && l.effort === moved.effort),
          `${from} "${level.label}" → ${to} landed on ${JSON.stringify(moved)}, which ${to} does not offer`,
        );
      }
    }
  }
});

test("an unknown model id falls back rather than reaching the wire", () => {
  assert.equal(normalize({ model: "kimi-imaginary", thinking: true, effort: "high" }).model, K26);
  for (const model of ALL) {
    assert.equal(normalize({ model, thinking: true, effort: "high" }).model, model, `${model} was coerced away`);
  }
});
