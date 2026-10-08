/**
 * callTags.test.ts — every call's record says why the cache broke, whether the model
 * was thinking, and how much of its output nobody saw.
 *
 * The cache-break verdict was computed on every call and then thrown away unless a log
 * variable was set, and hidden reasoning (most of what thinking models generate) was not
 * recorded anywhere, so neither could be measured from saved sessions.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTags, respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";

const SEP = String.fromCharCode(10, 10);
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      // A short visible reply that the provider says cost 800 generated tokens.
      const usage = { prompt_tokens: 1000, completion_tokens: 800, total_tokens: 1800 };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "Done." } }] }) + SEP);
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage }) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

test("a saved call record carries the thinking setting and the hidden output", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-tags-")));
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: true, effort: "high" };
  session.transcript.push({ role: "user", content: "hello" });
  try {
    await respond(session, {});
    const record = session.callLog?.at(-1);
    assert.ok(record, "the call was recorded");
    assert.equal(record.thinking, true);
    assert.equal(record.effort, "high");
    assert.ok((record.hidden ?? 0) > 700, `hidden output: ${record.hidden}`);
    assert.equal(typeof record.tail, "number");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("the cache-break reason is kept, and absent when nothing broke", () => {
  const result = { content: "ok", toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheHitTokens: 0, cacheMissTokens: 10 } };
  const request = { context: "", model: { model: "m", thinking: false, effort: "high" as const } };
  assert.equal(callTags(result, request, { detail: "history: message 41 changed" }).broke, "history: message 41 changed");
  assert.equal("broke" in callTags(result, request, null), false);
  assert.equal(callTags(result, request, null).thinking, false);
});
