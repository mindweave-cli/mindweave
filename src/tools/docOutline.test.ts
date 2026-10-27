/**
 * docOutline.test.ts — outline reads the shape of documents and data files, not only code.
 *
 * Pinned with real-looking files (a package.json, a tsconfig with comments, a workflow, a Cargo.toml, a README with
 * fenced code) rather than minimal ones, because the failures that matter are the ones a real file triggers: a `#` inside
 * a code fence read as a heading, a comment that shifts every later line number, an array of records that repeats
 * its keys once per element.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docOutline, isDocFile } from "./docOutline.js";
import { outlineTool } from "./codeIntel.js";
import type { ToolContext } from "./types.js";

const text = (lines: string[] | null) => (lines ?? []).join("\n");

test("markdown: headings with their level and line, and nothing inside a code fence", () => {
  const md = ["# Title", "", "intro", "", "## Install", "", "```bash", "# not a heading", "npm i", "```", "", "### Deep", "", "## Use"].join("\n");
  const out = docOutline("README.md", md)!;
  assert.deepEqual(out.map((l) => l.trim().replace(/\s+/g, " ")), ["1 # Title", "5 ## Install", "12 ### Deep", "14 ## Use"]);
  assert.ok(out[2]!.indexOf("###") > out[1]!.indexOf("##"), "a deeper heading is indented further");
  assert.doesNotMatch(text(out), /not a heading/);
});

test("json: top-level keys with what each value is, and the second level of objects", () => {
  const pkg = JSON.stringify({ name: "demo", version: "1.2.3", scripts: { build: "tsc", test: "node --test" }, files: ["dist", "bin"], deps: {} }, null, 2);
  const out = text(docOutline("package.json", pkg));
  assert.match(out, /name: "demo"/);
  assert.match(out, /version: "1\.2\.3"/);
  assert.match(out, /scripts: \{2 keys\}/);
  assert.match(out, /build: "tsc"/, "the second level of an object is listed");
  assert.match(out, /files: \[2 items\]/);
  assert.match(out, /deps: \{0 keys\}/);
  // line numbers are the real ones: "scripts" is the 4th line of the pretty-printed file
  assert.match(out, /^\s+4\s+scripts/m);
});

test("json: comments do not move the line numbers, and an array of records does not repeat its keys", () => {
  const cfg = ['{', '  // the compiler', '  /* block', '     comment */', '  "compilerOptions": { "strict": true },', '  "include": [ { "path": "a" }, { "path": "b" } ]', '}'].join("\n");
  const out = text(docOutline("tsconfig.json", cfg));
  assert.match(out, /^\s+5\s+compilerOptions: \{1 key\}/m);
  assert.match(out, /^\s+6\s+include: \[2 items\]/m);
  assert.equal((out.match(/path/g) ?? []).length, 0, "keys inside array elements are not listed");
});

test("json: a lock file is not outlined", () => {
  assert.equal(isDocFile("package-lock.json"), false);
  assert.equal(docOutline("package-lock.json", "{}"), null);
});

test("yaml: top-level keys and their children, with the lines of a block scalar skipped", () => {
  const y = ["name: CI", "on:", "  push:", "    branches: [main]", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: |", "          echo not: a key", "          echo done"].join("\n");
  const out = text(docOutline(".github/workflows/ci.yml", y));
  assert.match(out, /^\s+1\s+name: CI/m);
  assert.match(out, /^\s+3\s+ {2}push:/m);
  assert.match(out, /^\s+5\s+jobs:/m);
  assert.match(out, /^\s+6\s+ {2}test:/m);
  assert.doesNotMatch(out, /not: a key/);
});

test("toml and ini: tables, and the keys before the first table", () => {
  const t = ['name = "x"', 'edition = "2021"', '', '[dependencies]', 'serde = "1"', '', '[[bin]]', 'name = "y"'].join("\n");
  const out = text(docOutline("Cargo.toml", t));
  assert.match(out, /name: "x"/);
  assert.match(out, /^\s+4\s+\[dependencies\]/m);
  assert.match(out, /^\s+7\s+\[\[bin\]\]/m);
  assert.doesNotMatch(out, /serde/, "keys inside a table are left to the read");
});

test("csv: the columns and the row count", () => {
  const out = text(docOutline("data.csv", "id,name,score\n1,a,3\n2,b,4\n"));
  assert.match(out, /columns: id,name,score/);
  assert.match(out, /2 rows/);
});

test("a long file is cut and says how much", () => {
  const md = Array.from({ length: 200 }, (_, i) => `# H${i}`).join("\n");
  const out = docOutline("big.md", md, 10)!;
  assert.equal(out.length, 11);
  assert.match(out[10]!, /190 more entries/);
});

test("an unknown type and an empty file give nothing", () => {
  assert.equal(docOutline("main.rs", "fn main() {}"), null);
  assert.equal(docOutline("empty.md", ""), null);
  assert.equal(isDocFile("notes.txt"), false);
});

// ── through the tool ────────────────────────────────────────────────────────────────────────────

function ctxIn(dir: string): ToolContext {
  const chassis = {
    async outline() { return []; },
    async directorySummary() { return null; },
    status() { return { ready: true, files: 0, symbols: 0, resolvedLanguages: [] }; },
  };
  return { cwd: dir, roots: [dir], chassis, reads: new Map(), todos: [] } as unknown as ToolContext;
}

test("outline of a markdown file lists its headings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-docs-"));
  await fs.writeFile(join(dir, "NOTES.md"), "# One\n\n## Two\n");
  const r = await outlineTool.execute({ path: "NOTES.md" }, ctxIn(dir));
  assert.match(r.output, /NOTES\.md/);
  assert.match(r.output, /1\s+# One/);
  assert.match(r.output, /3\s+## Two/);
});

test("outline of a folder adds its documents and data files after the code, and keeps secrets out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-docs-"));
  await fs.writeFile(join(dir, "README.md"), "# Demo\n\n## Usage\n");
  await fs.writeFile(join(dir, "package.json"), '{ "name": "demo", "scripts": { "build": "tsc" } }\n');
  await fs.mkdir(join(dir, ".ssh"));
  await fs.writeFile(join(dir, ".ssh", "config.yaml"), "secret: 1\n");
  const r = await outlineTool.execute({ path: "." }, ctxIn(dir));
  assert.match(r.output, /README\.md/);
  assert.match(r.output, /# Demo/);
  assert.match(r.output, /package\.json/);
  assert.match(r.output, /scripts: \{1 key\}/);
  assert.doesNotMatch(r.output, /secret/, "a protected folder's files are left out");
});

test("a folder with more documents than the cap says how many were left out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-docs-"));
  for (let i = 0; i < 15; i++) await fs.writeFile(join(dir, `doc${String(i).padStart(2, "0")}.md`), `# D${i}\n`);
  const r = await outlineTool.execute({ path: "." }, ctxIn(dir));
  assert.match(r.output, /3 more document and data files not outlined/);
});

test("yaml: the second level is the first indent under a key, so a job's own settings are not listed as jobs", () => {
  const y = ["jobs:", "  windows:", "    runs-on: windows-latest", "    steps:", "      - uses: x", "  linux:", "    runs-on: ubuntu-latest"].join("\n");
  const out = text(docOutline("ci.yml", y));
  assert.match(out, /windows:/);
  assert.match(out, /linux:/);
  assert.doesNotMatch(out, /runs-on/);
});
