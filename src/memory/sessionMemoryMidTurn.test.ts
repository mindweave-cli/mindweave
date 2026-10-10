/**
 * sessionMemoryMidTurn.test.ts — a long run of tool calls is ONE turn, and the notes do not
 * wait for it to end.
 *
 * The notes were refreshed only when a turn started or ended. A turn of dozens of tool calls
 * therefore left them behind for its whole length, which is exactly when a compaction needs
 * them most. The refresh now runs after a round of tool results, in the background, and the
 * turn that started it does not wait for it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "../dynamo/engine.js";
import { createSession } from "./session.js";
import { SESSION_MEMORY_TEMPLATE } from "./sessionMemory.js";
import { estimateEntriesTokens } from "./compaction.js";
import { stopChassis } from "../alternator/lane.js";

const SEP = String.fromCharCode(10, 10);
const NEW_NOTES = SESSION_MEMORY_TEMPLATE + "\nwritten in the middle of the turn";

let events: string[] = [];
let streamCalls = 0;
let auxSeen: () => void = () => {};
let auxArrived: Promise<void> = new Promise((r) => (auxSeen = r));
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
      if (!/"stream"\s*:\s*true/.test(body)) {
        // The notes call: not streamed.
        events.push("notes asked");
        auxSeen();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: NEW_NOTES }, finish_reason: "stop" }], usage }));
        return;
      }
      streamCalls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (streamCalls === 1) {
        // Three reads in one round, of three different files.
        const call = (i: number) => ({
          choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ paths: [`file${i}.txt`] }) } }] } }],
        });
        for (const f of [call(0), call(1), call(2), { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage }]) res.write("data: " + JSON.stringify(f) + SEP);
        res.end("data: [DONE]" + SEP);
        return;
      }
      // The answer comes only once the notes call has been made, or after three seconds. If the
      // refresh waited for the end of the turn it could not have been made by then.
      await Promise.race([auxArrived, new Promise((r) => setTimeout(r, 3_000))]);
      events.push("answer sent");
      for (const f of [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }]) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

test("the notes are refreshed after a round of tool calls, before the turn is over", async () => {
  events = [];
  streamCalls = 0;
  auxArrived = new Promise((r) => (auxSeen = r));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-notes-mid-")));
  // Three files a read takes whole, together enough to count as growth.
  for (const n of [0, 1, 2]) writeFileSync(join(root, `file${n}.txt`), "a line of the file that is long enough to count for something\n".repeat(150));
  const s = await createSession(root);
  s.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  s.transcript.push({ role: "user", content: "read the three files and tell me" });
  // The notes are fully up to date when the turn starts, so only the turn's own work can make them due.
  s.sessionMemory = SESSION_MEMORY_TEMPLATE + "\nthe state before the turn";
  s.sessionMemoryInit = true;
  s.sessionMemoryEntries = s.transcript.length;
  s.sessionMemoryTokens = estimateEntriesTokens(s.transcript);
  try {
    await respond(s, {});
    const notes = events.indexOf("notes asked");
    const answer = events.indexOf("answer sent");
    assert.ok(notes >= 0, `the notes were never refreshed: ${events.join(", ")}`);
    assert.ok(notes < answer, `the refresh only came after the answer: ${events.join(", ")}`);
    assert.match(s.sessionMemory ?? "", /written in the middle of the turn/, "and its result is the notes");
    assert.ok((s.sessionMemoryEntries ?? 0) > 1, "with a boundary past the first entry");
    assert.equal(s.sessionMemoryRun, undefined, "nothing is left running when the turn is over");
  } finally {
    await stopChassis(s.toolContext.chassis).catch(() => {});
  }
});
