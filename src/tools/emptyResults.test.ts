/**
 * emptyResults.test.ts — an empty search says what it covered, a file-name match refuses a protected folder the way a
 * content search does, and an edit nothing could check says so.
 *
 * Three things that were silent: "No matches found." for both "not there" and "somewhere the search does not go",
 * a file-name search of a protected folder that answered "No files found." where the content search refused, and a
 * post-edit check that said nothing both when it found nothing and when no language server covered the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepDef } from "./grep.js";
import { globDef } from "./glob.js";
import { noFiles, noMatches } from "./emptyResult.js";
import { rippleCheck, uncheckedNote } from "./editRipple.js";
import type { ToolContext } from "./types.js";

function project(): { dir: string; ctx: ToolContext } {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-empty-"));
  return { dir, ctx: { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext };
}

test("a search with no matches names the pattern, the place and what is left out, and keeps its opening words", async () => {
  const { dir, ctx } = project();
  await fs.writeFile(join(dir, "a.ts"), "const x = 1;\n");
  const r = await grepDef.execute({ pattern: "needle_not_here" }, ctx);
  assert.match(r.output, /^No matches found/);
  assert.match(r.output, /"needle_not_here"/);
  assert.match(r.output, /in the project/);
  assert.match(r.output, /gitignore/i);
  assert.match(r.output, /node_modules/);
  assert.match(r.output, /list_dir/);
  assert.match(r.output, /read_file/);

  await fs.mkdir(join(dir, "sub"));
  const scoped = await grepDef.execute({ pattern: "needle_not_here", path: "sub" }, ctx);
  assert.match(scoped.output, /in sub\./, "the folder asked about is named");
});

test("a search that finds something is unchanged", async () => {
  const { dir, ctx } = project();
  await fs.writeFile(join(dir, "a.ts"), "const needle = 1;\n");
  const r = await grepDef.execute({ pattern: "needle" }, ctx);
  assert.match(r.output, /a\.ts/);
  assert.doesNotMatch(r.output, /No matches/);
});

test("a file-name match with nothing found names the pattern, the place and what is left out", async () => {
  const { dir, ctx } = project();
  await fs.writeFile(join(dir, "a.ts"), "x\n");
  const r = await globDef.execute({ pattern: "**/*.nothing" }, ctx);
  assert.match(r.output, /^No files found/);
  assert.match(r.output, /"\*\*\/\*\.nothing"/);
  assert.match(r.output, /gitignore/i);
  assert.match(r.output, /list_dir/);
});

test("a file-name match of a protected folder refuses, as a content search does", async () => {
  const { dir, ctx } = project();
  await fs.mkdir(join(dir, ".ssh"));
  await fs.writeFile(join(dir, ".ssh", "known_hosts"), "x\n");
  const byName = await globDef.execute({ pattern: "**/*", path: ".ssh" }, ctx);
  assert.match(byName.output, /Refusing to search \.ssh: it is an SSH key directory/);
  const byContent = await grepDef.execute({ pattern: "x", path: ".ssh" }, ctx);
  assert.match(byContent.output, /Refusing to search \.ssh/, "the two tools agree");
});

test("the message helpers say where they looked when no path was given", () => {
  assert.match(noMatches("x", undefined), /in the project/);
  assert.match(noFiles("*.x", "src"), /in src\./);
});

// ── the check after an edit ─────────────────────────────────────────────────────────────────────

const label = (abs: string) => abs.split(/[\\/]/).pop()!;
const noChassis = () => ({ cwd: "/repo", roots: ["/repo"], reads: new Map() }) as unknown as ToolContext;

test("an edited source file that no language server covers is said so, once per file type", () => {
  const ctx = noChassis();
  const first = uncheckedNote(ctx, ["/repo/a.py"], label);
  assert.match(first, /no language server covers a\.py/);
  assert.match(first, /nothing was checked/);
  assert.match(first, /build, type check or tests/);
  assert.equal(uncheckedNote(ctx, ["/repo/b.py"], label), "", "said once per type, not after every edit");
  assert.match(uncheckedNote(ctx, ["/repo/c.go"], label), /c\.go/, "a different type is new");
});

test("prose, data and markup are not reported as unchecked", () => {
  const ctx = noChassis();
  for (const f of ["/repo/README.md", "/repo/data.json", "/repo/style.css", "/repo/page.html", "/repo/notes.txt"]) {
    assert.equal(uncheckedNote(ctx, [f], label), "", f);
  }
});

test("a file a language server covers gets no unchecked note", () => {
  const chassis = {
    async diagnostics() { return []; },
    async dependents() { return []; },
  };
  const ctx = { cwd: "/repo", roots: ["/repo"], chassis, reads: new Map() } as unknown as ToolContext;
  assert.equal(uncheckedNote(ctx, ["/repo/a.ts"], label), "");
});

test("the whole pass reports the unchecked edit, and stays silent for a covered one with nothing found", async () => {
  const none = noChassis();
  const note = await rippleCheck(none, [{ name: "edit", args: { path: "/repo/a.py" } }], (p) => p);
  assert.match(note, /no language server covers/);

  const chassis = {
    async diagnostics() { return []; },
    async dependents() { return []; },
  };
  const covered = { cwd: "/repo", roots: ["/repo"], chassis, reads: new Map() } as unknown as ToolContext;
  assert.equal(await rippleCheck(covered, [{ name: "edit", args: { path: "/repo/a.ts" } }], (p) => p), "");
});
