/**
 * model.test.ts — the model/reasoning selection: level tables, clamping, persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

// Point the home dir at a throwaway folder BEFORE importing the module, because
// saved model configs live under `projectDir()` → `homedir()`. Without this the
// persistence tests write into the REAL ~/.mindweave/projects and leave a directory
// behind on every run — 79 of them had accumulated in one user's home before anyone
// noticed. A test that dirties the machine it runs on is a bug in the test.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "mindweave-model-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const {
  DEFAULT_MODEL_CONFIG,
  models,
  loadModelConfig,
  modelsOfProvider,
  providerOf,
  saveModelConfig,
  thinkLabel,
  thinkLevels,
  usableFallback,
  withModel,
} = await import("./model.js");
const { allProviders } = await import("../drivers/registry.js");

// ── falling back to a provider we can actually run ────────────────────────────
const KEYED = (envVar: string) => envVar === allProviders()[0]!.apiKeyEnv;

test("no fallback is offered while the current provider's key is present", () => {
  const current = allProviders()[0]!.models[0]!.id;
  assert.equal(usableFallback(current, KEYED), null);
});

test("a keyless provider falls back to one that has a key", () => {
  const keyless = allProviders().find((p) => p.apiKeyEnv !== allProviders()[0]!.apiKeyEnv);
  if (!keyless) return; // only one provider installed — nothing to fall back from
  const landed = usableFallback(keyless.models[0]!.id, KEYED);
  assert.ok(landed, "a usable provider exists and should have been offered");
  assert.equal(providerOf(landed!).id, allProviders()[0]!.id);
});

test("with no keys at all there is no fallback — the prompt is the right answer", () => {
  // Genuine first run: falling back to another keyless provider would just move the
  // problem, so the setup gate should stay.
  assert.equal(usableFallback(models()[0]!.id, () => false), null);
});

// ── provider scoping (what /provider and /model each list) ────────────────────
test("every model is offered by its own provider's list", () => {
  // If this breaks, /model stops showing the model you are currently on.
  for (const m of models()) {
    assert.ok(
      modelsOfProvider(m.id).some((c) => c.id === m.id),
      `${m.id} is missing from its own provider's model list`,
    );
  }
});

test("a provider's list contains only that provider's models", () => {
  for (const m of models()) {
    const owner = providerOf(m.id).id;
    for (const sibling of modelsOfProvider(m.id)) {
      assert.equal(providerOf(sibling.id).id, owner, `${sibling.id} leaked into ${owner}'s list`);
    }
  }
});

// A local runtime (Ollama) serves only what is pulled on the machine, so it has no fixed lineup
// to land on; /provider says so instead of switching (App.tsx, applyProvider).
const fixedLineups = () => allProviders().filter((p) => !p.local);

test("every provider serves at least one model", () => {
  // /provider switches by landing on `models[0]`, so a provider with none would be
  // selectable and then silently do nothing.
  for (const p of fixedLineups()) {
    assert.ok(p.models.length > 0, `${p.id} offers no models`);
  }
});

test("landing on a provider's first model actually puts you on that provider", () => {
  // The round trip /provider depends on: pick a provider → switch to its first model
  // → the derived provider is the one you picked.
  for (const p of fixedLineups()) {
    const landed = withModel(DEFAULT_MODEL_CONFIG, p.models[0]!.id);
    assert.equal(providerOf(landed.model).id, p.id);
  }
});

test("switching provider clamps reasoning to what the new one accepts", () => {
  // A level the target does not offer must be stepped down, not sent and rejected —
  // the shared Effort type is the union of every provider's ladder, not a permission.
  for (const p of fixedLineups()) {
    const landed = withModel({ ...DEFAULT_MODEL_CONFIG, thinking: true, effort: "max" }, p.models[0]!.id);
    const offered = thinkLevels(landed.model);
    assert.ok(
      offered.some((l) => l.thinking === landed.thinking && (!l.thinking || l.effort === landed.effort)),
      `${p.id} landed on a reasoning level it does not offer: ${landed.effort}`,
    );
  }
});

test("both DeepSeek models offer the same 3 reasoning levels", () => {
  // Flash used to be given 2. That was an assumption, not a documented limit.
  assert.equal(thinkLevels("deepseek-flash").length, 3);
  assert.equal(thinkLevels("deepseek-v4-pro").length, 3);
});

test("thinkLabel reflects the config", () => {
  assert.equal(thinkLabel({ model: "deepseek-flash", thinking: false, effort: "high" }), "Standard");
  assert.equal(thinkLabel({ model: "deepseek-flash", thinking: true, effort: "high" }), "High");
  assert.equal(thinkLabel({ model: "deepseek-flash", thinking: true, effort: "max" }), "Maximum");
  assert.equal(thinkLabel({ model: "deepseek-v4-pro", thinking: true, effort: "max" }), "Maximum");
});

test("withModel carries Maximum across Pro → Flash, because Flash has that tier too", () => {
  // Was the reverse: Flash was assumed to have no maximum tier, so this switch
  // silently demoted the user's reasoning choice. DeepSeek documents low/high/max
  // for V4 Flash as well — see the deepseek manifest's thinkLevels.
  const proMax = { model: "deepseek-v4-pro", thinking: true, effort: "max" } as const;
  const onFlash = withModel(proMax, "deepseek-flash");
  assert.equal(onFlash.model, "deepseek-flash");
  assert.equal(onFlash.thinking, true);
  assert.equal(onFlash.effort, "max"); // preserved, not clamped
});

test("save → load roundtrips the config; missing file falls back to default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mindweave-model-"));
  try {
    // Nothing saved → default.
    const fresh = await loadModelConfig(dir);
    assert.deepEqual(fresh, DEFAULT_MODEL_CONFIG);

    // A model with no sunset date, deliberately — this is testing the round trip itself,
    // not a specific model's lifetime. `deepseek-v4-pro` was here until its own `until`
    // passed in real time and load's normalisation correctly moved it to v4.1 Flash,
    // which made a persistence test fail for a reason that had nothing to do with
    // persistence.
    const cfg = { model: "deepseek-flash", thinking: true, effort: "max" } as const;
    await saveModelConfig(dir, cfg);
    assert.deepEqual(await loadModelConfig(dir), cfg);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("thinking stays OFF by default — it costs tokens and is the user's call", () => {
  // Over-narration is fixed by not emitting deliberation (narrationBudget + the prompt
  // rule), NOT by paying for a reasoning channel to hide it in.
  assert.equal(DEFAULT_MODEL_CONFIG.thinking, false);
});

test("a model saved under DeepSeek's earlier Flash id opens on the current one", async () => {
  // DeepSeek's docs now call it `deepseek-flash`; the earlier `deepseek-v4-flash` is still
  // served, and settings written by an older build carry it. Loading must move them across
  // without losing the reasoning choice, and the retired vision id too.
  for (const old of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const dir = await mkdtemp(join(tmpdir(), "mindweave-model-"));
    try {
      await saveModelConfig(dir, { model: old, thinking: true, effort: "max" });
      assert.deepEqual(await loadModelConfig(dir), { model: "deepseek-flash", thinking: true, effort: "max" }, old);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("the earlier Flash id still resolves to DeepSeek, with images, and the current id is what is offered", async () => {
  const { manifestForModel, allProviders } = await import("../drivers/registry.js");
  for (const old of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const m = manifestForModel(old);
    assert.equal(m.id, "deepseek", `${old} no longer routes to DeepSeek`);
    if (old === "deepseek-v4-flash") assert.equal(m.acceptsImages?.(old), true, "the old id lost image support");
  }
  const offered = allProviders().find((p) => p.id === "deepseek")!.models.map((m) => m.id);
  assert.deepEqual(offered, ["deepseek-flash", "deepseek-v4-pro"], "the picker must offer the current names, not the earlier id");
});
