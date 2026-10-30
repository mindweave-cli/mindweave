/**
 * lmstudio.test.ts — LM Studio's local server: what it lists, what is left out, and that a turn really goes to it.
 *
 * The server is a stand-in on a real port (see `openaiCompat/fakeServer.test.ts`), so the request is the one the driver sends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deadAddress, fakeServer, json, stream, textAnswer, withEnv } from "../openaiCompat/fakeServer.test.js";
import { discoverModels, fromNative, isChat } from "./catalog.js";
import { RUNNING_ENV, TOKEN_ENV, URL_ENV, baseUrl, parseAddress } from "./endpoint.js";
import { PREFIX, lmstudioManifest, ownsModel, price } from "./manifest.js";
import { lmstudioProvider, reasoningFields, streamTurn } from "./client.js";
import type { ModelRequest } from "../types.js";

const NATIVE = {
  data: [
    { id: "qwen3-8b", type: "llm", state: "loaded", max_context_length: 40960, loaded_context_length: 16384, quantization: "Q4_K_M", capabilities: ["tool_use"] },
    { id: "text-embedding-nomic", type: "embeddings", state: "not-loaded", max_context_length: 2048 },
    { id: "llava-13b", type: "vlm", state: "not-loaded", max_context_length: 131072 },
  ],
};

test("an embeddings model is not a chat model, by type, or by name when the listing has no type", () => {
  assert.equal(isChat({ id: "qwen3-8b", type: "llm" }), true);
  assert.equal(isChat({ id: "llava-13b", type: "vlm" }), true);
  assert.equal(isChat({ id: "text-embedding-nomic", type: "embeddings" }), false);
  assert.equal(isChat({ id: "nomic-embed-text-v1.5" }), false);
  assert.equal(isChat({ id: "qwen3-8b" }), true);
});

test("a loaded model's window is what it was loaded with; one not loaded gets the working default, not its trained maximum", () => {
  assert.equal(fromNative(NATIVE.data[0]!).window, 16384);
  assert.equal(fromNative(NATIVE.data[2]!).window, 32768, "131072 trained, but a load defaults far lower: 32K is asked for");
  assert.equal(fromNative({ id: "x" }).window, undefined);
});

test("an address typed as host or host:port gets LM Studio's port, and a URL is kept", () => {
  assert.equal(parseAddress("192.168.1.20"), "http://192.168.1.20:1234");
  assert.equal(parseAddress("192.168.1.20:9000"), "http://192.168.1.20:9000");
  assert.equal(parseAddress("https://lm.example.test"), "https://lm.example.test");
  assert.equal(parseAddress("http://u:p@host:1234"), null);
  assert.equal(parseAddress(""), null);
});

test("discovery lists the chat models with their facts, leaves out the embeddings model, and marks LM Studio as running", async () => {
  const server = await fakeServer({ "GET /api/v0/models": (_s, res) => json(res, NATIVE) });
  try {
    await withEnv({ [URL_ENV]: server.url, [RUNNING_ENV]: undefined }, async () => {
      const models = await discoverModels();
      assert.deepEqual(models.map((m) => m.id), [`${PREFIX}qwen3-8b`, `${PREFIX}llava-13b`]);
      assert.equal(models[0]!.facts?.contextWindow, 16384);
      assert.deepEqual(models[0]!.facts?.price, { cacheHit: 0, cacheMiss: 0, output: 0 }, "nothing is billed");
      assert.match(models[0]!.description ?? "", /loaded/);
      assert.equal(process.env[RUNNING_ENV], "1", "this is what makes it count as connected");
    });
  } finally {
    await server.close();
  }
});

test("a model loaded with too little context says so in its entry", async () => {
  const server = await fakeServer({
    "GET /api/v0/models": (_s, res) => json(res, { data: [{ id: "tiny", type: "llm", state: "loaded", max_context_length: 8192, loaded_context_length: 4096 }] }),
  });
  try {
    await withEnv({ [URL_ENV]: server.url }, async () => {
      const [m] = await discoverModels();
      assert.match(m!.description ?? "", /4,096 tokens of context: too small for an agent/);
    });
  } finally {
    await server.close();
  }
});

test("an LM Studio with only the OpenAI-style listing is still found", async () => {
  const server = await fakeServer({
    "GET /v1/models": (_s, res) => json(res, { data: [{ id: "qwen3-8b" }, { id: "nomic-embed-text" }] }),
  });
  try {
    await withEnv({ [URL_ENV]: server.url }, async () => {
      const models = await discoverModels();
      assert.deepEqual(models.map((m) => m.id), [`${PREFIX}qwen3-8b`]);
    });
  } finally {
    await server.close();
  }
});

test("with the server not running, discovery fails and the running mark is cleared, so it no longer counts as connected", async () => {
  const dead = await deadAddress();
  await withEnv({ [URL_ENV]: dead, [RUNNING_ENV]: "1" }, async () => {
    await assert.rejects(() => discoverModels());
    assert.equal(process.env[RUNNING_ENV], undefined);
  });
});

test("a server with nothing downloaded is up but not connected", async () => {
  const server = await fakeServer({ "GET /api/v0/models": (_s, res) => json(res, { data: [{ id: "e", type: "embeddings" }] }) });
  try {
    await withEnv({ [URL_ENV]: server.url, [RUNNING_ENV]: "1" }, async () => {
      assert.deepEqual(await discoverModels(), []);
      assert.equal(process.env[RUNNING_ENV], undefined);
    });
  } finally {
    await server.close();
  }
});

const request = (model: string): ModelRequest => ({
  system: "S",
  messages: [{ role: "user", content: "hello" }],
  model: { model, thinking: false, effort: "low" },
});

test("a turn goes to the server's own address, with the namespace stripped, no key, and no reasoning field", async () => {
  const server = await fakeServer({ "POST /v1/chat/completions": (_s, res) => stream(res, textAnswer("hi there")) });
  try {
    await withEnv({ [URL_ENV]: server.url, [TOKEN_ENV]: undefined }, async () => {
      const events: string[] = [];
      const result = await streamTurn(request(`${PREFIX}qwen3-8b`), { onEvent: (e) => events.push(e.type) });
      assert.equal(result.content, "hi there");
      const sent = server.seen.find((s) => s.path === "/v1/chat/completions")!;
      assert.equal((sent.body as { model: string }).model, "qwen3-8b", "LM Studio knows it by its own name");
      assert.equal(sent.headers.authorization, undefined, "no key is asked for or sent");
      assert.equal("reasoning_effort" in (sent.body as object), false);
      assert.equal("thinking" in (sent.body as object), false);
      assert.equal(result.usage?.promptTokens, 40);
    });
  } finally {
    await server.close();
  }
});

test("a token is sent when LM Studio was started requiring one", async () => {
  const server = await fakeServer({ "POST /v1/chat/completions": (_s, res) => stream(res, textAnswer("ok")) });
  try {
    await withEnv({ [URL_ENV]: server.url, [TOKEN_ENV]: "lm-secret" }, async () => {
      await streamTurn(request(`${PREFIX}qwen3-8b`), {});
      assert.equal(server.seen.find((s) => s.path === "/v1/chat/completions")!.headers.authorization, "Bearer lm-secret");
    });
  } finally {
    await server.close();
  }
});

test("the address is read on every request, so moving the server in the app counts without a restart", async () => {
  const a = await fakeServer({ "POST /v1/chat/completions": (_s, res) => stream(res, textAnswer("from a")) });
  const b = await fakeServer({ "POST /v1/chat/completions": (_s, res) => stream(res, textAnswer("from b")) });
  try {
    await withEnv({ [URL_ENV]: a.url }, async () => {
      assert.equal((await streamTurn(request(`${PREFIX}m`), {})).content, "from a");
      process.env[URL_ENV] = b.url;
      assert.equal(lmstudioProvider.baseUrl, `${b.url}/v1`);
      assert.equal((await streamTurn(request(`${PREFIX}m`), {})).content, "from b");
    });
  } finally {
    await a.close();
    await b.close();
  }
});

test("manifest: namespaced, local, free, claims only its own ids, and asks for no reasoning", () => {
  assert.equal(lmstudioManifest.local, true);
  assert.equal(ownsModel(`${PREFIX}x`), true);
  assert.equal(ownsModel("qwen3-8b"), false, "a bare id is never claimed: a cloud model of the same name is not this one");
  assert.deepEqual(price(`${PREFIX}x`), { cacheHit: 0, cacheMiss: 0, output: 0 });
  assert.deepEqual(reasoningFields({ model: `${PREFIX}x`, thinking: true, effort: "max" }), {});
  assert.equal(baseUrl({}), "http://127.0.0.1:1234");
});
