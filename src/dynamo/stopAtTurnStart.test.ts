/**
 * stopAtTurnStart.test.ts — Esc stops a turn even while it is refreshing its notes.
 *
 * At the start of a turn the engine may spend one model call writing its session notes.
 * That call used to go out without the turn's stop signal, so on a slow provider a stop
 * waited for the whole call: the chat said "Stopping" for minutes. Here the provider
 * never answers at all, which is the only way to tell "stopped" from "finished anyway".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import type { Session } from "../memory/types.js";

let server: Server;
let requests = 0;

before(async () => {
  // Accepts every request and never replies: a provider stuck in its queue.
  server = createServer((req) => {
    requests++;
    req.resume();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function session(): Session {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-stop-")));
  // Long enough that the notes are due (past the first-notes threshold).
  const long = "word ".repeat(30_000);
  return {
    cwd: root,
    transcript: [
      { role: "user", content: long },
      { role: "assistant", content: "ok" },
      { role: "user", content: "go on" },
    ],
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [], planMode: false },
  } as unknown as Session;
}

test("a stop during the turn-start notes call ends the turn right away", async () => {
  const s = session();
  const stop = new AbortController();
  const started = Date.now();
  setTimeout(() => stop.abort(), 400);

  const settled = await Promise.race([
    respond(s, { signal: stop.signal }).then(() => "ended", () => "ended"),
    new Promise((r) => setTimeout(() => r("still running"), 5_000)),
  ]);

  assert.ok(requests >= 1, "the notes call never went out, so this proved nothing");
  assert.equal(settled, "ended", "the turn kept waiting on a call the user had stopped");
  assert.ok(Date.now() - started < 3_000);
});
