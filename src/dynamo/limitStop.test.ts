/**
 * limitStop.test.ts — a spent window stops the NEXT step, before any model call is made.
 *
 * The provider here counts every request and never answers, so "no request arrived" is the
 * only way to tell "stopped by the limit" from "went ahead and is waiting on the model".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond, type PauseReason } from "./engine.js";
import { noteUsage, resetUsageLimitsForTests, saveLimits } from "./usageLimits.js";
import type { Session } from "../memory/types.js";

let server: Server;
let requests = 0;

before(async () => {
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-limit-")));
  return {
    cwd: root,
    transcript: [{ role: "user", content: "do the thing" }],
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [], planMode: false },
  } as unknown as Session;
}

const USED = { promptTokens: 4000, completionTokens: 1000, totalTokens: 5000, cacheHitTokens: 0, cacheMissTokens: 4000 };

async function freshLimits(patch: Parameters<typeof saveLimits>[0]) {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mw-limit-state-"));
  resetUsageLimitsForTests();
  await saveLimits(patch);
}

test("a spent 5-hour window ends the turn before any model call, saying when it opens", async () => {
  await freshLimits({ enabled: true, fiveHour: 3000 });
  noteUsage("gemini-3.7-flash", USED); // 5000 billed: over the 3000 window
  const s = session();
  const paused: PauseReason[] = [];
  const before = requests;
  const reply = await respond(s, { onPause: (r) => paused.push(r) });
  assert.equal(requests, before, "no request went to the provider");
  assert.deepEqual(paused, ["limit"]);
  assert.match(reply, /5-hour limit is used up/);
  assert.match(reply, /opens again/);
  assert.match(reply, /nothing is lost/);
  assert.equal(s.transcript.at(-1)?.role, "assistant", "the turn ended with a well-formed reply");
});

test("with limits set to only warn, the same spent window does not stop the turn", async () => {
  await freshLimits({ enabled: true, fiveHour: 3000, enforce: false });
  noteUsage("gemini-3.7-flash", USED);
  const s = session();
  const paused: PauseReason[] = [];
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300); // the provider never answers; a stop ends it
  await respond(s, { signal: stop.signal, onPause: (r) => paused.push(r) });
  assert.ok(!paused.includes("limit"), "warn-only never pauses");
  assert.ok(requests > 0, "the step went ahead to the model");
});
