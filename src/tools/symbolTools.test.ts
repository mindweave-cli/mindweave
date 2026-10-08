/**
 * symbolTools.test.ts — read_symbol + replace_symbol_body end-to-end over a real
 * CodeChassis (tree-sitter tier, lsp:false → deterministic). Exercises the span
 * resolution (treeSitterSpan/enclosingSpan → index.span → mux) and both tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const FAKE_HOME = mkdtempSync(join(tmpdir(), "mindweave-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

import type { ToolContext } from "./types.js";
import { CodeChassis } from "../alternator/chassis/index.js";
import { readSymbolTool } from "./readSymbol.js";
import { replaceSymbolBody } from "./replaceSymbol.js";

const FILE = `export function greet(name: string) {
  const msg = "hi " + name;
  return msg;
}

export class Box {
  value = 0;
  bump() {
    this.value++;
  }
}
`;

async function project(files: Record<string, string>): Promise<{ ctx: ToolContext; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-sym-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(dir, name), content);
  }
  const ch = new CodeChassis(dir, { lsp: false });
  await ch.build();
  const ctx: ToolContext = { cwd: dir, reads: new Map(), todos: [], chassis: ch };
  return { ctx, dir };
}

test("read_symbol returns just a function's definition, line-numbered", async () => {
  const { ctx } = await project({ "m.ts": FILE });
  const r = await readSymbolTool.execute({ name: "greet" }, ctx);
  assert.equal(r.isError, undefined);
  assert.match(r.output, /function greet/);
  assert.match(r.output, /m\.ts:1-4/);
  assert.match(r.output, /return msg/);
  // Tree-sitter tier is name-level, so the caveat is shown.
  assert.match(r.output, /name-level match/);
  // It must NOT include the class that comes later in the file.
  assert.doesNotMatch(r.output, /class Box/);
});

test("read_symbol finds a method's body", async () => {
  const { ctx } = await project({ "m.ts": FILE });
  const r = await readSymbolTool.execute({ name: "bump" }, ctx);
  assert.match(r.output, /bump — m\.ts:8-10/);
  assert.match(r.output, /this\.value\+\+/);
});

test("read_symbol records the file as read (clears the edit gate)", async () => {
  const { ctx, dir } = await project({ "m.ts": FILE });
  await readSymbolTool.execute({ name: "greet" }, ctx);
  assert.ok(ctx.reads.has(join(dir, "m.ts")), "read_symbol should record the read");
});

test("read_symbol reports a not-found symbol without erroring", async () => {
  const { ctx } = await project({ "m.ts": FILE });
  const r = await readSymbolTool.execute({ name: "nope" }, ctx);
  assert.equal(r.isError, undefined);
  assert.match(r.output, /Couldn't locate/);
});

test("read_symbol lists candidates when a name spans several files", async () => {
  const { ctx } = await project({
    "a.ts": "export function shared() { return 1; }\n",
    "b.ts": "export function shared() { return 2; }\n",
  });
  const r = await readSymbolTool.execute({ name: "shared" }, ctx);
  assert.match(r.output, /defined in several files/);
  assert.match(r.output, /a\.ts/);
  assert.match(r.output, /b\.ts/);
  // With a path it resolves to one.
  const one = await readSymbolTool.execute({ name: "shared", path: "b.ts" }, ctx);
  assert.match(one.output, /b\.ts:1-1/);
});

test("replace_symbol_body swaps a whole definition, leaving the rest intact", async () => {
  const { ctx, dir } = await project({ "m.ts": FILE });
  await readSymbolTool.execute({ name: "greet" }, ctx); // read-before-edit
  const r = await replaceSymbolBody.execute(
    {
      name: "greet",
      new_definition: "export function greet(name: string) {\n  return `hello ${name}`;\n}",
    },
    ctx,
  );
  assert.equal(r.isError, undefined);
  const after = await fs.readFile(join(dir, "m.ts"), "utf8");
  assert.match(after, /hello \$\{name\}/);
  assert.doesNotMatch(after, /const msg/); // old body gone
  assert.match(after, /class Box/); // untouched code preserved
  assert.match(after, /bump\(\)/);
});

test("replace_symbol_body refuses an unread file (read-before-edit gate)", async () => {
  const { ctx } = await project({ "m.ts": FILE });
  const r = await replaceSymbolBody.execute(
    { name: "greet", new_definition: "export function greet() {}" },
    ctx,
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /has not been read/);
});

test("replace_symbol_body refuses an ambiguous target and writes nothing", async () => {
  const { ctx, dir } = await project({
    "a.ts": "export function shared() { return 1; }\n",
    "b.ts": "export function shared() { return 2; }\n",
  });
  const r = await replaceSymbolBody.execute(
    { name: "shared", new_definition: "export function shared() { return 9; }" },
    ctx,
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /ambiguous/);
  // Neither file changed.
  assert.match(await fs.readFile(join(dir, "a.ts"), "utf8"), /return 1/);
  assert.match(await fs.readFile(join(dir, "b.ts"), "utf8"), /return 2/);
});

test("replace_symbol_body preserves CRLF line endings", async () => {
  const { ctx, dir } = await project({ "m.ts": FILE });
  // Rewrite the file with CRLF, re-index, read, then replace.
  const crlf = FILE.replace(/\n/g, "\r\n");
  await fs.writeFile(join(dir, "m.ts"), crlf);
  (ctx.chassis as CodeChassis).refresh && (await (ctx.chassis as CodeChassis).refresh());
  await readSymbolTool.execute({ name: "greet" }, ctx);
  await replaceSymbolBody.execute(
    { name: "greet", new_definition: "export function greet() {\n  return 0;\n}" },
    ctx,
  );
  const after = await fs.readFile(join(dir, "m.ts"), "utf8");
  assert.ok(after.includes("\r\n"), "CRLF should be preserved");
  assert.doesNotMatch(after, /[^\r]\n/); // no lone LF introduced
});

// ── read_symbol always returns the body ───────────────────────────────────────
// It never tells the model a body is "already in context": nothing renders one outside the conversation.

test("reading the same symbol again returns its body again", async () => {
  const { ctx } = await project({ "c.ts": "export function gamma() {\n  return 3;\n}\n" });
  await readSymbolTool.execute({ name: "gamma" }, ctx);
  const again = await readSymbolTool.execute({ name: "gamma" }, ctx);
  assert.match(again.output, /return 3/);
});
