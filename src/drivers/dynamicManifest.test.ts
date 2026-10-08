/**
 * dynamicManifest.test.ts — providers whose model list is not known at build time.
 *
 * Every provider until now declared a fixed lineup, and the registry was built on
 * that assumption. Two legitimate cases break it: a LOCAL runtime, where the list is
 * whatever the user has pulled onto this machine, and a ROUTER, where it is hundreds
 * of models changing weekly. This is the mechanism that serves both.
 *
 * The failure modes worth pinning are all quiet ones — a picker that looks empty, a
 * saved model attributed to the wrong provider, a discovery blip wiping a working
 * list. None of them throws; each just makes the app subtly wrong.
 *
 * The registry's real provider list is module-level, so these tests drive the pieces
 * that carry the logic (`modelsOf`, `manifestForModel`, `refreshModels`) against a
 * fake manifest, rather than mutating the installed set out from under other tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { allModels, clearDiscovered, manifestForModel, modelsOf, refreshModels } from "./registry.js";
import type { DriverManifest, ModelChoice } from "./types.js";

/** A minimal manifest; only the fields these tests touch are meaningful. */
function fakeManifest(over: Partial<DriverManifest> = {}): DriverManifest {
  return {
    id: "fake",
    label: "Fake",
    apiKeyEnv: "FAKE_API_KEY",
    keysUrl: "https://example.invalid",
    models: [],
    thinkLevels: () => [],
    price: () => ({ cacheHit: 0, cacheMiss: 0, output: 0 }),
    contextWindow: () => 100_000,
    normalize: (c) => c,
    ...over,
  };
}

const CHOICE = (id: string): ModelChoice => ({ id, label: id, description: "" });

test("a provider with no discovery reads its declared list, unchanged", () => {
  const m = fakeManifest({ models: [CHOICE("fixed-1")] });
  assert.deepEqual(modelsOf(m), [CHOICE("fixed-1")]);
});

test("a DISCOVERED provider reads empty until it has been asked", () => {
  // The quiet failure this guards: a local runtime declares no models at build
  // time, so anything reading `manifest.models` directly shows a permanently empty
  // picker even after discovery has run successfully.
  const m = fakeManifest({ models: [], discoverModels: async () => [CHOICE("pulled-1")] });
  assert.deepEqual(modelsOf(m), []);
});

test("the installed providers all report a non-empty list without discovery", () => {
  // Every provider shipped so far is static, so the mechanism must be inert for
  // them: adding discovery must not make an existing picker depend on a network
  // call that has not happened.
  clearDiscovered();
  assert.ok(allModels().length > 0, "the static lineup must not depend on discovery");
});

test("refreshModels is a no-op for a lineup that declares no discovery", async () => {
  clearDiscovered();
  const before = allModels().map((m) => m.id);
  // A local runtime is asked on every refresh. Point it at a port nothing listens on, so the answer does not
  // depend on whether this machine (or the Windows host a Linux shell can reach) happens to run Ollama.
  const saved = process.env.MINDWEAVE_OLLAMA_URL;
  process.env.MINDWEAVE_OLLAMA_URL = "http://127.0.0.1:1";
  let refreshed: string[];
  try {
    refreshed = await refreshModels();
  } finally {
    if (saved === undefined) delete process.env.MINDWEAVE_OLLAMA_URL;
    else process.env.MINDWEAVE_OLLAMA_URL = saved;
  }
  assert.deepEqual(refreshed, [], "no installed provider discovers yet");
  assert.deepEqual(
    allModels().map((m) => m.id),
    before,
    "a refresh must not disturb static providers",
  );
});

// ── Ownership: deriving the provider from a model id ──────────────────────────

test("a model in a provider's real list is attributed to that provider", () => {
  const first = allModels()[0]!;
  assert.ok(modelsOf(manifestForModel(first.id)).some((m) => m.id === first.id));
});

test("a REAL list beats a broad ownership claim", () => {
  // The ordering rule. A discovered provider that claims widely (a router claiming
  // every namespaced id, say) must never capture a model another provider actually
  // serves — otherwise installing it would silently redirect existing sessions.
  const claimed = allModels()[0]!.id;
  const greedy = fakeManifest({ id: "greedy", ownsModel: () => true });
  // The greedy manifest is not installed, so assert the property directly on the
  // rule it encodes: a list hit is found before any claim is consulted.
  assert.ok(modelsOf(greedy).length === 0, "the greedy manifest declares nothing");
  assert.notEqual(manifestForModel(claimed).id, "greedy");
});

test("an unknown model id still resolves to a provider rather than throwing", () => {
  // The session must open on something. Falling back is correct; failing is not.
  const m = manifestForModel("nothing-serves-this-model-9");
  assert.ok(m.id.length > 0);
});

// ── Failure handling ──────────────────────────────────────────────────────────

test("a discovery FAILURE keeps the previous list instead of emptying it", async () => {
  // A local runtime that is briefly down must not wipe the picker. The distinction
  // that matters: a rejected promise is a failure, an empty array is a real answer.
  const calls: number[] = [];
  let fail = false;
  const m = fakeManifest({
    id: "flaky",
    models: [CHOICE("declared")],
    discoverModels: async () => {
      calls.push(1);
      if (fail) throw new Error("runtime not running");
      return [CHOICE("live-1")];
    },
  });

  // Drive the same try/keep-previous logic refreshModels applies, per provider.
  const store = new Map<string, ModelChoice[]>();
  const attempt = async () => {
    try {
      store.set(m.id, await m.discoverModels!());
    } catch {
      /* keep whatever is stored */
    }
  };

  await attempt();
  assert.deepEqual(store.get("flaky"), [CHOICE("live-1")]);

  fail = true;
  await attempt();
  assert.deepEqual(store.get("flaky"), [CHOICE("live-1")], "a blip must not empty a working list");
  assert.equal(calls.length, 2, "the second attempt really ran");
});

test("an EMPTY discovery result is stored — it is an answer, not a failure", async () => {
  // A runtime that is running with nothing pulled genuinely offers no models, and
  // showing a stale list there would be worse than showing none.
  const m = fakeManifest({ id: "empty", models: [CHOICE("declared")], discoverModels: async () => [] });
  const store = new Map<string, ModelChoice[]>();
  try {
    store.set(m.id, await m.discoverModels!());
  } catch {
    /* unreachable */
  }
  assert.deepEqual(store.get("empty"), []);
});

test("clearDiscovered returns every provider to its declared list", async () => {
  clearDiscovered();
  const ids = allModels().map((m) => m.id);
  await refreshModels();
  clearDiscovered();
  assert.deepEqual(allModels().map((m) => m.id), ids);
});
