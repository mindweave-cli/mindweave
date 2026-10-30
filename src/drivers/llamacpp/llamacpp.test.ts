/**
 * llamacpp.test.ts — a local `llama-server`: the one model it runs, the context it was started with, which address answers,
 * and that a turn goes there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deadAddress, fakeServer, json, stream, textAnswer, withEnv } from "../openaiCompat/fakeServer.test.js";
import { discoverModels, fromListed, readableName, startedWindow } from "./catalog.js";
import { DEFAULT_URLS, KEY_ENV, RUNNING_ENV, URL_ENV, baseUrl, candidates, parseAddress, rememberFound } from "./endpoint.js";
import { PREFIX, llamacppManifest } from "./manifest.js";
import { streamTurn } from "./client.js";
import type { ModelRequest } from "../types.js";

test("a file path or file name reads as the model's name", () => {
  assert.equal(readableName("/models/Qwen3-8B-Q4_K_M.gguf"), "Qwen3-8B-Q4_K_M");
  assert.equal(readableName("C:\\models\\llama.gguf"), "llama");
  assert.equal(readableName("my-alias"), "my-alias");
});

test("the context the server was started with is read from /props, from either place it is reported", () => {
  assert.equal(startedWindow({ default_generation_settings: { n_ctx: 32768 } }), 32768);
  assert.equal(startedWindow({ n_ctx: 8192 }), 8192);
  assert.equal(startedWindow({}), undefined);
  assert.equal(startedWindow(null), undefined);
});

test("what the server was started with wins over the model's trained maximum", () => {
  const entry = { id: "m.gguf", meta: { n_ctx_train: 131072 } };
  assert.equal(fromListed(entry, { default_generation_settings: { n_ctx: 16384 } }).window, 16384);
  assert.equal(fromListed(entry, null).window, 131072, "with /props missing, the trained figure is the best there is");
  assert.equal(fromListed({ id: "m.gguf" }, null).window, 32768, "and with nothing, the working default");
});

test("an address typed as host or host:port gets llama-server's port", () => {
  assert.equal(parseAddress("192.168.1.20"), "http://192.168.1.20:8080");
  assert.equal(parseAddress("box:9000"), "http://box:9000");
  assert.equal(parseAddress("nonsense://x"), null);
});

test("an address that was set is the only one asked; without one, the likely ports are tried in turn", () => {
  assert.deepEqual(candidates({}), DEFAULT_URLS);
  assert.deepEqual(candidates({ [URL_ENV]: "http://box:9000/" }), ["http://box:9000"]);
});

const LISTING = { data: [{ id: "/models/Qwen3-8B-Q4_K_M.gguf", meta: { n_ctx_train: 40960 } }] };

test("discovery finds the model, the context it was started with, and remembers which address answered", async () => {
  const server = await fakeServer({
    "GET /v1/models": (_s, res) => json(res, LISTING),
    "GET /props": (_s, res) => json(res, { default_generation_settings: { n_ctx: 24576 } }),
  });
  try {
    await withEnv({ [URL_ENV]: server.url, [RUNNING_ENV]: undefined }, async () => {
      const [m, ...rest] = await discoverModels();
      assert.equal(rest.length, 0, "a llama-server runs one model");
      assert.equal(m!.id, `${PREFIX}/models/Qwen3-8B-Q4_K_M.gguf`);
      assert.equal(m!.label, "Qwen3-8B-Q4_K_M");
      assert.equal(m!.facts?.contextWindow, 24576);
      assert.equal(process.env[RUNNING_ENV], "1");
    });
  } finally {
    await server.close();
  }
});

test("a server whose /props is not served is still found, with the window it can be worked out to", async () => {
  const server = await fakeServer({ "GET /v1/models": (_s, res) => json(res, LISTING) });
  try {
    await withEnv({ [URL_ENV]: server.url }, async () => {
      const [m] = await discoverModels();
      assert.equal(m!.facts?.contextWindow, 40960);
    });
  } finally {
    await server.close();
  }
});

test("with nothing answering, discovery fails and the running mark is cleared", async () => {
  const dead = await deadAddress();
  await withEnv({ [URL_ENV]: dead, [RUNNING_ENV]: "1" }, async () => {
    await assert.rejects(() => discoverModels());
    assert.equal(process.env[RUNNING_ENV], undefined);
  });
});

const request = (model: string): ModelRequest => ({
  system: "S",
  messages: [{ role: "user", content: "hello" }],
  model: { model, thinking: false, effort: "low" },
});

test("a turn goes to the server with the listed id as its name, and a key only when the server wants one", async () => {
  const server = await fakeServer({ "POST /v1/chat/completions": (_s, res) => stream(res, textAnswer("done")) });
  try {
    await withEnv({ [URL_ENV]: server.url, [KEY_ENV]: undefined }, async () => {
      assert.equal((await streamTurn(request(`${PREFIX}/models/Qwen3-8B-Q4_K_M.gguf`), {})).content, "done");
      const first = server.seen.find((s) => s.path === "/v1/chat/completions")!;
      assert.equal((first.body as { model: string }).model, "/models/Qwen3-8B-Q4_K_M.gguf");
      assert.equal(first.headers.authorization, undefined);
      process.env[KEY_ENV] = "server-key";
      await streamTurn(request(`${PREFIX}m`), {});
      const second = server.seen.filter((s) => s.path === "/v1/chat/completions")[1]!;
      assert.equal(second.headers.authorization, "Bearer server-key");
    });
  } finally {
    await server.close();
  }
});

test("a server found on a default port is the one later requests use", async () => {
  const server = await fakeServer({ "POST /v1/chat/completions": (_s, res) => stream(res, textAnswer("found it")) });
  try {
    await withEnv({ [URL_ENV]: undefined }, async () => {
      rememberFound(server.url);
      assert.equal(baseUrl(), server.url);
      assert.equal((await streamTurn(request(`${PREFIX}m`), {})).content, "found it");
    });
  } finally {
    rememberFound(null);
    await server.close();
  }
});

test("manifest: namespaced, local, claims only its own ids", () => {
  assert.equal(llamacppManifest.local, true);
  assert.equal(llamacppManifest.ownsModel!(`${PREFIX}x`), true);
  assert.equal(llamacppManifest.ownsModel!("x"), false);
});
