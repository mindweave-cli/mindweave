/**
 * sessionTitle.test.ts — a session is named by what it is about, not by its first message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionTitle } from "./sessionTitle.js";
import { saveSession, listSessions, sessionDir } from "./store.js";
import { SESSION_MEMORY_TEMPLATE } from "./sessionMemory.js";
import type { Session } from "./types.js";

const notesWith = (title: string) =>
  SESSION_MEMORY_TEMPLATE.replace(/(# Session Title\n_[^\n]*_\n)/, `$1${title}\n`);

test("the title is the line under the heading, not the template's instruction", () => {
  assert.equal(sessionTitle(notesWith("Fixing SQL injections in the login API")), "Fixing SQL injections in the login API");
});

test("a title the model wrote in italics, in place of the instruction, is still the title", () => {
  const notes = "# Session Title\n_Menteus monorepo: building events package_\n\n# Current State\n_What is actively being worked on right now?_\n";
  assert.equal(sessionTitle(notes), "Building events package");
});

test("a long title is cut down to a name: no brackets, no project prefix, cut at a word", () => {
  assert.equal(
    sessionTitle(notesWith("Menteus monorepo: building events package (EventBus + EventStream) atop designed skeleton")),
    "Building events package atop designed skeleton",
  );
  const cut = sessionTitle(notesWith("Full end-to-end application test and bug-fix pass across every screen"))!;
  assert.ok(cut.length <= 48, cut);
  assert.equal(cut, "Full end-to-end application test and bug-fix…");
  // A colon that is not a prefix (nothing much after it) stays.
  assert.equal(sessionTitle(notesWith("Fix: login")), "Fix: login");
});

test("notes whose title was never filled in give none", () => {
  assert.equal(sessionTitle(SESSION_MEMORY_TEMPLATE), undefined);
  assert.equal(sessionTitle(""), undefined);
  assert.equal(sessionTitle(undefined), undefined);
});

function sessionIn(dir: string, notes?: string): Session {
  return {
    id: "12345678-1234-1234-1234-123456789abc",
    cwd: dir,
    createdAt: Date.now(),
    transcript: [{ role: "user", content: "hi hi" }, { role: "assistant", content: "hello" }],
    toolContext: { cwd: dir } as Session["toolContext"],
    projectMemory: "",
    memoryDir: path.join(dir, "memory"),
    memoryIndex: "",
    priorSessions: 0,
    projectContext: "",
    governance: { rules: [], skills: [], forbidden: [] } as unknown as Session["governance"],
    modelConfig: { model: "test-model" } as Session["modelConfig"],
    ...(notes ? { sessionMemory: notes } : {}),
  } as Session;
}

test("a saved session lists under its notes' title; one without notes keeps its first message", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-title-"));
  try {
    await saveSession(sessionIn(dir, notesWith("Gamo settings screen")));
    const [meta] = await listSessions(dir);
    assert.equal(meta!.title, "Gamo settings screen");
    assert.equal(meta!.firstPrompt, "hi hi");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "mw-title-"));
  try {
    await saveSession(sessionIn(bare));
    assert.equal((await listSessions(bare))[0]!.title, undefined);
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
  }
});

test("a session saved before titles were recorded gets its title from the notes on disk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-title-"));
  try {
    const s = sessionIn(dir);
    await saveSession(s);
    await fs.writeFile(path.join(sessionDir(dir), `${s.id}.notes.md`), notesWith("Row actions and cover art"));
    assert.equal((await listSessions(dir))[0]!.title, "Row actions and cover art");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
