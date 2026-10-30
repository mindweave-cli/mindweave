/**
 * endpoints.test.ts — the address a provider is reached at is a setting that counts at once, and a coding plan's address
 * is a preset rather than a thing to remember.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENDPOINTS, activePreset, endpointUrl, parseEndpoint, parseUrl } from "./endpoints.js";
import { allModels, modelsOf, manifestForModel, allProviders } from "./registry.js";
import { glmProvider } from "./glm/client.js";
import { qwenProvider } from "./qwen/client.js";
import { kimiProvider, reasoningFields as kimiReasoning } from "./kimi/client.js";
import { minimaxProvider } from "./minimax/client.js";
import { KIMI_CODE, KIMI_CODE_HIGHSPEED, onKimiCode, price as kimiPrice } from "./kimi/manifest.js";

/** Run a body with some environment variables set, and put them back as they were. */
async function withEnv(vars: Record<string, string | undefined>, body: () => void | Promise<void>): Promise<void> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a provider's address is its default until the variable is set, and the change counts without a restart", async () => {
  await withEnv({ MINDWEAVE_GLM_URL: undefined }, () => {
    assert.equal(glmProvider.baseUrl, "https://api.z.ai/api/paas/v4");
  });
  await withEnv({ MINDWEAVE_GLM_URL: "https://api.z.ai/api/coding/paas/v4/" }, () => {
    assert.equal(glmProvider.baseUrl, "https://api.z.ai/api/coding/paas/v4", "read on the request, trailing slash dropped");
  });
});

test("every OpenAI-compatible driver reads its address from the one table", async () => {
  const drivers = { glm: glmProvider, qwen: qwenProvider, kimi: kimiProvider, minimax: minimaxProvider };
  for (const [id, provider] of Object.entries(drivers)) {
    await withEnv({ [ENDPOINTS[id]!.env]: "https://gateway.example.test/v1" }, () => {
      assert.equal(provider.baseUrl, "https://gateway.example.test/v1", id);
      assert.equal(endpointUrl(id), "https://gateway.example.test/v1", id);
    });
  }
});

test("the coding-plan presets are the addresses their providers document", () => {
  assert.equal(ENDPOINTS.glm!.presets[0]!.url, "https://api.z.ai/api/coding/paas/v4");
  assert.equal(ENDPOINTS.qwen!.presets[0]!.url, "https://coding-intl.dashscope.aliyuncs.com/v1");
  assert.deepEqual(
    ENDPOINTS.kimi!.presets.map((p) => p.url),
    ["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"],
  );
});

test("an address is recognised as a preset only when it matches one", async () => {
  await withEnv({ MINDWEAVE_GLM_URL: undefined }, () => assert.equal(activePreset("glm"), undefined));
  await withEnv({ MINDWEAVE_GLM_URL: "https://api.z.ai/api/coding/paas/v4" }, () => assert.equal(activePreset("glm")?.id, "coding-plan"));
  await withEnv({ MINDWEAVE_GLM_URL: "https://my-proxy.example.test/v4" }, () => assert.equal(activePreset("glm"), undefined));
});

test("a preset's id or a full address is accepted, and anything else is refused", () => {
  assert.equal(parseEndpoint("glm", "coding-plan"), "https://api.z.ai/api/coding/paas/v4");
  assert.equal(parseEndpoint("glm", "https://proxy.example.test/v1/"), "https://proxy.example.test/v1");
  assert.equal(parseEndpoint("glm", ""), null);
  assert.equal(parseEndpoint("glm", "not a url"), null);
  assert.equal(parseEndpoint("glm", "ftp://example.test/v1"), null);
  // Kept in a plain file and shown on screen, so a name, a password, a query or a fragment never goes in.
  assert.equal(parseUrl("https://user:secret@example.test/v1"), null);
  assert.equal(parseUrl("https://example.test/v1?key=abc"), null);
  assert.equal(parseUrl("https://example.test/v1#x"), null);
  assert.equal(parseUrl("http://localhost:8000/v1"), "http://localhost:8000/v1");
});

test("Kimi Code's own model ids are offered only while its address is set, and before the usual ones", async () => {
  await withEnv({ MINDWEAVE_KIMI_URL: undefined }, () => {
    assert.equal(onKimiCode(), false);
    assert.ok(!allModels().some((m) => m.id === KIMI_CODE));
  });
  for (const url of ["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"]) {
    await withEnv({ MINDWEAVE_KIMI_URL: url }, () => {
      assert.equal(onKimiCode(), true, url);
      const kimi = allProviders().find((p) => p.id === "kimi")!;
      const ids = modelsOf(kimi).map((m) => m.id);
      assert.deepEqual(ids.slice(0, 2), [KIMI_CODE, KIMI_CODE_HIGHSPEED], "listed first: the person chose this address on purpose");
      assert.ok(ids.length > 2, "the usual models are still there");
      assert.equal(manifestForModel(KIMI_CODE).id, "kimi", "routes to Kimi");
    });
  }
});

test("a Kimi Code model is a flat-fee membership: free per token, and no reasoning field is sent", () => {
  for (const model of [KIMI_CODE, KIMI_CODE_HIGHSPEED]) {
    assert.deepEqual(kimiPrice(model), { cacheHit: 0, cacheMiss: 0, output: 0 }, model);
    assert.deepEqual(kimiReasoning({ model, thinking: true, effort: "max" }), {}, `${model} takes whatever the service decides`);
  }
});
