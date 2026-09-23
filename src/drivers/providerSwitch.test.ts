/**
 * providerSwitch.test.ts — what survives a mid-session /provider change.
 *
 * A single-vendor agent has no equivalent problem: nothing in its transcript can ever
 * hazard. A tool call carries an opaque, provider-specific blob — Gemini attaches a
 * `thought_signature` and returns 400 on the next request if it comes back missing — and
 * the transcript outlives the provider that produced it.
 *
 * Measured before this existed: after switching from Gemini to another provider on the
 * same transport, Google's signature was sent to them verbatim under `extra_content`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toWireMessages } from "./openaiCompat/wire.js";
import type { ChatMessage } from "./types.js";

const SIGNATURE = "google-thought-signature-blob";

function conversation(meta?: Record<string, unknown>): ChatMessage[] {
  return [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
          ...(meta ? { meta } : {}),
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ];
}

const wire = (m: ChatMessage[], provider: string) => JSON.stringify(toWireMessages(m, provider));

test("a provider gets its OWN opaque data back", () => {
  // The reason the field exists at all: without it Gemini 3 makes exactly one tool call
  // per conversation and then rejects every follow-up.
  const out = wire(conversation({ extra_content: { google: { thought_signature: SIGNATURE } }, provider: "Gemini" }), "Gemini");
  assert.ok(out.includes(SIGNATURE), "Gemini lost its own signature — tool use will 400");
  assert.ok(out.includes("extra_content"), "spliced under the name the provider expects");
});

test("another provider does NOT get it after a switch", () => {
  const out = wire(conversation({ extra_content: { google: { thought_signature: SIGNATURE } }, provider: "Gemini" }), "DeepSeek");
  assert.ok(!out.includes(SIGNATURE), "one vendor's internal data was handed to another");
  assert.ok(!out.includes("extra_content"), "an unknown key was still put on their request");
  // The call itself must survive intact — dropping it would orphan its result.
  assert.ok(out.includes("call_1"), "the tool call was lost along with the blob");
  assert.ok(out.includes("read_file"));
});

test("an UNTAGGED blob is still replayed, so old sessions keep working", () => {
  // It can only have come from a session recorded before the tag existed, and dropping
  // it would break exactly the resumed Gemini sessions that still carry one.
  const out = wire(conversation({ extra_content: { google: { thought_signature: SIGNATURE } } }), "Gemini");
  assert.ok(out.includes(SIGNATURE));
});

test("a call with no blob is unchanged whoever is running", () => {
  for (const provider of ["Gemini", "DeepSeek", ""]) {
    const out = wire(conversation(), provider);
    assert.ok(!out.includes("extra_content"), `${provider} was sent an empty extra_content`);
    assert.ok(out.includes("call_1"));
  }
});

test("the tool_call/result pairing survives the switch, whatever is dropped", () => {
  // The one thing that must never break: a provider rejects the whole request if a
  // tool_call has no matching result, so a switch must not cost either half.
  const out = toWireMessages(
    conversation({ extra_content: { google: { thought_signature: SIGNATURE } }, provider: "Gemini" }),
    "Qwen",
  );
  const calls = out.filter((m) => Array.isArray((m as { tool_calls?: unknown[] }).tool_calls));
  const results = out.filter((m) => (m as { role?: string }).role === "tool");
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal((results[0] as { tool_call_id: string }).tool_call_id, "call_1");
});


// ── an image outliving the model that could see it ───────────────────────────

/**
 * The other half of a /provider switch, driven through a real turn.
 *
 * A picture attached while a vision model was running stays in the transcript. Measured
 * before this was gated: it was re-encoded and re-sent as an `image_url` part on every
 * later request, to a model that declares it cannot read one — wasted on every step, and
 * a text-only endpoint is entitled to reject the request outright.
 */
import { test as t2 } from "node:test";
import { createServer, type Server } from "node:http";
import { promises as fsp, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "../dynamo/engine.js";
import type { Session } from "../memory/types.js";

t2("an image is NOT replayed to a model that cannot see it, and the model is told why", async () => {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const SEP = String.fromCharCode(10, 10);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + SEP);
      res.write(
        "data: " +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }) +
          SEP,
      );
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.MINDWEAVE_GEMINI_URL = `http://127.0.0.1:${port}`;

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-switch-")));
  const shot = join(root, "screenshot.png");
  await fsp.writeFile(shot, Buffer.from("PNGBYTESPNGBYTES"));

  const s = {
    id: "s1",
    cwd: root,
    // gemini-3.7-flash declares acceptsImages: false — the state after switching away
    // from a vision model without clearing the conversation.
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    transcript: [
      { role: "user", content: "look at this", images: [{ path: shot, mediaType: "image/png" }] },
    ],
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [] },
  } as unknown as Session;

  await respond(s);
  server.close();

  const sent = bodies.join("");
  assert.ok(!sent.includes("image_url"), "an image part was sent to a model that cannot read one");
  assert.ok(!sent.includes(Buffer.from("PNGBYTESPNGBYTES").toString("base64")), "the bytes went out anyway");
  // Silently dropping it would read as a picture the model failed to notice.
  assert.ok(sent.includes("cannot see images"), "the model was not told why the image is absent");
  assert.ok(sent.includes("look at this"), "the message itself was lost with its image");
});

t2("an image in a format the model rejects is held back, and the model is told which formats work", async () => {
  // Grok takes JPG and PNG only. A WebP sent anyway fails the whole request at the
  // provider; held back with a reason, the agent can tell the user what to do.
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const SEP = String.fromCharCode(10, 10);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + SEP);
      res.write(
        "data: " +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }) +
          SEP,
      );
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.XAI_API_KEY = "test-key";
  process.env.MINDWEAVE_XAI_URL = `http://127.0.0.1:${port}`;

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-imgtype-")));
  const png = join(root, "chart.png");
  const webp = join(root, "photo.webp");
  await fsp.writeFile(png, Buffer.from("PNGBYTESPNGBYTES"));
  await fsp.writeFile(webp, Buffer.from("WEBPBYTESWEBPBYTES"));

  const s = {
    id: "s2",
    cwd: root,
    modelConfig: { model: "grok-4.7", thinking: true, effort: "high" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    transcript: [
      {
        role: "user",
        content: "compare these",
        images: [
          { path: png, mediaType: "image/png" },
          { path: webp, mediaType: "image/webp" },
        ],
      },
    ],
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [] },
  } as unknown as Session;

  await respond(s);
  server.close();

  const sent = bodies.join("");
  assert.ok(sent.includes(Buffer.from("PNGBYTESPNGBYTES").toString("base64")), "the PNG, which Grok takes, was not sent");
  assert.ok(!sent.includes(Buffer.from("WEBPBYTESWEBPBYTES").toString("base64")), "the WebP went out and would fail the request");
  assert.ok(sent.includes("photo.webp was attached but not sent"), "the model was not told the WebP was held back");
  assert.ok(sent.includes("accepts only JPG and PNG images"), "the model was not told which formats work");
});
