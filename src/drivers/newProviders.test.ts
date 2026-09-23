/**
 * newProviders.test.ts — xAI, Mistral, Groq and Cerebras.
 *
 * The shared wire layer's plumbing is tested through Qwen; these four are bindings,
 * so what is tested is what each one gets WRONG if nobody pins it. Two themes run
 * across all of them:
 *
 *   - `reasoning_effort` is served by SOME models and rejected by the rest, in every
 *     one of these lineups. Sending it to a model without the dial is a 400.
 *   - Groq and Cerebras collapse the effort ladder to two states. Forwarding the
 *     shared rung would send values their APIs reject.
 *
 * Groq and Cerebras are also the first DISCOVERED providers, so the list-shaping and
 * the ownership claims are pinned here too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody } from "./openaiCompat/wire.js";
import * as xai from "./xai/manifest.js";
import * as mistral from "./mistral/manifest.js";
import * as groq from "./groq/manifest.js";
import * as cerebras from "./cerebras/manifest.js";
import { reasoningFields as xaiReasoning, extraStop as xaiStop, xaiProvider } from "./xai/client.js";
import { reasoningFields as mistralReasoning, mistralProvider } from "./mistral/client.js";
import { reasoningFields as groqReasoning, groqProvider, toChoices as groqChoices } from "./groq/client.js";
import { reasoningFields as cerebrasReasoning, cerebrasProvider, toChoices as cerebrasChoices } from "./cerebras/client.js";
import type { DriverManifest, Effort, ModelRequest } from "./types.js";

const base: ModelRequest = { system: "S", messages: [] };
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** The four manifests, so the shared invariants run over all of them. */
const NEW: { name: string; m: DriverManifest }[] = [
  { name: "xai", m: xai.xaiManifest },
  { name: "mistral", m: mistral.mistralManifest },
  { name: "groq", m: groq.groqManifest },
  { name: "cerebras", m: cerebras.cerebrasManifest },
];

// ── Invariants every one of them must hold ────────────────────────────────────

test("every advertised reasoning level survives normalize unchanged", () => {
  for (const { name, m } of NEW) {
    for (const choice of m.models) {
      for (const level of m.thinkLevels(choice.id)) {
        const config = { model: choice.id, thinking: level.thinking, effort: level.effort };
        assert.deepEqual(m.normalize(config), config, `${name}/${choice.id}: "${level.label}" was altered`);
      }
    }
  }
});

test("no config can settle on a rung its model's /think does not list", () => {
  for (const { name, m } of NEW) {
    for (const choice of m.models) {
      for (const effort of EFFORTS) {
        for (const thinking of [true, false]) {
          const moved = m.normalize({ model: choice.id, thinking, effort });
          assert.ok(
            m.thinkLevels(moved.model).some((l) => l.thinking === moved.thinking && l.effort === moved.effort),
            `${name}/${choice.id}: ${thinking}/${effort} landed on ${JSON.stringify(moved)}, which is not listed`,
          );
        }
      }
    }
  }
});

test("a model with no reasoning dial can never be put into a thinking state", () => {
  // The 400 this prevents: `reasoning_effort` sent to a model that does not take it.
  for (const { name, m } of NEW) {
    for (const choice of m.models) {
      const takes =
        name === "xai"
          ? xai.takesEffort(choice.id)
          : name === "mistral"
            ? mistral.takesEffort(choice.id)
            : name === "groq"
              ? groq.takesEffort(choice.id)
              : cerebras.takesEffort(choice.id);
      if (takes) continue;
      assert.equal(
        m.normalize({ model: choice.id, thinking: true, effort: "high" }).thinking,
        false,
        `${name}/${choice.id} has no dial and must not normalize to thinking`,
      );
    }
  }
});

// ── xAI ───────────────────────────────────────────────────────────────────────

test("xAI sends `none` ONLY to the model that can switch reasoning off", () => {
  assert.deepEqual(xaiReasoning({ model: xai.GROK_43, thinking: true, effort: "high" }), {
    reasoning_effort: "high",
  });
  assert.deepEqual(xaiReasoning({ model: xai.GROK_43, thinking: false, effort: "low" }), {
    reasoning_effort: "none",
  });
  // 4.5-4.7 always reason: they get a depth, never an off switch.
  for (const model of [xai.GROK_47, xai.GROK_46, xai.GROK_45]) {
    assert.deepEqual(xaiReasoning({ model, thinking: true, effort: "medium" }), { reasoning_effort: "medium" }, model);
    assert.deepEqual(xaiReasoning({ model, thinking: false, effort: "low" }), { reasoning_effort: "high" }, model);
  }
});

test("an old Grok 4.5/4.6 config keeps the depth it always ran at", () => {
  // Before 2.5.1 these models had one level (thinking off, effort low) and nothing was
  // sent, so xAI ran them at its default, `high`. Reading that config back must not
  // turn into `low` on the wire — a silent drop in quality nobody chose.
  for (const model of [xai.GROK_46, xai.GROK_45, xai.GROK_47]) {
    const config = xai.normalize({ model, thinking: false, effort: "low" });
    assert.deepEqual(config, { model, thinking: true, effort: "high" }, model);
    assert.equal(xaiReasoning(config).reasoning_effort, "high", model);
  }
});

test("xAI never sends a rung the model does not take", () => {
  // `max` is no xAI model's; `xhigh` is 4.6 and later only (4.5 treats it as `high`,
  // so it is not offered there); `none` is 4.3's alone. These are the pairings a
  // /model switch would otherwise produce.
  const accepted: Record<string, Set<string>> = {
    [xai.GROK_43]: new Set(["none", "low", "medium", "high"]),
    [xai.GROK_45]: new Set(["low", "medium", "high"]),
    [xai.GROK_46]: new Set(["low", "medium", "high", "xhigh"]),
    [xai.GROK_47]: new Set(["low", "medium", "high", "xhigh"]),
  };
  for (const [model, ok] of Object.entries(accepted)) {
    for (const effort of EFFORTS) {
      for (const thinking of [true, false]) {
        const sent = xaiReasoning(xai.normalize({ model, thinking, effort })).reasoning_effort;
        assert.ok(ok.has(sent as string), `${model} ${thinking}/${effort} produced ${String(sent)}`);
      }
    }
  }
});

test("xAI's own finish reason is mapped rather than left to the default", () => {
  assert.equal(xaiStop("end_turn"), "end");
  assert.equal(xaiStop("stop"), undefined);
});

test("xAI's buffered ceiling is actually sent", () => {
  assert.equal(buildBody(xaiProvider, base, xaiProvider.bufferedMaxTokens).max_tokens, 8_000);
});

// ── Mistral ───────────────────────────────────────────────────────────────────

test("Mistral sends a root-level effort only on the two models that serve one", () => {
  for (const model of [mistral.MEDIUM, mistral.SMALL]) {
    assert.deepEqual(mistralReasoning({ model, thinking: true, effort: "high" }), { reasoning_effort: "high" }, model);
    assert.deepEqual(mistralReasoning({ model, thinking: false, effort: "low" }), { reasoning_effort: "none" }, model);
  }
  for (const model of [mistral.LARGE, mistral.MINISTRAL_8B]) {
    assert.deepEqual(mistralReasoning({ model, thinking: true, effort: "high" }), {}, model);
  }
});

test("Mistral prices cached input at a tenth, because that is what it charges", () => {
  // This file once asserted the OPPOSITE — that Mistral published no cached rate —
  // which both over-stated cost and, far worse, left the token meter counting every
  // step's whole prompt as fresh.
  for (const choice of mistral.MODELS) {
    const p = mistral.price(choice.id);
    assert.ok(p.cacheHit < p.cacheMiss, `${choice.id} should discount cached input`);
    assert.ok(Math.abs(p.cacheHit - p.cacheMiss / 10) < 1e-9, `${choice.id} should be a tenth, got ${p.cacheHit}`);
  }
  assert.equal(typeof mistralProvider.cacheSplit, "function", "Mistral does report a cache split");
});

test("Cerebras is the one provider with NO cache discount, and says so", () => {
  // It caches for latency and bills cached input at the standard rate, so equal
  // rates here are a fact rather than an unfinished table.
  for (const choice of cerebras.MODELS) {
    const p = cerebras.price(choice.id);
    assert.equal(p.cacheHit, p.cacheMiss, `${choice.id} must not invent a discount Cerebras does not give`);
  }
  // It still reports the split, because the token COUNT needs it even when the bill does not.
  assert.equal(typeof cerebrasProvider.cacheSplit, "function");
});

test("Groq discounts cached input by half, not by the usual ninety percent", () => {
  const p = groq.price("openai/gpt-oss-120b");
  assert.ok(Math.abs(p.cacheHit - p.cacheMiss / 2) < 1e-9, `expected half, got ${p.cacheHit} of ${p.cacheMiss}`);
});

test("EVERY compat provider reports a cache split — the meter depends on it", () => {
  // The gap this closes: a provider with no `cacheSplit` has its whole prompt counted
  // as fresh on EVERY step, so a five-step turn reports roughly five times the tokens
  // it used. That was live for Mistral, Groq and Cerebras, all three of which do cache.
  // A new compat provider must either wire this or be a genuinely non-caching API.
  for (const [name, provider] of [
    ["xai", xaiProvider],
    ["mistral", mistralProvider],
    ["groq", groqProvider],
    ["cerebras", cerebrasProvider],
  ] as const) {
    assert.equal(typeof provider.cacheSplit, "function", `${name} must report its cache split`);
  }
});

test("the shared cache split derives the miss side rather than trusting a second field", async () => {
  const { standardCacheSplit } = await import("./openaiCompat/wire.js");
  assert.deepEqual(standardCacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } }), {
    hit: 900,
    miss: 100,
  });
  // Nothing reported is not the same as nothing cached: returning undefined lets the
  // caller fall back to counting the prompt as fresh.
  assert.equal(standardCacheSplit({ prompt_tokens: 1000 }), undefined);
  assert.equal(standardCacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } }), undefined);
});

// ── Groq and Cerebras: the two-state ladder ───────────────────────────────────

test("Groq and Cerebras send only the two values their APIs accept", () => {
  // Groq documents `none` or `default` and rejects the graded ladder outright, so
  // the shared rung must NOT be forwarded.
  const accepted = new Set(["none", "default"]);
  for (const [name, fields, model] of [
    ["groq", groqReasoning, "openai/gpt-oss-120b"],
    ["cerebras", cerebrasReasoning, "gpt-oss-120b"],
  ] as const) {
    for (const effort of EFFORTS) {
      const sent = fields({ model, thinking: true, effort }).reasoning_effort;
      assert.ok(accepted.has(sent as string), `${name}: effort ${effort} produced ${String(sent)}`);
    }
    assert.equal(fields({ model, thinking: false, effort: "high" }).reasoning_effort, "none", name);
  }
});

test("Groq and Cerebras send nothing at all to a model without the dial", () => {
  assert.deepEqual(groqReasoning({ model: "llama-3.3-70b-versatile", thinking: true, effort: "high" }), {});
  assert.deepEqual(cerebrasReasoning({ model: "llama-3.3-70b", thinking: true, effort: "high" }), {});
});

// ── Discovered lists ──────────────────────────────────────────────────────────

test("both discovered providers declare a discovery function and an ownership claim", () => {
  for (const m of [groq.groqManifest, cerebras.cerebrasManifest]) {
    assert.equal(typeof m.discoverModels, "function", `${m.id} must be discoverable`);
    assert.equal(typeof m.ownsModel, "function", `${m.id} must recognise its own ids without a list`);
  }
  // And the static providers must NOT have acquired either by accident.
  for (const m of [xai.xaiManifest, mistral.mistralManifest]) {
    assert.equal(m.discoverModels, undefined, `${m.id} declares a fixed lineup`);
  }
});

test("a discovered listing drops the models that are not chat models", () => {
  // Both endpoints list speech and guard models beside chat ones, and offering one
  // in /model is an entry that fails on first use.
  const choices = groqChoices([
    { id: "llama-3.3-70b-versatile", context_window: 131072 },
    { id: "whisper-large-v3" },
    { id: "meta-llama/llama-guard-4-12b" },
  ]);
  assert.deepEqual(choices.map((c) => c.id), ["llama-3.3-70b-versatile"]);
});

test("Groq's listing surfaces the real context window it reports", () => {
  const [choice] = groqChoices([{ id: "a-model", context_window: 131072 }]);
  assert.match(choice!.description, /131K context/);
  // And says something honest when the endpoint reports none.
  const [plain] = groqChoices([{ id: "b-model" }]);
  assert.equal(plain!.description, "served on Groq");
});

test("Cerebras claims no context window, because its listing reports none", () => {
  // Repeating this driver's own conservative default back as though the provider
  // had stated it would be inventing a fact.
  const [choice] = cerebrasChoices([{ id: "gpt-oss-120b" }]);
  assert.ok(!/context/i.test(choice!.description), `invented a context claim: ${choice!.description}`);
});

test("the two speed providers do not both claim the open models they share", () => {
  // They serve overlapping catalogues. If both claimed broadly, whichever sits
  // earlier in the registry would capture a shared id, and which endpoint a saved
  // model ran against would come down to registry order.
  const shared = ["gpt-oss-120b", "qwen3-32b", "llama-3.3-70b-versatile"];
  for (const id of shared) {
    const claims = [groq.ownsModel(id), cerebras.ownsModel(id)].filter(Boolean);
    assert.ok(claims.length <= 1, `${id} is claimed by both speed providers`);
  }
});

test("a discovered provider does NOT coerce an unknown model id away", () => {
  // The window that matters: before discovery has run the list is the small
  // fallback, and rewriting the user's saved model there would silently change
  // their choice on every launch.
  for (const m of [groq.groqManifest, cerebras.cerebrasManifest]) {
    const kept = m.normalize({ model: "some-newly-published-model", thinking: false, effort: "low" });
    assert.equal(kept.model, "some-newly-published-model", `${m.id} discarded a model it had not discovered yet`);
  }
});

test("a STATIC provider still coerces an unknown id, as it always did", () => {
  assert.equal(xai.normalize({ model: "not-a-grok", thinking: false, effort: "low" }).model, xai.DEFAULT_MODEL);
  assert.equal(
    mistral.normalize({ model: "not-a-mistral", thinking: false, effort: "low" }).model,
    mistral.DEFAULT_MODEL,
  );
});

// ── Buffered calls must report what they spend ────────────────────────────────

test("a buffered turn carries usage, so core's own calls are not invisible", async () => {
  // The compaction summary, the session-memory notes and the web-page distillation
  // all go through the BUFFERED path. `Turn` used to have no `usage` field at all,
  // so those calls spent real tokens on the user's key that no meter ever saw.
  const { toTurn } = await import("./openaiCompat/wire.js");
  const turn = toTurn(groqProvider, {
    choices: [{ message: { content: "summary" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4000, completion_tokens: 300, total_tokens: 4300 },
  });
  assert.equal(turn.usage?.promptTokens, 4000);
  assert.equal(turn.usage?.completionTokens, 300);
});

test("a buffered turn with no reported usage says nothing rather than zero", async () => {
  // Absent and zero are different claims: one is "not reported", the other is
  // "this call was free". Reporting zero would quietly shrink the meter.
  const { toTurn } = await import("./openaiCompat/wire.js");
  const turn = toTurn(groqProvider, { choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
  assert.equal(turn.usage, undefined);
});
