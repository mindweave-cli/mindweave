/**
 * projectNotes.test.ts — the notes a session starts with, and the ones it picks up.
 *
 * The failure that matters most here is silent: notes that should have loaded and did
 * not. The agent then works without knowing a convention it was told about, and nothing
 * on screen says so. So every layer is asserted on real files, not on a mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  assembleNotes,
  directoryNotesFor,
  importPathsIn,
  MAX_IMPORT_DEPTH,
  MAX_NOTES_CHARS,
  NOTES_FILE,
} from "./projectNotes.js";

function project(): string {
  return mkdtempSync(join(tmpdir(), "mw-notes-"));
}
function put(root: string, rel: string, body: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

// ── imports, the parsing half ────────────────────────────────────────────────

test("an @path in prose is an import", () => {
  const found = importPathsIn("See @./docs/api.md for the details.", join("/p", NOTES_FILE));
  assert.equal(found.length, 1);
  assert.match(found[0]!, /docs[\\/]api\.md$/);
});

test("an @ inside code is NOT an import", () => {
  // A notes file is exactly the document that quotes package scopes and decorators.
  // Treating those as paths would break the one file whose job is to be trusted.
  const body = [
    "Install with `npm i @scope/thing`.",
    "",
    "```ts",
    "@Component({ selector: 'x' })",
    "import x from '@app/core';",
    "```",
    "",
    "Real one: @./real.md",
  ].join("\n");
  const found = importPathsIn(body, join("/p", NOTES_FILE));
  assert.equal(found.length, 1, `expected only the prose import, got: ${found.join(", ")}`);
  assert.match(found[0]!, /real\.md$/);
});

test("an unterminated code fence does not let the rest back in", () => {
  const body = ["```", "@./inside.md", "@./also-inside.md"].join("\n");
  assert.deepEqual(importPathsIn(body, join("/p", NOTES_FILE)), []);
});

test("an email address is not an import", () => {
  assert.deepEqual(importPathsIn("Ask me@example.com about it.", join("/p", NOTES_FILE)), []);
});

test("a #fragment is dropped and an escaped space is kept", () => {
  const found = importPathsIn("See @./my\\ notes.md#setup now.", join("/p", NOTES_FILE));
  assert.equal(found.length, 1);
  assert.match(found[0]!, /my notes\.md$/);
  assert.ok(!found[0]!.includes("#"), "the fragment was kept in the path");
});

test("the same import written twice is resolved once", () => {
  const found = importPathsIn("@./a.md and again @./a.md", join("/p", NOTES_FILE));
  assert.equal(found.length, 1);
});

// ── imports, the assembly half ───────────────────────────────────────────────

test("an imported file's content arrives with the notes", async () => {
  const root = project();
  put(root, NOTES_FILE, "Root notes.\n\nArchitecture: @./docs/arch.md");
  put(root, "docs/arch.md", "The backend is Rust.");

  const notes = await assembleNotes(root, { includeUser: false });
  assert.match(notes.text, /Root notes\./);
  assert.match(notes.text, /The backend is Rust\./, "the imported file never arrived");
  assert.equal(notes.sources.length, 2);
  assert.equal(notes.sources[1]!.kind, "import");
  assert.match(notes.sources[1]!.importedBy ?? "", /MINDWEAVE\.md$/);
});

test("an import says where it came from", async () => {
  // Without this, a rule from another file reads as though it were written in
  // MINDWEAVE.md, and there is nowhere to go to change it.
  const root = project();
  put(root, NOTES_FILE, "@./docs/arch.md");
  put(root, "docs/arch.md", "Never use the ORM directly.");
  const notes = await assembleNotes(root, { includeUser: false });
  assert.match(notes.text, /imported from docs\/arch\.md/);
});

test("imports nest, and stop at the depth cap", async () => {
  const root = project();
  put(root, NOTES_FILE, "level0 @./l1.md");
  for (let i = 1; i <= MAX_IMPORT_DEPTH + 2; i++) {
    put(root, `l${i}.md`, `level${i} @./l${i + 1}.md`);
  }
  const notes = await assembleNotes(root, { includeUser: false });
  assert.match(notes.text, /level1/, "the first import did not load");
  assert.match(notes.text, /level4/, "nesting stopped too early");
  assert.ok(!notes.text.includes(`level${MAX_IMPORT_DEPTH + 1}`), "the depth cap did not hold");
});

test("an import cycle terminates instead of hanging", async () => {
  const root = project();
  put(root, NOTES_FILE, "root @./a.md");
  put(root, "a.md", "A @./b.md");
  put(root, "b.md", "B @./a.md");
  const notes = await assembleNotes(root, { includeUser: false });
  assert.match(notes.text, /A/);
  assert.match(notes.text, /B/);
  assert.equal(notes.sources.length, 3, "a file was read more than once");
});

test("an import that does not exist is reported, not silently dropped", async () => {
  // Silence would leave the agent told to "see the architecture notes" with no
  // architecture notes and no way to know a file was meant to be there.
  const root = project();
  put(root, NOTES_FILE, "Notes. @./missing.md");
  const notes = await assembleNotes(root, { includeUser: false });
  assert.match(notes.text, /Notes\./, "the rest of the notes must still load");
  assert.equal(notes.sources.length, 1);
  assert.deepEqual(notes.missing.length, 1);
  assert.match(notes.text, /missing\.md.*could not be read/, "the model is not told the notes are incomplete");
});

test("notes with every import present report nothing missing", async () => {
  const root = project();
  put(root, NOTES_FILE, "Notes. @./there.md");
  put(root, "there.md", "here");
  const notes = await assembleNotes(root, { includeUser: false });
  assert.deepEqual(notes.missing, []);
  assert.ok(!notes.text.includes("could not be read"), "a false alarm on a healthy import");
});

// ── the personal layer ───────────────────────────────────────────────────────

test("the user's own notes load for every project, labelled as theirs", async () => {
  const root = project();
  const state = project();
  writeFileSync(join(state, NOTES_FILE), "Always run the linter before you say you are done.", "utf8");
  put(root, NOTES_FILE, "This project uses pnpm.");

  const notes = await assembleNotes(root, { stateDir: state });
  assert.match(notes.text, /Always run the linter/);
  assert.match(notes.text, /This project uses pnpm\./);
  assert.match(notes.text, /applies to every project/, "the personal layer is not labelled as personal");
});

test("the project's notes come after the user's, so the project wins", async () => {
  const root = project();
  const state = project();
  writeFileSync(join(state, NOTES_FILE), "PERSONAL", "utf8");
  put(root, NOTES_FILE, "PROJECT");
  const notes = await assembleNotes(root, { stateDir: state });
  assert.ok(
    notes.text.indexOf("PERSONAL") < notes.text.indexOf("PROJECT"),
    "the project's notes must read last, or a personal preference overrides the repository",
  );
});

test("no notes anywhere is empty, not an error", async () => {
  const notes = await assembleNotes(project(), { stateDir: project() });
  assert.equal(notes.text, "");
  assert.deepEqual(notes.sources, []);
});

test("the assembled notes are capped, and SAY they were cut", async () => {
  const root = project();
  put(root, NOTES_FILE, "start\n@./big.md");
  put(root, "big.md", "x".repeat(MAX_NOTES_CHARS * 2));
  const notes = await assembleNotes(root, { includeUser: false });
  assert.equal(notes.truncated, true);
  assert.ok(notes.text.length < MAX_NOTES_CHARS + 400, `not capped: ${notes.text.length} chars`);
  assert.match(notes.text, /truncated at this point/, "a silent cut leaves the model acting on half a document");
  assert.match(notes.text, /Read the file directly/, "and how to get the rest");
});

// ── per-directory notes ──────────────────────────────────────────────────────

test("a folder's notes arrive when a file in it is being worked on", async () => {
  const root = project();
  put(root, "src/api/MINDWEAVE.md", "Every endpoint returns a Result.");
  const notes = await directoryNotesFor(root, [join(root, "src/api/users.ts")]);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.text, /Every endpoint returns a Result\./);
});

test("a folder's notes do NOT arrive when nothing in it is open", async () => {
  const root = project();
  put(root, "src/api/MINDWEAVE.md", "Every endpoint returns a Result.");
  const notes = await directoryNotesFor(root, [join(root, "src/ui/button.tsx")]);
  assert.deepEqual(notes, [], "notes for an untouched folder were loaded anyway");
});

test("the root's own notes are not repeated as a directory note", async () => {
  // They are already loaded at session start; including them here sends them twice.
  const root = project();
  put(root, NOTES_FILE, "Root notes.");
  const notes = await directoryNotesFor(root, [join(root, "src/thing.ts")]);
  assert.deepEqual(notes, []);
});

test("notes from every folder on the way down are collected, outermost first", async () => {
  const root = project();
  put(root, "src/MINDWEAVE.md", "OUTER");
  put(root, "src/api/MINDWEAVE.md", "INNER");
  const notes = await directoryNotesFor(root, [join(root, "src/api/users.ts")]);
  assert.deepEqual(notes.map((n) => n.text), ["OUTER", "INNER"], "the more specific note must read last");
});

test("a file outside the project contributes nothing", async () => {
  const root = project();
  const elsewhere = project();
  put(elsewhere, "secret/MINDWEAVE.md", "should not be read");
  const notes = await directoryNotesFor(root, [join(elsewhere, "secret/thing.ts")]);
  assert.deepEqual(notes, []);
});

test("two files in the same folder read its notes once", async () => {
  const root = project();
  put(root, "src/MINDWEAVE.md", "ONCE");
  const notes = await directoryNotesFor(root, [
    join(root, "src/a.ts"),
    join(root, "src/b.ts"),
  ]);
  assert.equal(notes.length, 1);
});

/**
 * The seam into a turn: folder notes must reach the VOLATILE tail, never the cached
 * prefix.
 *
 * Putting them in the prefix would look identical on screen and rewrite the whole
 * cached prompt every time the agent opened a file in a new folder, which is the
 * single most expensive thing a turn can do. The only way to tell is to look at where
 * they land.
 */
test("folder notes render into the volatile context, with their folder named", async () => {
  const { volatileContext } = await import("../dynamo/engine.js");
  const out = volatileContext("", false, "", "", [
    { path: "/p/src/api/MINDWEAVE.md", text: "Every endpoint returns a Result." },
  ]);
  assert.match(out, /Every endpoint returns a Result\./, "the folder's notes never reached the model");
  assert.match(out, /src[\/]api/, "the notes do not say which folder they belong to");
});

test("no folder notes adds nothing at all", async () => {
  const { volatileContext } = await import("../dynamo/engine.js");
  const empty = volatileContext("", false, "", "", []);
  const withRules = volatileContext("Use pnpm.", false, "", "", []);
  assert.ok(!empty.includes("folders you are working in"), "an empty list still printed a heading");
  assert.match(withRules, /Use pnpm\./, "the existing blocks stopped rendering");
});

test("folder notes are as binding as the project's own", async () => {
  const { volatileContext } = await import("../dynamo/engine.js");
  const out = volatileContext("", false, "", "", [{ path: "/p/src/MINDWEAVE.md", text: "x" }]);
  assert.match(out, /binding/i, "nothing tells the model these carry weight");
});

// ── what an import may reach ─────────────────────────────────────────────────
// Imports are read at session start into the system prompt, so they decide what the
// first request sends to the provider. A cloned repository must not be able to choose.

test("project notes cannot import a secrets file, even inside the project", async () => {
  const root = project();
  put(root, ".env", "API_KEY=hunter2-FAKE-env");
  put(root, NOTES_FILE, "See @.env for the configuration.");
  const notes = await assembleNotes(root, { includeUser: false });
  assert.ok(!notes.text.includes("hunter2-FAKE-env"), "a secret reached the notes");
  assert.equal(notes.refused.length, 1);
  assert.match(notes.text, /was not loaded/);
});

test("project notes cannot import a file outside the project", async () => {
  const root = project();
  const elsewhere = project();
  const outside = put(elsewhere, "deploy.txt", "hunter2-FAKE-outside");
  put(root, NOTES_FILE, `Deploy access: @${outside.split("\\").join("/")}`);
  const notes = await assembleNotes(root, { includeUser: false });
  assert.ok(!notes.text.includes("hunter2-FAKE-outside"), "a file outside the project reached the notes");
  assert.deepEqual(notes.refused, [outside]);
});

test("project notes still import their own docs, and the user's notes may import from anywhere", async () => {
  const root = project();
  put(root, "docs/arch.md", "The architecture is layered.");
  put(root, NOTES_FILE, "See @./docs/arch.md for the layers");
  const state = project();
  const elsewhere = project();
  const shared = put(elsewhere, "style.md", "Prefer small functions.");
  put(state, NOTES_FILE, `My style: @${shared.split("\\").join("/")}`);
  const notes = await assembleNotes(root, { stateDir: state });
  assert.match(notes.text, /layered/);
  assert.match(notes.text, /Prefer small functions/);
  assert.deepEqual(notes.refused, []);
});

// ── the instruction files other tools leave in a repository ───────────────────────────────
// A repo that ships AGENTS.md or CLAUDE.md is telling every agent how it wants to be worked on.
// Mindweave started without it, which is the first thing someone moving from another tool notices.

test("a repository's AGENTS.md or CLAUDE.md is read as notes, labelled as written for another tool", async () => {
  const onlyClaude = project();
  put(onlyClaude, "CLAUDE.md", "Run `npm run check` before committing.");
  const a = await assembleNotes(onlyClaude, { includeUser: false });
  assert.match(a.text, /Run `npm run check` before committing\./);
  assert.match(a.text, /CLAUDE\.md \(written for another coding tool; read it as notes/);
  assert.deepEqual(a.sources.map((s) => s.kind), ["other"]);

  // The first found wins: AGENTS.md, then CLAUDE.md, then GEMINI.md, so a repo that mirrors one into
  // another is not read twice.
  const both = project();
  put(both, "AGENTS.md", "Use the agents rules.");
  put(both, "CLAUDE.md", "Use the claude rules.");
  const b = await assembleNotes(both, { includeUser: false });
  assert.match(b.text, /agents rules/);
  assert.ok(!b.text.includes("claude rules"));
});

test("Mindweave's own notes come first, and the other tool's file is cut first when over budget", async () => {
  const root = project();
  put(root, NOTES_FILE, "Mindweave notes: prefer small functions.");
  put(root, "AGENTS.md", "x".repeat(MAX_NOTES_CHARS * 2));
  const notes = await assembleNotes(root, { includeUser: false });
  assert.ok(notes.text.indexOf("prefer small functions") < notes.text.indexOf("written for another coding tool"));
  assert.equal(notes.truncated, true);
  assert.ok(notes.text.includes("prefer small functions"), "the project's own notes survived the cut");
});

test("the same import rule applies: an instruction file cannot pull in a secrets file", async () => {
  const root = project();
  put(root, ".env", "API_KEY=hunter2-FAKE-agents");
  put(root, "CLAUDE.md", "Configuration is in @.env");
  const notes = await assembleNotes(root, { includeUser: false });
  assert.ok(!notes.text.includes("hunter2-FAKE-agents"));
  assert.equal(notes.refused.length, 1);
});

test("a folder being worked in uses its own notes, else the instruction file another tool left there", async () => {
  const root = project();
  put(root, "src/api/AGENTS.md", "API folder rules.");
  put(root, "src/ui/MINDWEAVE.md", "UI folder notes.");
  put(root, "src/ui/AGENTS.md", "UI agents file.");
  const notes = await directoryNotesFor(root, ["src/api/a.ts", "src/ui/b.ts"]);
  const byFolder = Object.fromEntries(notes.map((n) => [n.path.replace(root, "").split(sep).join("/"), n.text]));
  assert.equal(byFolder["/src/api/AGENTS.md"], "API folder rules.");
  assert.equal(byFolder["/src/ui/MINDWEAVE.md"], "UI folder notes.");
  assert.equal(byFolder["/src/ui/AGENTS.md"], undefined, "Mindweave's own file wins in a folder that has both");
});
