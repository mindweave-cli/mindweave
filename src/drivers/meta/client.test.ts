/**
 * client.test.ts — Meta's binding to the shared OpenAI-compatible layer.
 *
 * The shared plumbing is already pinned by Qwen's test file. What is genuinely
 * Meta's own: Muse Spark sends NO reasoning field at all (there isn't one to
 * send), and the contributor tier is a real, separate, non-default model id
 * whose price gap is real precisely because the data trade behind it is real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "../openaiCompat/wire.js";
import { metaProvider, reasoningFields } from "./client.js";
import {
  DEFAULT_MODEL,
  MODELS,
  MUSE_SPARK_12,
  MUSE_SPARK_12_CONTRIBUTOR,
  MUSE_SPARK_13,
  MUSE_SPARK_13_CONTRIBUTOR,
  normalize,
  price,
  thinkLevels,
} from "./manifest.js";
import type { ModelRequest } from "../types.js";

const base: ModelRequest = { system: "S", messages: [] };

test("an effort is SENT on every call, because the model reasons whether we ask or not", () => {
  // This driver once declared Muse Spark had no reasoning dial and sent nothing. The
  // model reasons regardless, so what that bought was reasoning at a depth nobody
  // chose, on every call, with nothing for the user to turn.
  const body = buildBody(metaProvider, { ...base, model: { model: MUSE_SPARK_13, thinking: true, effort: "low" } });
  assert.equal(body.reasoning_effort, "low");
  // No `thinking` field: this API expresses the whole selection through the one
  // parameter, and there is no off position to express.
  assert.equal("thinking" in body, false);
  // A call that names no model still says what depth it wants.
  assert.deepEqual(reasoningFields(undefined), { reasoning_effort: "high" });
});

test("no rung claims to skip reasoning, because `none` is a 400", () => {
  for (const model of MODELS.map((m) => m.id)) {
    const off = thinkLevels(model).filter((l) => !l.thinking);
    assert.deepEqual(off, [], `${model} offers a rung the API refuses: ${JSON.stringify(off)}`);
  }
});

test("a config from another provider is snapped onto a rung this API accepts", () => {
  // `max` is real on Standard-tier 1.3 (confirmed against Meta's own reasoning docs),
  // but Contributor-tier and 1.2 have never heard of it and must snap it down.
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    for (const model of [MUSE_SPARK_13, MUSE_SPARK_13_CONTRIBUTOR, MUSE_SPARK_12]) {
      const n = normalize({ model, thinking: false, effort });
      assert.equal(n.thinking, true, `${model}/${effort} left thinking off on a model that cannot skip it`);
      assert.ok(
        thinkLevels(model).some((l) => l.effort === n.effort),
        `${model}/${effort} normalized to a rung the ladder does not offer: ${n.effort}`,
      );
    }
  }
  // The one rung that actually exists, scoped to the one id it exists on.
  assert.equal(normalize({ model: MUSE_SPARK_13, thinking: true, effort: "max" }).effort, "max");
  assert.equal(normalize({ model: MUSE_SPARK_13_CONTRIBUTOR, thinking: true, effort: "max" }).effort, "xhigh");
  assert.equal(normalize({ model: MUSE_SPARK_12, thinking: true, effort: "max" }).effort, "xhigh");
  assert.equal(normalize({ model: MUSE_SPARK_13, thinking: true, effort: "medium" }).effort, "low");
});

test("the default is Standard, never the contributor tier — sharing your data is a choice, not a fallback", () => {
  assert.equal(DEFAULT_MODEL, MUSE_SPARK_13);
  assert.equal(normalize({ model: "unknown-model", thinking: true, effort: "high" }).model, MUSE_SPARK_13);
});

test("the contributor tier is real, separate, and dramatically cheaper — the trade is genuine both ways", () => {
  // Asserted on BOTH generations, because the tier is a property of the provider
  // rather than of one model: a new Spark that quietly shipped without its
  // contributor id, or with a discount that was no longer a discount, would be a
  // different bargain offered under the same words.
  for (const [standardId, contributorId] of [
    [MUSE_SPARK_13, MUSE_SPARK_13_CONTRIBUTOR],
    [MUSE_SPARK_12, MUSE_SPARK_12_CONTRIBUTOR],
  ]) {
    const standard = price(standardId!);
    const contributor = price(contributorId!);
    assert.ok(contributor.cacheMiss < standard.cacheMiss / 5, `${contributorId} input should be far cheaper`);
    assert.ok(contributor.output < standard.output / 5, `${contributorId} output should be far cheaper`);
    // Both models are genuinely offered, not one hidden behind the other.
    assert.ok(MODELS.some((m) => m.id === standardId));
    assert.ok(MODELS.some((m) => m.id === contributorId));
  }
});

test("1.3 ships at 1.2's rates, so the newer model is not the dearer one", () => {
  assert.deepEqual(price(MUSE_SPARK_13), price(MUSE_SPARK_12));
  assert.deepEqual(price(MUSE_SPARK_13_CONTRIBUTOR), price(MUSE_SPARK_12_CONTRIBUTOR));
});

test("thinking never turns off — it is not something this provider can be asked for", () => {
  // The inverse of what this test used to assert, and the correction is the point:
  // it pinned "thinking is always false" against a model that has never stopped
  // reasoning, so the belief and the wire had been disagreeing from the start.
  for (const choice of MODELS) {
    for (const level of thinkLevels(choice.id)) {
      assert.equal(level.thinking, true, choice.id);
    }
    assert.equal(normalize({ model: choice.id, thinking: false, effort: "high" }).thinking, true, choice.id);
  }
});

test("Meta's buffered ceiling is actually sent", () => {
  assert.equal(buildBody(metaProvider, base, metaProvider.bufferedMaxTokens).max_tokens, 8_000);
});

test("the base URL points at Meta's Model API by default", () => {
  assert.equal(metaProvider.baseUrl, "https://api.meta.ai/v1");
  assert.equal(metaProvider.apiKeyEnv, "MODEL_API_KEY");
});
