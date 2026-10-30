/**
 * failureNote.test.ts — what a failed turn showed is saved with the conversation and drawn again on resume.
 *
 * The provider's notice (or the error line) used to be live-only: a session reopened later ended on the last tool result with no
 * sign of why. It now rides on the entry the failed turn ended on, display only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFailure, replayHistory } from "./turnRunner.js";
import type { Session } from "../memory/types.js";

const session = (transcript: unknown[]): Session => ({ id: "s", cwd: process.cwd(), transcript, modelConfig: { model: "x" } } as unknown as Session);

test("a notice is kept on the last entry and replays right after it", () => {
  const s = session([{ role: "user", content: "go" }, { role: "assistant", content: "Working on it." }]);
  recordFailure(s, { kind: "notice", title: "DeepSeek is having trouble", body: "Try again in a minute, or switch model." });
  const events = replayHistory(s);
  assert.deepEqual(events.map((e) => e.type), ["userMessage", "assistantMessage", "failureNote"]);
  const note = events[2] as { kind: string; title?: string; body: string };
  assert.equal(note.kind, "notice");
  assert.equal(note.title, "DeepSeek is having trouble");
});

test("it survives being saved as a line of JSON and read back", () => {
  const s = session([{ role: "user", content: "go" }]);
  recordFailure(s, { kind: "error", body: "Request failed" });
  const back = session((s.transcript as unknown[]).map((e) => JSON.parse(JSON.stringify(e))));
  assert.deepEqual(replayHistory(back).map((e) => e.type), ["userMessage", "failureNote"]);
});

test("a failure in the middle of a conversation stays where it was", () => {
  const s = session([{ role: "user", content: "one" }, { role: "assistant", content: "a" }]);
  recordFailure(s, { kind: "notice", title: "Rate limited", body: "wait" });
  (s.transcript as unknown[]).push({ role: "user", content: "two" }, { role: "assistant", content: "b" });
  assert.deepEqual(replayHistory(s).map((e) => e.type), ["userMessage", "assistantMessage", "failureNote", "userMessage", "assistantMessage"]);
});

test("with no entries there is nothing to attach it to, and nothing breaks", () => {
  const s = session([]);
  recordFailure(s, { kind: "error", body: "x" });
  assert.deepEqual(replayHistory(s), []);
});
