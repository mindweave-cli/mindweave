/**
 * slashCommands.test.ts — what the desktop app's /undo and /context ask of the core.
 *
 * /undo lists the turns that changed files, newest first, and rolls back the newest N; /context
 * breaks down what is in the window. Real checkpoints on real files, a hand-built session around them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Checkpoints } from "../tools/checkpoints.js";
import { contextBreakdown, undoList, undoTurns } from "./turnRunner.js";
import type { Entry, Session } from "../memory/types.js";

function session(transcript: Entry[] = []): Session {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-slash-")));
  return {
    id: randomUUID(),
    cwd: root,
    createdAt: Date.now(),
    transcript,
    projectMemory: "",
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [], planMode: false, checkpoints: new Checkpoints() },
  } as unknown as Session;
}

/** One turn's edit as the tools make it: checkpoint first, then the write, then seal. */
function turn(s: Session, name: string, next: string, label: string, at: number): string {
  const path = join(s.cwd, name);
  let before: string | null = null;
  try { before = readFileSync(path, "utf8"); } catch { /* new file */ }
  s.toolContext.checkpoints!.backup(path, before, next);
  writeFileSync(path, next);
  s.toolContext.checkpoints!.seal(label, at);
  return path;
}

test("undoList names the turns that changed files, newest first", () => {
  const s = session();
  writeFileSync(join(s.cwd, "a.txt"), "v0");
  turn(s, "a.txt", "v1", "first change", 100);
  turn(s, "a.txt", "v2", "second change", 200);
  const { turns, resumed } = undoList(s);
  assert.deepEqual(turns.map((t) => t.label), ["second change", "first change"]);
  assert.equal(turns[0]!.files, 1);
  assert.equal(resumed, false);
});

test("nothing to undo is an empty list, not an error", async () => {
  assert.deepEqual(undoList(session()).turns, []);
  assert.equal((await undoTurns(session(), 1)).turns, 0);
});

test("undoTurns rolls back the newest N turns and says which files came back", async () => {
  const s = session();
  const path = join(s.cwd, "a.txt");
  writeFileSync(path, "v0");
  turn(s, "a.txt", "v1", "first change", 100);
  turn(s, "a.txt", "v2", "second change", 200);
  s.toolContext.reads.set(path, { mtimeMs: 1, size: 2, full: true, touchedAt: 1 } as never);

  const one = await undoTurns(s, 1);
  assert.equal(readFileSync(path, "utf8"), "v1");
  assert.equal(one.turns, 1);
  assert.equal(one.label, "second change");
  assert.deepEqual(one.restored, ["a.txt"]);
  assert.equal(s.toolContext.reads.has(path), false, "the model must read a restored file again before editing it");

  const rest = await undoTurns(s, 5);
  assert.equal(readFileSync(path, "utf8"), "v0");
  assert.equal(rest.turns, 1, "only one turn was left to roll back");
});

test("a file changed by someone else since is left alone and reported", async () => {
  const s = session();
  const path = join(s.cwd, "a.txt");
  writeFileSync(path, "v0");
  turn(s, "a.txt", "v1", "change", 100);
  writeFileSync(path, "edited by hand");
  const r = await undoTurns(s, 1);
  assert.equal(readFileSync(path, "utf8"), "edited by hand");
  assert.deepEqual(r.conflicts, ["a.txt"]);
  assert.deepEqual(r.restored, []);
});

test("contextBreakdown adds up what is in the window and names the heavy tools", () => {
  const s = session([
    { role: "user", content: "read the file", ts: 1 },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", content: "x".repeat(4000) },
    { role: "assistant", content: "done" },
  ] as Entry[]);
  const c = contextBreakdown(s);
  assert.ok(c.total > 0);
  assert.equal(c.slices.reduce((n, x) => n + x.tokens, 0), c.total);
  assert.ok(c.window > 0 && c.compactAt > 0 && c.compactAt <= c.window);
  assert.equal(c.tools[0]?.name, "read_file");
});

test("a note for the model is read by the model and by nobody else", async () => {
  const { stripUserNotes, wrapUserNote } = await import("../memory/userNotes.js");
  const { stripAttachments } = await import("../cli/attachments.js");
  const sent = wrapUserNote("[The person renamed a.js to b.js]") + "what files do I have?";
  assert.match(sent, /renamed a\.js to b\.js/, "the model gets the note");
  assert.equal(stripUserNotes(sent), "what files do I have?");
  assert.equal(stripAttachments(sent), "what files do I have?", "the chat shows what was typed");
});
