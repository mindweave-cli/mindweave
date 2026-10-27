/**
 * notesShared.test.ts — during real work the notes writer builds on the main request, so the
 * provider reads the conversation from the cache the main calls filled.
 *
 * The notes call used to carry its own system prompt and its own condensed copy of the recent
 * entries, which shares nothing with the main conversation: every refresh was read at full price
 * (0.6% cache hits across a real session's eleven refreshes, a third of all its misses). Built on the
 * main request, the system prompt, the tools and the beginning of the conversation are byte for byte
 * what the provider already holds. These run a whole turn against a local server and compare what
 * the two calls actually put on the wire.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "../dynamo/engine.js";
import { createSession } from "./session.js";
import { estimateEntriesTokens } from "./compaction.js";
import { SESSION_MEMORY_TEMPLATE } from "./sessionMemory.js";
import { stopChassis } from "../alternator/lane.js";

const SEP = String.fromCharCode(10, 10);

type Wire = { messages: { role: string; content?: string; tool_calls?: unknown }[]; tools?: unknown[]; stream?: boolean };
let streamed: Wire[] = [];
let notesCalls: Wire[] = [];
let notesSeen: () => void = () => {};
let notesArrived: Promise<void> = new Promise((r) => (notesSeen = r));
let streamCalls = 0;
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const wire = JSON.parse(body) as Wire;
      const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
      if (!wire.stream) {
        notesCalls.push(wire);
        notesSeen();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "# Current State\nwritten from the shared call" }, finish_reason: "stop" }], usage }));
        return;
      }
      streamed.push(wire);
      streamCalls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (streamCalls === 1) {
        const call = (i: number) => ({
          choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ paths: [`file${i}.txt`] }) } }] } }],
        });
        for (const f of [call(0), call(1), call(2), { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage }]) res.write("data: " + JSON.stringify(f) + SEP);
        res.end("data: [DONE]" + SEP);
        return;
      }
      // The answer waits for the notes call, so the two are in flight in the order the turn makes them.
      await Promise.race([notesArrived, new Promise((r) => setTimeout(r, 3_000))]);
      for (const f of [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }]) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

test("the notes call carries the same system prompt, tools and conversation as the main call, then its instruction", async () => {
  streamed = [];
  notesCalls = [];
  streamCalls = 0;
  notesArrived = new Promise((r) => (notesSeen = r));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-notes-shared-")));
  for (const n of [0, 1, 2]) writeFileSync(join(root, `file${n}.txt`), "a line of the file that is long enough to count for something\n".repeat(150));
  const s = await createSession(root);
  s.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  s.transcript.push({ role: "user", content: "read the three files and tell me" });
  s.sessionMemory = SESSION_MEMORY_TEMPLATE + "\nthe state before the turn";
  s.sessionMemoryInit = true;
  s.sessionMemoryEntries = s.transcript.length;
  s.sessionMemoryTokens = estimateEntriesTokens(s.transcript);
  try {
    await respond(s, {});
    assert.equal(notesCalls.length >= 1, true, "the notes were refreshed in the middle of the turn");
    const notes = notesCalls[0]!;
    const second = streamed[1]!;
    assert.ok(second, "the turn went on to a second call");

    // The same beginning, byte for byte: system prompt first, then the conversation up to the last
    // message the main call carried (its volatile tail is the one thing it adds on the end).
    assert.equal(notes.messages[0]!.content, second.messages[0]!.content, "the same system prompt");
    const tail = String(second.messages.at(-1)?.content ?? "").startsWith("<current_context>");
    const mainConversation = tail ? second.messages.slice(0, -1) : second.messages;
    assert.deepEqual(notes.messages.slice(0, mainConversation.length), mainConversation, "the same conversation, entry for entry");
    assert.deepEqual(notes.tools, second.tools, "the same tools, because they are part of what the provider caches");

    // ...and then one message more, which is the instruction.
    assert.equal(notes.messages.length, mainConversation.length + 1);
    const instruction = notes.messages.at(-1)!;
    assert.equal(instruction.role, "user");
    assert.match(instruction.content ?? "", /CURRENT NOTES\. They already cover everything up to and including/);
    assert.match(instruction.content ?? "", /the state before the turn/, "it hands over the notes as they are");
    assert.ok(!(instruction.content ?? "").includes("<current_context>"), "not the main call's volatile tail");

    assert.match(s.sessionMemory ?? "", /written from the shared call/);
    assert.ok((s.sessionMemoryEntries ?? 0) > 1, "and it covers the round it just read");
  } finally {
    await stopChassis(s.toolContext.chassis).catch(() => {});
  }
});
