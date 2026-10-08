/**
 * notesInTail.test.ts — the session notes are sent only when they add something.
 *
 * They ride in the per-call tail, which is never cached, and were sent on every call: a
 * median of 2.7K uncached tokens a call while the conversation still held everything
 * they summarise, and the same text twice after a compaction made from them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEARED_STUB, RECAP_STUB, notesAddSomething } from "./compaction.js";
import { respond } from "../dynamo/engine.js";
import { createSession } from "./session.js";
import { stopChassis } from "../alternator/lane.js";
import type { Entry } from "./types.js";

const NOTES = "## Current state\nThe parser is half rewritten; tests in src/parse.test.ts fail on line 40.";

test("nothing lost: the notes are a second copy and are not sent", () => {
  const whole: Entry[] = [
    { role: "user", content: "fix the parser" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
    { role: "tool", toolCallId: "1", content: "export const a = 1;" },
  ];
  assert.equal(notesAddSomething(whole, NOTES), false);
  assert.equal(notesAddSomething(whole, ""), false);
});

test("a cleared result, a condensed reply or a compaction makes them worth sending", () => {
  assert.equal(notesAddSomething([{ role: "tool", toolCallId: "1", content: `x\n${CLEARED_STUB}` }], NOTES), true);
  assert.equal(notesAddSomething([{ role: "assistant", content: RECAP_STUB }], NOTES), true);
  assert.equal(notesAddSomething([{ role: "summary", content: "Earlier: an LLM-written summary." }], NOTES), true);
});

test("not twice: notes already in the conversation as the compaction summary are not repeated", () => {
  const transcript: Entry[] = [{ role: "summary", content: `Resuming. ${NOTES}` }, { role: "tool", toolCallId: "1", content: CLEARED_STUB }];
  assert.equal(notesAddSomething(transcript, NOTES), false);
  // Once the notes have moved on past the summary, they say something it does not.
  assert.equal(notesAddSomething(transcript, `${NOTES}\n## Worklog\n- fixed line 40`), true);
});

// ── on the wire ──────────────────────────────────────────────────────────────

let bodies: string[] = [];
let server: Server;
const SEP = String.fromCharCode(10, 10);

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + SEP);
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage }) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

test("the request carries the notes only after something was cleared", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-notes-tail-")));
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.sessionMemory = NOTES;
  session.sessionMemoryInit = true;
  try {
    bodies = [];
    session.transcript.push({ role: "user", content: "first" });
    await respond(session, {});
    assert.ok(!bodies.at(-1)!.includes("tests in src/parse.test.ts fail"), "notes sent while nothing was lost");

    session.transcript.push(
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
      { role: "tool", toolCallId: "t1", content: `a.ts\n${CLEARED_STUB}` },
      { role: "user", content: "second" },
    );
    await respond(session, {});
    assert.ok(bodies.at(-1)!.includes("tests in src/parse.test.ts fail"), "notes missing once a result was cleared");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});
