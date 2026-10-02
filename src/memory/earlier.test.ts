/**
 * earlier.test.ts — what compaction takes out is kept for the screen.
 *
 * The failure: a compaction replaced the oldest part of the transcript with a summary,
 * and the transcript was the only record the chat was redrawn from. Reopening a
 * compacted session showed nothing above the summary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceTranscript } from "./earlier.js";
import { spliceSummary } from "./compaction.js";
import { saveSession } from "./store.js";
import { resumeSession } from "./session.js";
import { replayHistory } from "../core/turnRunner.js";
import type { Entry, Session } from "./types.js";

const said = (content: string, ts: number): Entry => ({ role: "user", content, ts }) as Entry;
const reply = (content: string): Entry => ({ role: "assistant", content });

function sessionIn(dir: string, transcript: Entry[]): Session {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: dir,
    createdAt: Date.now(),
    transcript,
    toolContext: { cwd: dir } as Session["toolContext"],
    projectMemory: "",
    memoryDir: path.join(dir, "memory"),
    memoryIndex: "",
    priorSessions: 0,
    projectContext: "",
    governance: { rules: [], skills: [], forbidden: [] } as unknown as Session["governance"],
    modelConfig: { model: "test-model" } as Session["modelConfig"],
  } as Session;
}

test("a summary compaction keeps the prefix it replaced, in order, and not the tail it kept", () => {
  const s = sessionIn("C:/p", [said("one", 1), reply("a"), said("two", 2), reply("b"), said("three", 3), reply("c")]);
  const before = [...s.transcript];
  replaceTranscript(s, spliceSummary(s.transcript, "the summary", 2));
  assert.deepEqual(s.earlier, before.slice(0, 4));
  assert.equal(s.transcript[0]!.role, "summary");
  assert.deepEqual(s.transcript.slice(1), before.slice(4));
  assert.deepEqual(s.earlierUnsaved, before.slice(0, 4));
});

test("a second compaction adds to what the first kept, summary included, where it was", () => {
  const s = sessionIn("C:/p", [said("one", 1), reply("a"), said("two", 2), reply("b")]);
  replaceTranscript(s, spliceSummary(s.transcript, "first", 1));
  const firstSummary = s.transcript[0]!;
  s.transcript.push(said("three", 3), reply("c"));
  replaceTranscript(s, spliceSummary(s.transcript, "second", 1));
  assert.deepEqual(s.earlier!.map((e) => e.content), ["one", "a", "two", firstSummary.content, "b", "three"]);
});

test("saved and reopened, the chat is drawn whole, and only the live part can be rewound to", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-earlier-"));
  try {
    const s = sessionIn(dir, [said("fix the login", 1), reply("Fixed it."), said("now the logout", 2), reply("Done.")]);
    replaceTranscript(s, spliceSummary(s.transcript, "the summary", 2));
    await saveSession(s);
    assert.equal(s.earlierUnsaved, undefined, "what was written is not written again");
    await saveSession(s); // a second save must not append the same entries twice

    const back = await resumeSession(dir, s.id);
    assert.ok(back, "the session did not resume");
    assert.deepEqual(back.earlier?.map((e) => e.content), ["fix the login", "Fixed it."]);

    const shown = replayHistory(back).filter((e) => e.type === "userMessage" || e.type === "assistantMessage");
    assert.deepEqual(shown.map((e) => (e as { text: string }).text), ["fix the login", "Fixed it.", "now the logout", "Done."]);
    const [old, live] = shown.filter((e) => e.type === "userMessage") as { noRewind?: true }[];
    assert.equal(old!.noRewind, true, "a message compaction took out is not in the conversation to go back to");
    assert.equal(live!.noRewind, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a tool result kept after the cut still finds its call among what was taken out", () => {
  const call = { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }] } as Entry;
  const result = { role: "tool", toolCallId: "r1", content: "…", summary: "a.ts" } as Entry;
  const s = sessionIn("C:/p", [said("look", 1), call, result]);
  replaceTranscript(s, [s.transcript[2]!]);
  const row = replayHistory(s).find((e) => e.type === "toolReplay") as { name: string; arg?: string };
  assert.equal(row.name, "Read");
  assert.equal(row.arg, "a.ts");
});
