/**
 * custom.test.ts — the custom endpoint: what it makes of a server's listing, what it does when the server has none, and that
 * a turn goes to the address with the key (or without one) the person set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deadAddress, fakeServer, json, stream, textAnswer, withEnv } from "../openaiCompat/fakeServer.test.js";
import { discoverModels, fromListed, priceFrom } from "./catalog.js";
import { DEFAULT_WINDOW, KEY_ENV, MODELS_ENV, READY_ENV, URL_ENV, WINDOW_ENV, assumedWindow, parseAddress, typedModels } from "./endpoint.js";
import { PREFIX, customManifest, typedChoices } from "./manifest.js";
import { streamTurn } from "./client.js";
import { allProviders, modelsOf } from "../registry.js";
import type { ModelRequest } from "../types.js";

const ALL = { [URL_ENV]: undefined, [KEY_ENV]: undefined, [MODELS_ENV]: undefined, [WINDOW_ENV]: undefined, [READY_ENV]: undefined };

test("only a full http(s) address is taken: a guessed path is a request that fails with no hint why", () => {
  assert.equal(parseAddress("https://api.together.xyz/v1"), "https://api.together.xyz/v1");
  assert.equal(parseAddress("https://api.together.xyz/v1/"), "https://api.together.xyz/v1");
  assert.equal(parseAddress("http://10.0.0.5:8000/v1"), "http://10.0.0.5:8000/v1");
  assert.equal(parseAddress("api.together.xyz"), null);
  assert.equal(parseAddress("https://user:pw@host/v1"), null);
  assert.equal(parseAddress(""), null);
});

test("typed model ids are split on commas and lines, trimmed, and kept once", () => {
  assert.deepEqual(typedModels({ [MODELS_ENV]: " a , b\nc,, a " }), ["a", "b", "c"]);
  assert.deepEqual(typedModels({}), []);
});

test("the assumed window is a typical modern one unless set, and a silly number is ignored", () => {
  assert.equal(assumedWindow({}), DEFAULT_WINDOW);
  assert.equal(assumedWindow({ [WINDOW_ENV]: "64000" }), 64000);
  assert.equal(assumedWindow({ [WINDOW_ENV]: "12" }), DEFAULT_WINDOW);
  assert.equal(assumedWindow({ [WINDOW_ENV]: "lots" }), DEFAULT_WINDOW);
});

test("a price a router lists per token, and one a host lists per million, both become per-million; anything else is not guessed", () => {
  assert.deepEqual(priceFrom({ pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.00000006" } }), {
    cacheMiss: 0.3,
    output: 1.2,
    cacheHit: 0.06,
  });
  assert.deepEqual(priceFrom({ pricing: { input: 0.88, output: 0.88 } }), { cacheMiss: 0.88, output: 0.88, cacheHit: 0.88 });
  assert.equal(priceFrom({ pricing: { something: 1 } }), undefined);
  assert.equal(priceFrom({}), undefined);
});

test("a listing's window and price are used when it gives them, and an entry without them says its price is not tracked", () => {
  const rich = fromListed({ id: "a", context_length: 65536, pricing: { prompt: "0.000001", completion: "0.000002" } });
  assert.equal(rich.window, 65536);
  assert.equal(rich.price?.output, 2);
  assert.equal(rich.note, undefined);
  const bare = fromListed({ id: "b" });
  assert.equal(bare.window, DEFAULT_WINDOW);
  assert.equal(bare.price, undefined);
  assert.equal(bare.note, "price not tracked");
  assert.equal(fromListed({ id: "c", max_model_len: 8192 }).window, 8192, "vLLM names it max_model_len");
});

test("with no address set, discovery fails and the provider is not connected", async () => {
  await withEnv({ ...ALL, [READY_ENV]: "1" }, async () => {
    await assert.rejects(() => discoverModels(), /No address/);
    assert.equal(process.env[READY_ENV], undefined);
  });
});

test("discovery lists what the server lists, sends the key it was given, and marks the provider connected", async () => {
  const server = await fakeServer({
    "GET /v1/models": (s, res) =>
      s.headers.authorization === "Bearer sk-test" ? json(res, { data: [{ id: "llama-3.3-70b", context_length: 131072 }, { id: "qwen-coder" }] }) : json(res, { error: "no" }, 401),
  });
  try {
    await withEnv({ ...ALL, [URL_ENV]: `${server.url}/v1`, [KEY_ENV]: "sk-test" }, async () => {
      const models = await discoverModels();
      assert.deepEqual(models.map((m) => m.id), [`${PREFIX}llama-3.3-70b`, `${PREFIX}qwen-coder`]);
      assert.equal(models[0]!.facts?.contextWindow, 131072);
      assert.equal(process.env[READY_ENV], "1");
    });
  } finally {
    await server.close();
  }
});

test("a wrong key is refused by the server, and discovery says so instead of showing an empty list as success", async () => {
  const server = await fakeServer({ "GET /v1/models": (_s, res) => json(res, { error: "bad key" }, 401) });
  try {
    await withEnv({ ...ALL, [URL_ENV]: `${server.url}/v1`, [KEY_ENV]: "wrong", [READY_ENV]: "1" }, async () => {
      await assert.rejects(() => discoverModels(), /401/);
      assert.equal(process.env[READY_ENV], undefined);
    });
  } finally {
    await server.close();
  }
});

test("a server with no model list is still usable with the ids typed in, and they are offered before it answers", async () => {
  const server = await fakeServer({});
  try {
    await withEnv({ ...ALL, [URL_ENV]: `${server.url}/v1`, [MODELS_ENV]: "my-model, other" }, async () => {
      assert.deepEqual(await discoverModels(), [], "the typed ones come from the manifest, so none are repeated here");
      assert.equal(process.env[READY_ENV], "1", "an address and a model are enough to count as connected");
      const custom = allProviders().find((p) => p.id === "custom")!;
      assert.deepEqual(modelsOf(custom).map((m) => m.id), [`${PREFIX}my-model`, `${PREFIX}other`]);
      assert.equal(modelsOf(custom)[0]!.facts?.contextWindow, DEFAULT_WINDOW);
    });
  } finally {
    await server.close();
  }
});

test("a typed id the server also lists is offered once", async () => {
  const server = await fakeServer({ "GET /v1/models": (_s, res) => json(res, { data: [{ id: "dup" }, { id: "only-listed" }] }) });
  try {
    await withEnv({ ...ALL, [URL_ENV]: `${server.url}/v1`, [MODELS_ENV]: "dup" }, async () => {
      const models = await discoverModels();
      assert.deepEqual(models.map((m) => m.id), [`${PREFIX}only-listed`]);
    });
  } finally {
    await server.close();
  }
});

test("an unreachable server with nothing typed fails discovery", async () => {
  const dead = await deadAddress();
  await withEnv({ ...ALL, [URL_ENV]: `${dead}/v1`, [READY_ENV]: "1" }, async () => {
    await assert.rejects(() => discoverModels());
    assert.equal(process.env[READY_ENV], undefined);
  });
});

const request = (model: string): ModelRequest => ({
  system: "S",
  messages: [{ role: "user", content: "hello" }],
  model: { model, thinking: false, effort: "low" },
});

test("a turn goes to the address given, with the key, the namespace stripped and no reasoning field", async () => {
  const server = await fakeServer({ "POST /v1/chat/completions": (_s, res) => stream(res, textAnswer("from the custom server")) });
  try {
    await withEnv({ ...ALL, [URL_ENV]: `${server.url}/v1`, [KEY_ENV]: "sk-live" }, async () => {
      const result = await streamTurn(request(`${PREFIX}llama-3.3-70b`), {});
      assert.equal(result.content, "from the custom server");
      const sent = server.seen.find((s) => s.path === "/v1/chat/completions")!;
      assert.equal((sent.body as { model: string }).model, "llama-3.3-70b");
      assert.equal(sent.headers.authorization, "Bearer sk-live");
      assert.equal("reasoning_effort" in (sent.body as object), false);
      assert.equal("thinking" in (sent.body as object), false);
    });
  } finally {
    await server.close();
  }
});

test("a server that wants no key is sent none", async () => {
  const server = await fakeServer({ "POST /v1/chat/completions": (_s, res) => stream(res, textAnswer("open")) });
  try {
    await withEnv({ ...ALL, [URL_ENV]: `${server.url}/v1` }, async () => {
      await streamTurn(request(`${PREFIX}m`), {});
      assert.equal(server.seen.find((s) => s.path === "/v1/chat/completions")!.headers.authorization, undefined);
    });
  } finally {
    await server.close();
  }
});

test("manifest: it says where prompts go, claims only its own ids, and declares how it is set up", () => {
  assert.match(customManifest.notice ?? "", /Your prompts go to the address you entered/);
  assert.equal(customManifest.ownsModel!(`${PREFIX}x`), true);
  assert.equal(customManifest.ownsModel!("x"), false);
  assert.equal(customManifest.local, undefined, "it is not on this machine");
  assert.deepEqual([customManifest.setup?.addressEnv, customManifest.setup?.keyEnv, customManifest.setup?.modelsEnv], [URL_ENV, KEY_ENV, MODELS_ENV]);
  assert.deepEqual(typedChoices(), [], "nothing typed, nothing offered");
});
