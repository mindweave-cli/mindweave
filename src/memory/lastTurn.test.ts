/**
 * lastTurn.test.ts — how the last turn went is kept with the session.
 *
 * The line at the end of a turn ("Worked for 1m 28s · done 3:06 PM") lived only on the screen, so opening the session again lost it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, resumeSession } from "./session.js";
import { saveSession } from "./store.js";

test("a session reopened has the duration, the finish time and the tokens of its last turn", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-lastturn-")));
  const s = await createSession(root);
  s.transcript.push({ role: "user", content: "hello" }, { role: "assistant", content: "hi" });
  s.lastTurn = { ms: 88_000, at: 1_793_286_000_000, outputTokens: 5_100 };
  await saveSession(s);
  const back = await resumeSession(root, s.id);
  assert.deepEqual(back?.lastTurn, { ms: 88_000, at: 1_793_286_000_000, outputTokens: 5_100 });
});

test("a session that never finished a turn has none", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-lastturn-")));
  const s = await createSession(root);
  s.transcript.push({ role: "user", content: "hello" }, { role: "assistant", content: "hi" });
  await saveSession(s);
  assert.equal((await resumeSession(root, s.id))?.lastTurn, undefined);
});
