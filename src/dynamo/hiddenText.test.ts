/**
 * hiddenText.test.ts — characters a person cannot see never reach the model.
 *
 * ASCII has an invisible twin in the Unicode tag block, so a project notes file, a file
 * the model reads or a pasted message can carry an instruction nobody reviewing it can
 * see. The request builder removes such characters from everything except the model's
 * own replies (see tools/invisible.ts). These tests run a real session against a local
 * provider and inspect the request bodies it receives.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";

const hide = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
const isTag = (c: string) => {
  const p = c.codePointAt(0)!;
  return p >= 0xe0000 && p <= 0xe007f;
};

let bodies: string[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      // First request: read the file. Second: answer.
      const frames =
        bodies.length === 1
          ? [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: "c0", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } },
                      ],
                    },
                  },
                ],
              },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
            ]
          : [{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }];
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

after(() => {
  server.close();
});

test("hidden text in notes, a file and the user's message is removed from every request", async () => {
  bodies = [];
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-hidden-")));
  writeFileSync(join(root, "MINDWEAVE.md"), `# Notes\nUse tabs.${hide("NOTES")}\n`);
  writeFileSync(join(root, "a.txt"), `hello${hide("FILE")}\n`);
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.transcript.push({ role: "user", content: `read a.txt${hide("USER")}` });
  try {
    await respond(session, {});
    assert.equal(bodies.length, 2, "one request to read the file, one to answer");
    for (const raw of bodies) {
      // Counted both as raw characters and as JSON escapes, whichever way the driver encodes them.
      assert.equal([...raw].filter(isTag).length + (raw.match(/\\udb40/gi) ?? []).length, 0, "a hidden character reached the model");
    }
    const last = bodies[1]!;
    assert.match(last, /Use tabs\./, "the visible notes are still sent");
    assert.match(last, /hello/, "the visible file text is still sent");
    assert.match(last, /hidden characters removed/, "the model is told the text was altered");
    const stored = session.transcript.find((e) => e.role === "tool");
    assert.ok(stored?.content.includes(hide("FILE")), "the transcript keeps the original");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a handle; the folder is in the temp directory */
    }
  }
});

test("a real request never carries a <working_files> block", async () => {
  // The block that re-sent the current contents of active files on every call was removed because it cost
  // up to 12K uncached tokens a call. Comments and tool text kept describing it for a long time; this is the
  // check on what is actually sent.
  bodies = [];
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-nowf-")));
  writeFileSync(join(root, "a.txt"), "hello\n");
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.transcript.push({ role: "user", content: "read a.txt" });
  try {
    await respond(session, {});
    assert.ok(bodies.length >= 2, "the turn should have used a tool");
    for (const body of bodies) assert.ok(!body.includes("working_files"), "a request mentions a block that is not sent");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* temp folder */
    }
  }
});
