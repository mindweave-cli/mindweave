/**
 * counters.test.ts — a session counts what it did, and the calls nobody asked for are on the record.
 *
 * Every number behind the decisions on re-reading, forgetting and cost had to be rebuilt
 * afterwards from saved transcripts. These pin the counting rules, that the counts and the
 * tagged background calls survive a save and a resume, and that a real turn produces them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countRound, countStubbed, countSteers, emptyCounters } from "./counters.js";
import { recordAuxCall, respond } from "../dynamo/engine.js";
import { createSession, resumeSession } from "./session.js";
import { saveSession } from "./store.js";
import { stopChassis } from "../alternator/lane.js";
import type { Session } from "./types.js";

const id = (p: string) => p;
const fake = () => ({ counters: undefined }) as unknown as Session;
const read = (...paths: string[]) => ({ name: "read_file", args: { paths } });

test("a first read is a read; a second is a repeat, and which kind depends on what the model can still see", () => {
  const s = fake();
  countRound(s, [read("a.ts", "b.ts")], id, new Set());
  assert.deepEqual([s.counters!.reads, s.counters!.rereadsVisible, s.counters!.rereadsCleared], [2, 0, 0]);
  // a.ts is still whole in the conversation: reading it again gained nothing.
  countRound(s, [read("a.ts")], id, new Set(["a.ts"]));
  assert.deepEqual([s.counters!.rereadsVisible, s.counters!.rereadsCleared], [1, 0]);
  // b.ts was cleared (or was only a range): reading it again is forgetting, or a new need.
  countRound(s, [read("b.ts")], id, new Set(["a.ts"]));
  assert.deepEqual([s.counters!.rereadsVisible, s.counters!.rereadsCleared], [1, 1]);
});

test("an edit in between makes the next read a new read, not a repeat", () => {
  const s = fake();
  countRound(s, [read("a.ts")], id, new Set());
  countRound(s, [{ name: "edit", args: { path: "a.ts" } }], id, new Set());
  countRound(s, [read("a.ts")], id, new Set(["a.ts"]));
  assert.equal(s.counters!.reads, 2);
  assert.equal(s.counters!.rereadsVisible + s.counters!.rereadsCleared, 0);
});

test("errors, stubs and steers are counted; a failed read is not a read", () => {
  const s = fake();
  countRound(s, [{ name: "run_command", args: {}, isError: true }, { name: "read_file", args: { paths: ["x"] }, isError: true }], id, undefined);
  countStubbed(s, 3);
  countSteers(s, 2);
  countStubbed(s, 0);
  assert.deepEqual(s.counters, { ...emptyCounters(), toolCalls: 2, toolErrors: 2, stubbed: 3, steers: 2 });
});

// ── a real turn, a save and a resume ─────────────────────────────────────────

const SEP = String.fromCharCode(10, 10);
let requests = 0;
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests++;
      const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
      // The background calls (notes, summary) are not streamed: they want one JSON reply.
      if (!/"stream"\s*:\s*true/.test(body)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "## Notes\nthe parser is started" }, finish_reason: "stop" }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const call = (name: string) => ({
        choices: [{ delta: { tool_calls: [{ index: 0, id: `c${requests}`, type: "function", function: { name, arguments: JSON.stringify({ paths: ["a.txt"] }) } }] } }],
      });
      // Two reads of the same file, then an answer.
      const frames = requests <= 2 ? [call("read_file"), { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage }] : [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }];
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

test("a real turn counts its reads and a repeat, and the counts survive a save and a resume", async () => {
  requests = 0;
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-counters-")));
  writeFileSync(join(root, "a.txt"), "hello\n");
  const s = await createSession(root);
  s.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  s.transcript.push({ role: "user", content: "read a.txt twice" });
  let resumed: Session | null = null;
  try {
    await respond(s, {});
    assert.equal(s.counters?.toolCalls, 2);
    assert.equal(s.counters?.reads, 2);
    assert.equal(s.counters?.rereadsVisible, 1, "the second read of a file still on screen is the wasted kind");

    recordAuxCall(s, { promptTokens: 900, completionTokens: 40, totalTokens: 940, cacheHitTokens: 0, cacheMissTokens: 900 }, "notes");
    const aux = s.callLog?.filter((r) => r.aux === "notes");
    assert.equal(aux?.length, 1);
    assert.equal(aux?.[0]?.miss, 900);
    assert.ok((s.spend?.billed ?? 0) >= 940, "the call is part of what the session cost");

    await saveSession(s);
    resumed = await resumeSession(root, s.id);
    assert.deepEqual(resumed?.counters, s.counters);
    assert.equal(resumed?.callLog?.filter((r) => r.aux === "notes").length, 1);
  } finally {
    await stopChassis(s.toolContext.chassis).catch(() => {});
    await stopChassis(resumed?.toolContext.chassis).catch(() => {});
  }
});

test("the notes update reports what it cost; it used to throw its usage away", async () => {
  requests = 10; // answer in plain text
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-counters-notes-")));
  const s = await createSession(root);
  s.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  s.transcript.push({ role: "user", content: "build the parser" }, { role: "assistant", content: "started it" });
  try {
    let reported = 0;
    const { updateSessionMemory } = await import("./sessionMemory.js");
    const ok = await updateSessionMemory(s, undefined, (u) => {
      reported = u.promptTokens;
    });
    assert.equal(ok, true);
    assert.equal(reported, 100, "the provider's own count of the call");
  } finally {
    await stopChassis(s.toolContext.chassis).catch(() => {});
  }
});
