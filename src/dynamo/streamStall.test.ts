/**
 * streamStall.test.ts — a provider that goes silent no longer hangs the turn.
 *
 * A local provider sends one text frame and then neither sends more nor closes the
 * connection. Before the watchdog the turn stayed "working" until the user pressed Esc.
 * The limits are shortened through their environment variables so the test is quick.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";

const SEP = String.fromCharCode(10, 10);
/** How each request is answered, in order: "stall" sends one frame and never finishes,
 *  "silent" sends nothing at all and never finishes. */
let script: ("stall" | "silent" | "answer")[] = [];
let requests = 0;
const open: ServerResponse[] = [];
let server: Server;

before(async () => {
  process.env["MINDWEAVE_STREAM_IDLE_MS"] = "400";
  process.env["MINDWEAVE_STREAM_FIRST_EVENT_MS"] = "400";
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const mode = script[requests++] ?? "answer";
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "silent") {
        res.flushHeaders();
        open.push(res);
        return;
      }
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "Working on it" } }] }) + SEP);
      if (mode === "stall") {
        open.push(res);
        return;
      }
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: ". Done." } }] }) + SEP);
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage }) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  for (const res of open) res.destroy();
  server.close();
  delete process.env["MINDWEAVE_STREAM_IDLE_MS"];
  delete process.env["MINDWEAVE_STREAM_FIRST_EVENT_MS"];
});

async function turn(): Promise<{ reply: string; resets: number; ms: number }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-stall-")));
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.transcript.push({ role: "user", content: "hello" });
  let resets = 0;
  const t0 = Date.now();
  try {
    // A hard stop for the test itself, far beyond the limits under test.
    const reply = await respond(session, {
      signal: AbortSignal.timeout(20_000),
      onEvent: (e) => {
        if (e.type === "replyReset") resets++;
      },
    });
    return { reply, resets, ms: Date.now() - t0 };
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
}

test("a stalled stream is retried once and the retry's answer is the reply", async () => {
  script = ["stall", "answer"];
  requests = 0;
  const { reply, resets, ms } = await turn();
  assert.equal(requests, 2, "the request was sent again");
  assert.equal(reply, "Working on it. Done.", "only the retry's text is the reply");
  assert.equal(resets, 1, "the stalled partial text was cleared from the screen");
  assert.ok(ms < 10_000, `took ${ms} ms`);
});

test("a stream that stalls twice pauses the task instead of hanging", async () => {
  script = ["stall", "stall"];
  requests = 0;
  const { reply, ms } = await turn();
  assert.equal(requests, 2);
  assert.match(reply, /Paused/);
  assert.match(reply, /continue/i);
  assert.ok(ms < 10_000, `took ${ms} ms`);
});

test("a provider that never sends a first event is retried, then pauses", async () => {
  script = ["silent", "silent"];
  requests = 0;
  const { reply, ms } = await turn();
  assert.equal(requests, 2);
  assert.match(reply, /sent nothing for .* twice in a row/);
  assert.ok(ms < 10_000, `took ${ms} ms`);
});
