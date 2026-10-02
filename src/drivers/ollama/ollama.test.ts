/**
 * ollama.test.ts — models on this machine through Ollama.
 *
 * What is pinned is what goes wrong quietly: a prompt cut to Ollama's small default window, a
 * model that thinks when Standard was chosen, a local model mistaken for a cloud one, tool results
 * Ollama cannot match to their call, and a server that stopped still counting as connected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearDiscovered, manifestForModel, seedDiscovered } from "../registry.js";
import type { ModelRequest } from "../types.js";
import { baseUrl, DEFAULT_URL, RUNNING_ENV } from "./endpoint.js";
import { discoverModels, isUsable, toChoice, trainedWindow } from "./catalog.js";
import { buildRequest, toNativeMessages } from "./client.js";
import { LOCAL_WINDOW, localWindow, ownsModel, PREFIX, wireId } from "./manifest.js";

test("the server address follows OLLAMA_HOST the way Ollama reads it", () => {
  assert.equal(baseUrl({}), DEFAULT_URL);
  assert.equal(baseUrl({ OLLAMA_HOST: "0.0.0.0" }), "http://127.0.0.1:11434");
  assert.equal(baseUrl({ OLLAMA_HOST: "0.0.0.0:9999" }), "http://127.0.0.1:9999");
  assert.equal(baseUrl({ OLLAMA_HOST: "http://gpu-box:11434/" }), "http://gpu-box:11434");
  assert.equal(baseUrl({ OLLAMA_HOST: "x", MINDWEAVE_OLLAMA_URL: "http://elsewhere:1/" }), "http://elsewhere:1");
});

test("local ids are namespaced, so a local model is never taken for a cloud one", () => {
  assert.equal(wireId(`${PREFIX}qwen3:8b`), "qwen3:8b");
  assert.ok(ownsModel(`${PREFIX}llama3.1`));
  assert.ok(!ownsModel("qwen3-coder-plus"));
});

test("the window is 32K unless MINDWEAVE_OLLAMA_CONTEXT sets a sensible other size", () => {
  assert.equal(localWindow({}), LOCAL_WINDOW);
  assert.equal(localWindow({ MINDWEAVE_OLLAMA_CONTEXT: "16384" }), 16384);
  assert.equal(localWindow({ MINDWEAVE_OLLAMA_CONTEXT: "100" }), LOCAL_WINDOW, "too small to hold the instructions");
  assert.equal(localWindow({ MINDWEAVE_OLLAMA_CONTEXT: "lots" }), LOCAL_WINDOW);
});

test("only models that take tools can run an agent turn", () => {
  assert.ok(isUsable({ capabilities: ["completion", "tools"] }));
  assert.ok(!isUsable({ capabilities: ["completion"] }));
  assert.ok(!isUsable({ capabilities: ["embedding"] }));
  assert.ok(isUsable({})); // an older Ollama that lists nothing gets the benefit of the doubt
});

test("a listing becomes a free local choice with the model's own window, vision and thinking", () => {
  const show = { capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3.context_length": 40960 } };
  assert.equal(trainedWindow(show), 40960);
  const c = toChoice({ name: "qwen3:0.6b", size: 522_653_767, details: { parameter_size: "751.63M" } }, show);
  assert.equal(c.id, "ollama:qwen3:0.6b");
  assert.equal(c.facts?.contextWindow, LOCAL_WINDOW, "capped at the local window, not the trained 40K");
  assert.deepEqual(c.facts?.price, { cacheHit: 0, cacheMiss: 0, output: 0 });
  assert.deepEqual(c.facts?.thinkLevels?.map((l) => l.label), ["Standard", "Thinking"]);
  assert.equal(c.facts?.acceptsImages, false);
  const small = toChoice({ name: "tiny" }, { capabilities: ["tools", "vision"], model_info: { "x.context_length": 8192 } });
  assert.equal(small.facts?.contextWindow, 8192, "a model trained on less keeps its own figure");
  assert.equal(small.facts?.acceptsImages, true);
  assert.deepEqual(small.facts?.thinkLevels?.map((l) => l.label), ["Standard"]);
});

test("every request states its window, and thinking is switched off explicitly for Standard", () => {
  clearDiscovered();
  seedDiscovered("ollama", [toChoice({ name: "qwen3:0.6b" }, { capabilities: ["tools", "thinking"], model_info: { "q.context_length": 16384 } }), toChoice({ name: "plain" }, { capabilities: ["tools"] })], Date.now());
  const req = (model: string, thinking: boolean): ModelRequest => ({
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    model: { model, thinking, effort: thinking ? "high" : "low" },
  });
  const off = buildRequest(req("ollama:qwen3:0.6b", false), true);
  assert.equal(off.model, "qwen3:0.6b");
  assert.deepEqual(off.options, { num_ctx: 16384 });
  assert.equal(off.think, false, "a model that thinks by default must be told not to");
  assert.equal(buildRequest(req("ollama:qwen3:0.6b", true), true).think, true);
  assert.equal("think" in buildRequest(req("ollama:plain", false), true), false, "no switch for a model without one");
  assert.deepEqual(buildRequest(req("ollama:plain", false), false, 4096).options, { num_ctx: LOCAL_WINDOW, num_predict: 4096 });
  clearDiscovered();
});

test("messages are reshaped for /api/chat: bare images, object arguments, results named after their tool", () => {
  const out = toNativeMessages([
    { role: "user", content: "look", images: [{ path: "shot.png", mediaType: "image/png", data: "AAAA" }] },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "file text" },
  ]);
  assert.deepEqual(out[0], { role: "user", content: "look", images: ["AAAA"] });
  assert.deepEqual(out[1]!.tool_calls, [{ function: { name: "read_file", arguments: { path: "a.ts" } } }]);
  assert.equal(out[2]!.tool_name, "read_file");
});

test("connected while the server answers with a usable model, and not once it stops", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen3:0.6b" }] }));
      return new Response(JSON.stringify({ capabilities: ["tools"] }));
    }) as typeof fetch;
    const models = await discoverModels();
    assert.deepEqual(models.map((m) => m.id), ["ollama:qwen3:0.6b"]);
    assert.equal(process.env[RUNNING_ENV], "1");

    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/api/tags")
        ? new Response(JSON.stringify({ models: [{ name: "embed-only" }] }))
        : new Response(JSON.stringify({ capabilities: ["embedding"] }))) as typeof fetch;
    assert.deepEqual(await discoverModels(), []);
    assert.equal(process.env[RUNNING_ENV], undefined, "nothing usable pulled: nothing to run");

    process.env[RUNNING_ENV] = "1";
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await assert.rejects(discoverModels());
    assert.equal(process.env[RUNNING_ENV], undefined, "a stopped server is not connected");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env[RUNNING_ENV];
  }
});

test("a saved local model stays on Ollama before discovery has run", () => {
  clearDiscovered();
  assert.equal(manifestForModel("ollama:qwen3:8b").id, "ollama");
});
