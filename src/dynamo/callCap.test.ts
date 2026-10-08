/**
 * callCap.test.ts — one reply runs a bounded number of tool calls.
 *
 * A local provider answers the first request with 40 read_file calls in one reply. The
 * first 32 run; the rest are answered "not run" so the conversation stays well-formed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";

const CALLS = 40;
const SEP = String.fromCharCode(10, 10);
let requests = 0;
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      const frames: unknown[] = [];
      if (requests === 1) {
        for (let i = 0; i < CALLS; i++) {
          frames.push({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: i, id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } },
                  ],
                },
              },
            ],
          });
        }
        frames.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage });
      } else {
        frames.push({ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage });
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
});

test("only the first 32 calls of one reply run, and every call is answered", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-cap-")));
  writeFileSync(join(root, "a.txt"), "hello\n");
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.transcript.push({ role: "user", content: "read a.txt" });
  try {
    await respond(session, {});
    const results = session.transcript.filter((e) => e.role === "tool");
    assert.equal(results.length, CALLS, "every call has a result");
    const skipped = results.filter((e) => e.content.startsWith("Not run: this reply made 40 tool calls"));
    assert.equal(skipped.length, CALLS - 32);
    assert.ok(results.slice(0, 32).every((e) => !e.content.startsWith("Not run")), "the first 32 ran");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});
