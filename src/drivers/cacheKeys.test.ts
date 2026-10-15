/**
 * cacheKeys.test.ts — the conversation id each provider is given so a later request is routed to
 * the place its cache was written.
 *
 * Providers that hold a cache per server (xAI), per route (OpenAI, Mistral) or per upstream host
 * (OpenRouter) only reuse it when told which requests belong together. The id is the session's
 * random id, so none of this identifies a person or a project, and a request without one carries
 * nothing extra.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { ModelRequest } from "./types.js";
import { conversationHeader, xaiProvider } from "./xai/client.js";
import { mistralProvider } from "./mistral/client.js";
import { buildBody } from "./openai/client.js";
import { compatToolTurn, type CompatProvider } from "./openaiCompat/wire.js";

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

test("xAI is given the conversation id as x-grok-conv-id", () => {
  assert.deepEqual(conversationHeader(req({ sessionId: "abc-123" })), { "x-grok-conv-id": "abc-123" });
  assert.equal(conversationHeader(req()), undefined, "a request with no id sent a header anyway");
  assert.equal(xaiProvider.requestHeaders, conversationHeader);
});

test("Mistral is given the conversation id as prompt_cache_key", () => {
  const body = { model: "m", messages: [] };
  assert.deepEqual(mistralProvider.finishBody!(body, req({ sessionId: "abc-123" })), { ...body, prompt_cache_key: "abc-123" });
  assert.equal("prompt_cache_key" in mistralProvider.finishBody!(body, req()), false);
});

test("OpenAI is given the conversation id as prompt_cache_key", () => {
  assert.equal(buildBody(req({ sessionId: "abc-123", model: { model: "gpt-5.6-terra", thinking: false, effort: "low" } }), 1000).prompt_cache_key, "abc-123");
  assert.equal("prompt_cache_key" in buildBody(req(), 1000), false);
});

let server: Server;
let seen: Record<string, string | string[] | undefined> = {};
before(async () => {
  server = createServer((r, res) => {
    seen = r.headers;
    r.resume();
    r.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(() => void server.close());

test("a header that depends on the request reaches the provider, and only on that request", async () => {
  process.env["TEST_KEY"] = "k";
  const provider: CompatProvider = {
    label: "T",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    apiKeyEnv: "TEST_KEY",
    defaultModel: "m",
    reasoningFields: () => ({}),
    cacheSplit: () => undefined,
    bufferedMaxTokens: 100,
    headers: { "x-static": "1" },
    requestHeaders: conversationHeader,
  };
  await compatToolTurn(provider, req({ sessionId: "conv-9" }));
  assert.equal(seen["x-grok-conv-id"], "conv-9");
  assert.equal(seen["x-static"], "1", "the provider's own headers were lost");
  await compatToolTurn(provider, req());
  assert.equal(seen["x-grok-conv-id"], undefined, "a request without an id inherited the previous one");
});
