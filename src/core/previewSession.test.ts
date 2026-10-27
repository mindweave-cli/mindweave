/**
 * previewSession.test.ts — a saved session can be drawn without opening it, and what is drawn is exactly what opening it draws.
 *
 * A window shows a saved session at once from the file and opens the session itself afterwards, so the two have to agree: a
 * preview that drew something other than the opened session would change under the person's eyes when the real one arrives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeSession, loadSession, previewSession, replayHistory, startSession } from "./turnRunner.js";
import { saveSession } from "../memory/store.js";
import type { Entry } from "../memory/types.js";

async function savedSession(): Promise<{ cwd: string; id: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "mindweave-preview-"));
  const s = await startSession(cwd);
  const transcript: Entry[] = [
    { role: "user", content: "what is in this folder?" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_dir", arguments: JSON.stringify({ path: "." }) }] },
    { role: "tool", toolCallId: "c1", content: "(empty directory)", summary: "list . (0 items)" },
    { role: "assistant", content: "Nothing yet." },
    { role: "user", content: "thanks, now say hello" },
    { role: "assistant", content: "Hello." },
  ];
  s.transcript.push(...transcript);
  await saveSession(s);
  await disposeSession(s);
  return { cwd, id: s.id };
}

test("a preview draws exactly what the opened session draws", async () => {
  const { cwd, id } = await savedSession();
  const preview = await previewSession(cwd, id);
  const opened = await loadSession(cwd, id);
  assert.ok(preview && opened);
  assert.deepEqual(preview, replayHistory(opened));
  assert.ok(preview.some((e) => e.type === "userMessage" && e.text === "what is in this folder?"));
  assert.ok(preview.some((e) => e.type === "assistantMessage" && e.text === "Hello."));
  await disposeSession(opened);
});

test("a session that does not exist, or has nothing in it, previews as null", async () => {
  const { cwd } = await savedSession();
  assert.equal(await previewSession(cwd, "no-such-session"), null);
});

test("a preview does not open anything: it leaves no live session behind", async () => {
  const { cwd, id } = await savedSession();
  const before = process.listenerCount("exit");
  await previewSession(cwd, id);
  assert.equal(process.listenerCount("exit"), before);
});
