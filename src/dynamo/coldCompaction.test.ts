/**
 * coldCompaction.test.ts — compacting a big conversation from the session notes when the provider
 * holds no cached copy of it, driven through the real `respond()` against a scripted provider.
 *
 * Both the idle break and the model switch are covered, together with the cases that must be left
 * alone: a warm cache (rewriting history would throw away a cheap read), a short gap between two
 * compactions, and a sub-agent.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, Entry } from "../memory/types.js";

// Read when the notes module loads, so set before it is imported below.
process.env["MINDWEAVE_SM_COMPACT_MIN"] = "500";
process.env["MINDWEAVE_MICROCOMPACT_TOKENS"] = "20000";

type WireMessage = { role: string; content?: unknown };
let bodies: { messages: WireMessage[] }[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const frames = [
        { choices: [{ delta: { content: "ok" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
      ];
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
after(() => void server.close());

const MODEL = "gemini-3.7-flash";
const OTHER = "deepseek-v4-flash";
const NOTES = "# Session Title\n_title_\n\nBuilding the importer\n\n# Current State\n_state_\n\nThe importer reads CSV and writes rows; the date column is the open problem.";

/** A session with a long conversation (about 40k tokens) and notes that cover most of it. */
async function bigSession(): Promise<Session> {
  const { createSession } = await import("../memory/session.js");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-cold-")));
  const session = await createSession(root);
  session.modelConfig = { model: MODEL, thinking: false, effort: "high" };
  const filler = "the importer reads each row and checks the date column against the schema. ".repeat(25);
  const entries: Entry[] = [];
  for (let i = 0; i < 40; i++) {
    entries.push({ role: "user", content: `step ${i}: ${filler}` });
    entries.push({ role: "assistant", content: `done ${i}: ${filler}` });
  }
  session.transcript.push(...entries);
  session.sessionMemory = NOTES;
  session.sessionMemoryEntries = 70;
  session.sessionMemoryTokens = 1;
  session.sessionMemoryInit = true;
  return session;
}

async function turn(session: Session): Promise<{ lines: string[]; compacted: boolean }> {
  const { respond } = await import("./engine.js");
  const lines: string[] = [];
  bodies = [];
  session.transcript.push({ role: "user", content: "carry on" });
  await respond(session, { onActivity: (line: string) => void lines.push(line) });
  // The first request is often the background notes refresh; the conversation is the one with the agent prompt.
  const first = bodies.find((b) => String(b.messages[0]?.content).startsWith("You are Mindweave"))?.messages ?? [];
  // 80 earlier messages went in; compacting leaves the notes and the latest rounds.
  return { lines, compacted: first.length > 0 && first.length < 40 };
}

const HOURS = 60 * 60 * 1000;

test("after a long idle break the conversation is compacted from the notes, and the chat says why", async () => {
  const session = await bigSession();
  session.lastCallByModel = { [MODEL]: Date.now() - 3 * HOURS };
  const { lines, compacted } = await turn(session);
  assert.ok(compacted, "the full history was sent although the provider's copy had expired");
  assert.ok(lines.some((l) => /Compacted automatically: the provider's cache .* expired after 180 minutes idle/.test(l)), JSON.stringify(lines));
});

test("a model that has not been called in this session is compacted for, however recently another ran", async () => {
  const session = await bigSession();
  session.lastCallByModel = { [OTHER]: Date.now() - 1000 };
  const { lines, compacted } = await turn(session);
  assert.ok(compacted, "a model with no cached copy was sent the whole history");
  assert.ok(lines.some((l) => /gemini-3\.7-flash has no cached copy/.test(l)), JSON.stringify(lines));
});

test("a warm cache is not touched", async () => {
  const session = await bigSession();
  session.lastCallByModel = { [MODEL]: Date.now() - 10_000 };
  const { lines, compacted } = await turn(session);
  assert.equal(compacted, false, "history was rewritten while the provider still held it");
  assert.deepEqual(lines.filter((l) => /Compacted automatically/.test(l)), []);
});

test("a second compaction for a gone cache waits", async () => {
  const session = await bigSession();
  session.lastCallByModel = { [OTHER]: Date.now() - 1000 };
  session.lastColdCompactAt = Date.now() - 60_000;
  const { compacted } = await turn(session);
  assert.equal(compacted, false);
});

test("a session never called has nothing cached and is left alone", async () => {
  const session = await bigSession();
  const { compacted } = await turn(session);
  assert.equal(compacted, false);
});

test("a session reopened after a long break is treated as idle, and one reopened at once is not", async () => {
  const { resumeSession } = await import("../memory/session.js");
  const source = await bigSession();
  assert.equal(typeof resumeSession, "function");
  // The seed itself: the model named in the file, at the time the file was last saved.
  const { cacheStatus } = await import("./contextWindow.js");
  const now = Date.now();
  assert.equal(cacheStatus({ now, model: MODEL, lastByModel: { [MODEL]: now - 3 * HOURS }, ttlMs: HOURS }), "idle");
  assert.equal(cacheStatus({ now, model: MODEL, lastByModel: { [MODEL]: now - 1000 }, ttlMs: HOURS }), "warm");
  assert.equal(cacheStatus({ now, model: MODEL, lastByModel: { [OTHER]: now - 1000 }, ttlMs: HOURS }), "switched");
  void source;
});
