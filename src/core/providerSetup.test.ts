/**
 * providerSetup.test.ts — the settings a provider has beyond a key: its address (and the coding-plan presets), and for a
 * provider set up by an address, the address, key, typed models and window.
 *
 * Every case reads the result back from where it is kept (the live variable and the global env file), not from what the
 * function returned: the failure this guards is a change that looks applied and is gone on the next launch, or the other way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasApiKey, loadConfig } from "../cli/bootstrap.js";
import { providerEndpoint, providerSetup, setProviderEndpoint, setProviderSetup, tidyModels } from "./providerSetup.js";
import { providerSummaries } from "./turnRunner.js";
import { stateRoot } from "../memory/store.js";

const VARS = [
  "MINDWEAVE_GLM_URL", "MINDWEAVE_KIMI_URL", "MINDWEAVE_CUSTOM_URL", "MINDWEAVE_CUSTOM_MODELS", "MINDWEAVE_CUSTOM_WINDOW",
  "MINDWEAVE_CUSTOM_API_KEY", "MINDWEAVE_LMSTUDIO_URL",
];

function fresh(): void {
  process.env.MINDWEAVE_STATE_DIR = realpathSync.native(mkdtempSync(join(tmpdir(), "provsetup-")));
  for (const k of Object.keys(process.env)) if (VARS.some((v) => k.startsWith(v))) delete process.env[k];
  loadConfig(realpathSync.native(mkdtempSync(join(tmpdir(), "provsetup-proj-"))));
}

/** What the global env file holds, as text: the thing that survives a restart. */
const envFile = (): string => {
  try {
    return readFileSync(join(stateRoot(), ".env"), "utf8");
  } catch {
    return "";
  }
};

test("a provider's address starts at its default and is changed by a preset's id or a full address", () => {
  fresh();
  const start = providerEndpoint("glm")!;
  assert.equal(start.url, "https://api.z.ai/api/paas/v4");
  assert.equal(start.changed, false);
  assert.equal(start.preset, undefined);

  assert.deepEqual(setProviderEndpoint("glm", "coding-plan"), { ok: true, url: "https://api.z.ai/api/coding/paas/v4" });
  assert.equal(process.env.MINDWEAVE_GLM_URL, "https://api.z.ai/api/coding/paas/v4", "applied at once");
  assert.match(envFile(), /MINDWEAVE_GLM_URL=https:\/\/api\.z\.ai\/api\/coding\/paas\/v4/, "and kept for the next launch");
  const now = providerEndpoint("glm")!;
  assert.equal(now.changed, true);
  assert.equal(now.preset, "coding-plan");

  assert.deepEqual(setProviderEndpoint("glm", "https://proxy.example.test/v4/"), { ok: true, url: "https://proxy.example.test/v4" });
  assert.equal(providerEndpoint("glm")!.preset, undefined, "an address of one's own is not a preset");
});

test("an empty value goes back to the usual address, in the process and in the file", () => {
  fresh();
  setProviderEndpoint("glm", "coding-plan");
  assert.deepEqual(setProviderEndpoint("glm", ""), { ok: true, url: null });
  assert.equal(process.env.MINDWEAVE_GLM_URL, undefined);
  assert.doesNotMatch(envFile(), /MINDWEAVE_GLM_URL/);
  assert.equal(providerEndpoint("glm")!.url, "https://api.z.ai/api/paas/v4");
});

test("a bad address is refused with the way to a good one, and changes nothing", () => {
  fresh();
  setProviderEndpoint("glm", "coding-plan");
  const refused = setProviderEndpoint("glm", "not an address");
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /coding-plan/, "names the presets there are");
  assert.equal(process.env.MINDWEAVE_GLM_URL, "https://api.z.ai/api/coding/paas/v4", "the old one stands");
  assert.equal(setProviderEndpoint("ollama", "https://x.test/v1").ok, false, "a provider whose address is not a setting says so");
});

test("Kimi's two coding addresses are presets, and the summary carries the address and its presets for the app", () => {
  fresh();
  assert.equal(setProviderEndpoint("kimi", "kimi-code").ok, true);
  const kimi = providerSummaries().find((p) => p.id === "kimi")!;
  assert.equal(kimi.endpoint?.preset, "kimi-code");
  assert.deepEqual(kimi.endpoint?.presets.map((p) => p.id), ["kimi-code", "kimi-code-overseas"]);
  assert.ok(kimi.models.some((m) => m.id === "kimi-for-coding"), "its own model ids are offered while the address is set");
});

test("the custom endpoint: address, key, typed models and window are all applied and all kept", () => {
  fresh();
  const before = providerSetup("custom")!;
  assert.deepEqual([before.address, before.hasKey, before.keyed, before.usesModels, before.usesWindow], ["", false, true, true, true]);

  const result = setProviderSetup("custom", { address: "https://api.together.xyz/v1/", key: "tok-123", models: " a , b,a ", window: "64,000" });
  assert.deepEqual(result, { ok: true, url: "https://api.together.xyz/v1" });
  const after = providerSetup("custom")!;
  assert.equal(after.address, "https://api.together.xyz/v1");
  assert.equal(after.hasKey, true);
  assert.equal(after.models, "a,b", "tidied: one line, no repeats");
  assert.equal(after.window, "64000");
  assert.equal(hasApiKey("MINDWEAVE_CUSTOM_API_KEY"), true);
  assert.match(envFile(), /MINDWEAVE_CUSTOM_URL=https:\/\/api\.together\.xyz\/v1/);
  assert.match(envFile(), /MINDWEAVE_CUSTOM_MODELS=a,b/);
});

test("a field left out is left alone, and null clears it", () => {
  fresh();
  setProviderSetup("custom", { address: "https://api.example.test/v1", key: "k1", models: "m" });
  setProviderSetup("custom", { window: "32768" });
  const kept = providerSetup("custom")!;
  assert.deepEqual([kept.address, kept.hasKey, kept.models, kept.window], ["https://api.example.test/v1", true, "m", "32768"]);

  setProviderSetup("custom", { key: null, models: null });
  const cleared = providerSetup("custom")!;
  assert.deepEqual([cleared.hasKey, cleared.models, cleared.address], [false, "", "https://api.example.test/v1"]);
});

test("one bad field refuses the whole change, so nothing is half applied", () => {
  fresh();
  setProviderSetup("custom", { address: "https://good.example.test/v1", key: "old-key" });
  const bad = setProviderSetup("custom", { address: "https://other.example.test/v1", key: "new-key", window: "12" });
  assert.equal(bad.ok, false);
  const now = providerSetup("custom")!;
  assert.equal(now.address, "https://good.example.test/v1", "the address was not moved");
  assert.equal(process.env.MINDWEAVE_CUSTOM_API_KEY_1 ?? process.env.MINDWEAVE_CUSTOM_API_KEY, "old-key", "and the key was not replaced");
  assert.equal(setProviderSetup("custom", { address: "api.together.xyz" }).ok, false, "a guessed address is refused");
});

test("a local server takes an address and no key, and a provider with no setup says so", () => {
  fresh();
  assert.deepEqual(setProviderSetup("lmstudio", { address: "192.168.1.20" }), { ok: true, url: "http://192.168.1.20:1234" });
  const lm = providerSetup("lmstudio")!;
  assert.deepEqual([lm.address, lm.keyed, lm.usesModels], ["http://192.168.1.20:1234", false, false]);
  assert.equal(setProviderSetup("lmstudio", { key: "nope" }).ok, false, "it never asks for one");
  assert.equal(setProviderSetup("deepseek", { address: "https://x.test" }).ok, false);
  assert.equal(providerSetup("deepseek"), null);
});

test("typed model ids are tidied", () => {
  assert.equal(tidyModels(" a , b\n c,, a "), "a,b,c");
  assert.equal(tidyModels("  "), "");
});

test("the provider list carries the setup and the notice the app shows", () => {
  fresh();
  const list = providerSummaries();
  assert.deepEqual(
    ["lmstudio", "llamacpp", "custom"].map((id) => list.find((p) => p.id === id)?.setup?.placeholder !== undefined),
    [true, true, true],
  );
  assert.match(list.find((p) => p.id === "custom")!.notice ?? "", /Your prompts go to the address you entered/);
  assert.equal(list.find((p) => p.id === "deepseek")!.setup, null);
  assert.equal(list.find((p) => p.id === "deepseek")!.endpoint, null, "an SDK-backed or fixed provider has no address to change");
});

test("pointing the custom endpoint at a server connects it, and clearing it forgets the server's models at once", async () => {
  const { fakeServer, json } = await import("../drivers/openaiCompat/fakeServer.test.js");
  const { allProviders, modelsOf, refreshModels } = await import("../drivers/registry.js");
  fresh();
  const server = await fakeServer({ "GET /v1/models": (_s, res) => json(res, { data: [{ id: "alpha" }, { id: "beta" }] }) });
  try {
    const custom = () => allProviders().find((p) => p.id === "custom")!;
    assert.equal(setProviderSetup("custom", { address: `${server.url}/v1` }).ok, true);
    await refreshModels({ maxAgeMs: 60_000 });
    assert.deepEqual(modelsOf(custom()).map((m) => m.id), ["custom:alpha", "custom:beta"]);
    assert.equal(providerSummaries().find((p) => p.id === "custom")!.connected, true);

    // Removing the address must not leave "connected" and the old models standing for a server that is no longer in use,
    // even though a list this young would normally be reused.
    assert.equal(setProviderSetup("custom", { address: null }).ok, true);
    assert.equal(providerSummaries().find((p) => p.id === "custom")!.connected, false);
    await refreshModels({ maxAgeMs: 60_000 });
    assert.deepEqual(modelsOf(custom()).map((m) => m.id), []);
    assert.equal(providerSummaries().find((p) => p.id === "custom")!.connected, false);
  } finally {
    await server.close();
  }
});
