/**
 * deferredByReference.test.ts — finding a tool without changing the tool list, for a provider that
 * can load a tool by reference (Anthropic), and without changing anything for one that cannot.
 *
 * The tool list is the first thing a provider hashes for its cache, so a tool that joins it
 * re-bills the system prompt and the whole conversation. A provider that loads found tools by
 * reference is sent every deferred tool on every request, marked as held back, and the search
 * result names the ones it loaded.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferredSchemas, toolSchemas } from "../tools/registry.js";
import { DEFERRED_TOOLS } from "../tools/deferredNative.js";
import type { ToolContext } from "../tools/types.js";
import { respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";

const names = (list: { function: { name: string } }[]) => list.map((t) => t.function.name);
const ctxWith = (...active: string[]) => ({ activatedTools: new Set(active) }) as unknown as ToolContext;

test("with a fixed list, finding a tool does not change the tools sent", () => {
  const before = names(toolSchemas({ ctx: ctxWith(), fixedList: true }));
  const after = names(toolSchemas({ ctx: ctxWith("screenshot", "ui", "web"), fixedList: true }));
  assert.deepEqual(after, before, "a found tool changed the list, which re-bills the whole conversation");
  assert.ok(!before.includes("screenshot"));
});

test("without it, a found tool joins the list, as for every other provider", () => {
  const plain = names(toolSchemas({ ctx: ctxWith() }));
  const found = names(toolSchemas({ ctx: ctxWith("screenshot") }));
  assert.ok(found.includes("screenshot") && !plain.includes("screenshot"));
});

test("the held-back list is every deferred tool, the same whatever has been found", () => {
  const held = names(deferredSchemas({ ctx: ctxWith(), fixedList: true }));
  assert.deepEqual(held, names(deferredSchemas({ ctx: ctxWith("screenshot", "ui"), fixedList: true })));
  for (const t of DEFERRED_TOOLS) assert.ok(held.includes(t.name), `${t.name} is missing from the held-back list`);
  const loaded = names(toolSchemas({ ctx: ctxWith(), fixedList: true }));
  assert.deepEqual(held.filter((n) => loaded.includes(n)), [], "a tool is both loaded and held back");
});

test("planning offers no held-back tool that changes anything", () => {
  const held = names(deferredSchemas({ ctx: ctxWith(), fixedList: true, planMode: true }));
  assert.ok(!held.includes("ui") && !held.includes("replace_symbol_body"), JSON.stringify(held));
  assert.ok(held.includes("outline"), "a read-only held-back tool went missing in plan mode");
});

// ── through the real engine, against a provider that does not load by reference ──

type Body = { messages: { role: string; content?: unknown }[]; tools?: { function: { name: string } }[] };
let bodies: Body[] = [];
let script: { tools?: { name: string; args: unknown }[]; text?: string }[] = [];
let server: Server;
before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const reply = script.shift() ?? { text: "done" };
      const frames: unknown[] = [];
      if (reply.text) frames.push({ choices: [{ delta: { content: reply.text } }] });
      (reply.tools ?? []).forEach((t, index) => {
        frames.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${bodies.length}_${index}`, type: "function", function: { name: t.name, arguments: "" } }] } }] });
        frames.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(t.args) } }] } }] });
      });
      frames.push({ choices: [{ delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const SEP = String.fromCharCode(10, 10);
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
const made: Awaited<ReturnType<typeof createSession>>[] = [];
after(async () => {
  for (const s of made) await stopChassis(s.toolContext.chassis).catch(() => {});
  server.close();
});

test("a result that loaded tools is recorded with their names, and a provider without references still gets them listed", async () => {
  bodies = [];
  script = [{ tools: [{ name: "find_tools", args: { query: "screenshot" } }] }, { text: "ok" }];
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-ref-")));
  const session = await createSession(root);
  made.push(session);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.transcript.push({ role: "user", content: "take a screenshot" });
  await respond(session, {});

  const result = session.transcript.find((e) => e.role === "tool");
  assert.ok(result && result.role === "tool");
  assert.deepEqual(result.loaded, ["screenshot", "ui"]);
  assert.match(result.content, /"name":"ui"/, "the schemas are still in the text, for providers that read text");

  // Gemini cannot load by reference: the found tools join its list, and no deferred list is sent.
  const second = bodies[1]!;
  assert.ok(names(second.tools as { function: { name: string } }[]).includes("screenshot"));
  assert.ok(!JSON.stringify(second).includes("defer_loading"));
});

// ── through the real engine and the real Anthropic client ──

type AnthropicBody = {
  tools?: { name: string; defer_loading?: boolean }[];
  messages: { role: string; content: unknown }[];
};
let anthropicBodies: AnthropicBody[] = [];
let anthropicScript: ({ tool: { name: string; input: unknown } } | { text: string })[] = [];
let anthropicServer: Server;
before(async () => {
  anthropicServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      anthropicBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const step = anthropicScript.shift() ?? { text: "done" };
      const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
      let out = ev("message_start", { message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
      if ("tool" in step) {
        out += ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `tu_${anthropicBodies.length}`, name: step.tool.name, input: {} } });
        out += ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.tool.input) } });
      } else {
        out += ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        out += ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: step.text } });
      }
      out += ev("content_block_stop", { index: 0 });
      out += ev("message_delta", { delta: { stop_reason: "tool" in step ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      out += ev("message_stop", {});
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(out);
    });
  });
  await new Promise<void>((r) => anthropicServer.listen(0, "127.0.0.1", r));
});
after(() => void anthropicServer.close());

test("on Anthropic, finding a tool leaves the tool list byte for byte the same and the result is a reference", async () => {
  const before = process.env["ANTHROPIC_BASE_URL"];
  process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(anthropicServer.address() as { port: number }).port}`;
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  try {
    anthropicBodies = [];
    anthropicScript = [{ tool: { name: "find_tools", input: { query: "screenshot" } } }, { text: "ok" }];
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-ref-a-")));
    const session = await createSession(root);
    made.push(session);
    session.modelConfig = { model: "claude-sonnet-5-5", thinking: false, effort: "low" };
    session.transcript.push({ role: "user", content: "take a screenshot" });
    await respond(session, {});

    const [first, second] = anthropicBodies;
    assert.ok(first && second, `expected two requests, got ${anthropicBodies.length}`);
    assert.deepEqual(second.tools, first.tools, "finding a tool changed the tool list, which invalidates the whole cache");
    const held = first.tools!.filter((t) => t.defer_loading);
    assert.ok(held.some((t) => t.name === "screenshot") && held.some((t) => t.name === "ui"), "the deferred tools were not sent as held back");
    assert.ok(first.tools!.some((t) => t.name === "find_tools" && !t.defer_loading), "the search tool must be loaded from the start");
    assert.ok(!first.tools!.filter((t) => !t.defer_loading).some((t) => t.name === "ui"));

    const results = second.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; content?: unknown }[]) : [])).filter((b) => b.type === "tool_result");
    assert.deepEqual(results[0]!.content, [
      { type: "tool_reference", tool_name: "screenshot" },
      { type: "tool_reference", tool_name: "ui" },
    ]);
  } finally {
    if (before === undefined) delete process.env["ANTHROPIC_BASE_URL"];
    else process.env["ANTHROPIC_BASE_URL"] = before;
  }
});
