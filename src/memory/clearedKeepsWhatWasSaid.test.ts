/**
 * clearedKeepsWhatWasSaid.test.ts — clearing old context is for the model, not for the screen.
 *
 * Clearing swaps an old tool result, or a long status reply, for a short note addressed to the
 * MODEL ("old tool result cleared to save context — re-read the file"). The chat on screen is a
 * different thing from the model's context, and a chat reopened later has to show what was
 * said and done, not those notes. Shown as if they were part of a row they read as the row's
 * own output, which is what a command row did: "(no output)" followed by a line telling the
 * agent to read the file again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLEARED_STUB, RECAP_STUB, microcompact, shownText, withoutClearedNote } from "./compaction.js";
import type { Entry, Session } from "./types.js";
import { replayHistory } from "../core/turnRunner.js";
import { rebuildFull } from "../tools/rebuildDetail.js";

const recap = "Session 6 delivered the folder tree, context menu, and SVG icons. ".repeat(6);
const user = (text: string): Entry => ({ role: "user", content: text });

test("condensing an old status reply keeps the words for the screen", () => {
  const entries: Entry[] = [
    { role: "assistant", content: recap },
    { role: "user", content: "[Background shell #1 finished]", synthetic: true },
    ...Array.from({ length: 8 }, (_, i) => user(`turn ${i}`)),
  ];
  const { entries: out, recapsCleared } = microcompact(entries, 8);
  assert.equal(recapsCleared, 1);
  const kept = out[0]!;
  assert.equal(kept.role, "assistant");
  assert.equal(kept.content, RECAP_STUB, "the model gets the note");
  assert.equal((kept as { shown?: string }).shown, recap, "the screen keeps what was said");
  // Clearing again must not overwrite it with the note.
  const again = microcompact(out, 8).entries[0]! as { shown?: string };
  assert.equal(again.shown, recap);
});

test("what the screen shows for a reply is what was said, and never the note", () => {
  assert.equal(shownText({ content: RECAP_STUB, shown: recap }), recap);
  assert.equal(shownText({ content: "plain" }), "plain");
  assert.equal(shownText({ content: RECAP_STUB }), undefined, "a chat cleared before this was kept shows nothing, not the note");
});

test("a tool result's words lose the clearing note and keep whatever stood before it", () => {
  assert.equal(withoutClearedNote(CLEARED_STUB), "");
  assert.equal(withoutClearedNote(`Exit code 0\n${CLEARED_STUB}`), "Exit code 0");
  assert.equal(withoutClearedNote(`x\n${CLEARED_STUB}\n[saved at C:/a/b.txt · 12 lines]`), "x");
  assert.equal(withoutClearedNote("ordinary output"), "ordinary output");
});

function session(transcript: Entry[]): Session {
  return { cwd: "C:/p", modelConfig: { model: "deepseek-v4-pro" }, transcript } as unknown as Session;
}

test("a reopened chat shows what was said even after it was condensed, and the note never", () => {
  const said = replayHistory(
    session([
      user("hi"),
      { role: "assistant", content: RECAP_STUB, shown: "Here is what I built: the tree." } as Entry,
      { role: "assistant", content: RECAP_STUB },
    ]),
  ).filter((e) => e.type === "assistantMessage");
  assert.deepEqual(said.map((e) => (e.type === "assistantMessage" ? e.text : "")), ["Here is what I built: the tree."]);
});

test("a reopened row never carries the note as its own words", () => {
  const rows = replayHistory(
    session([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "dir" }) }] },
      { role: "tool", toolCallId: "c1", content: `ok\n${CLEARED_STUB}` },
    ]),
  ).filter((e) => e.type === "toolReplay");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.type === "toolReplay" && row.summary, "ok", "the first line that was kept, not the note");
  assert.ok(!(row.type === "toolReplay" && row.summary.includes("cleared")));
});

test("a command row is not rebuilt out of output that was already cleared", () => {
  const detail = "$ dir\n(no output)\n✓ 0 · 1.1s";
  assert.equal(rebuildFull("run_command", { command: "dir" }, { detail, content: CLEARED_STUB }), undefined);
  assert.equal(rebuildFull("run_command", { command: "dir" }, { detail, content: `first\n${CLEARED_STUB}` }), undefined);
});

test("clearing old context never takes away what a row shows or can open", () => {
  const detail = "whole file · 9 lines\n+ a\n… (8 more lines)";
  const detailFull = "whole file · 9 lines\n+ a\n+ b\n+ c";
  const entries: Entry[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: "x\n".repeat(500) }) }] },
    { role: "tool", toolCallId: "w1", content: "Rewrote all of a.ts (9 lines). ".repeat(20), summary: "rewrote a.ts", detail, detailFull, detailKind: "diff" } as Entry,
    ...Array.from({ length: 14 }, (_, i): Entry[] => [
      { role: "assistant", content: "", toolCalls: [{ id: `r${i}`, name: "run_command", arguments: "{}" }] },
      { role: "tool", toolCallId: `r${i}`, content: "output ".repeat(80) },
    ]).flat(),
  ];
  const out = microcompact(entries, 8).entries;
  const row = out.find((e) => e.role === "tool") as { content: string; summary?: string; detail?: string; detailFull?: string };
  assert.equal(row.content, CLEARED_STUB, "the model's copy was cleared, so this test is about the right entry");
  assert.equal(row.detail, detail);
  assert.equal(row.detailFull, detailFull);
  assert.equal(row.summary, "rewrote a.ts");
});
