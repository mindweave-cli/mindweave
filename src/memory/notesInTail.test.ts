/**
 * notesInTail.test.ts — the session notes are never sent with a turn.
 *
 * They stand in for the part of a conversation a compaction cuts away, and are used there.
 * They used to ride in every request once anything had been cleared, labelled "trust
 * these", and a copy that lagged behind what had just happened contradicted the
 * conversation the model was in: a real session spent twenty-five calls saying its own
 * memory was corrupt. While the conversation holds everything it is the only source; after
 * a compaction the notes ARE the summary entry. Neither needs a second copy per turn.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEARED_STUB } from "./compaction.js";
import { respond } from "../dynamo/engine.js";
import { createSession } from "./session.js";
import { stopChassis } from "../alternator/lane.js";

const NOTES = "## Current state\nThe parser is half rewritten; tests in src/parse.test.ts fail on line 40.";

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

test("the request never carries the notes, whatever has been cleared or summarised", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-notes-tail-")));
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.sessionMemory = NOTES;
  session.sessionMemoryInit = true;
  const THE_NOTES = "tests in src/parse.test.ts fail";
  try {
    bodies = [];
    session.transcript.push({ role: "user", content: "first" });
    await respond(session, {});
    assert.ok(!bodies.at(-1)!.includes(THE_NOTES), "notes sent while nothing was lost");

    // A cleared result used to be what made them worth sending.
    session.transcript.push(
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
      { role: "tool", toolCallId: "t1", content: `a.ts
${CLEARED_STUB}` },
      { role: "user", content: "second" },
    );
    await respond(session, {});
    assert.ok(!bodies.at(-1)!.includes(THE_NOTES), "notes sent after a result was cleared");

    // And so did a summary in front of the conversation.
    session.transcript.unshift({ role: "summary", content: "Earlier: the parser was being rewritten." });
    session.transcript.push({ role: "user", content: "third" });
    await respond(session, {});
    assert.ok(!bodies.at(-1)!.includes(THE_NOTES), "notes sent after a compaction summary");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});
