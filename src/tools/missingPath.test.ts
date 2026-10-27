/**
 * missingPath.test.ts — a read of a file that is not there says where it may really be.
 *
 * The wrong guess is nearly always a near one: the folder above or below, another letter case, a letter off, a folder that
 * was never made. The test files are laid out the way a real project is, and each wrong guess is one a model makes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "./readFile.js";
import { editDistance, nearNames } from "./missingPath.js";
import type { ToolContext } from "./types.js";

async function project(): Promise<{ dir: string; ctx: ToolContext }> {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-missing-"));
  await fs.mkdir(join(dir, "src", "core"), { recursive: true });
  await fs.mkdir(join(dir, "docs"), { recursive: true });
  await fs.writeFile(join(dir, "src", "core", "session.ts"), "export const s = 1;\n");
  await fs.writeFile(join(dir, "src", "util.ts"), "export const u = 1;\n");
  await fs.writeFile(join(dir, "docs", "Guide.md"), "# g\n");
  return { dir, ctx: { cwd: dir, roots: [dir], reads: new Map(), todos: [] } as unknown as ToolContext };
}

const read = async (ctx: ToolContext, path: string) => (await readFile.execute({ path }, ctx)).output;

test("a name one letter off beside it is offered", async () => {
  const { ctx } = await project();
  const out = await read(ctx, "src/utill.ts");
  assert.match(out, /^Error: File not found: src\/utill\.ts/);
  assert.match(out, /Similar names in src\/: util\.ts/);
});

// Windows and macOS read `guide.md` as `Guide.md`, so there the file is simply found and there is nothing to hint at.
test("the same name in another letter case is offered", { skip: process.platform !== "linux" }, async () => {
  const { ctx } = await project();
  assert.match(await read(ctx, "docs/guide.md"), /Similar names in docs\/: Guide\.md/);
});

test("the same file name in another folder is offered", async () => {
  const { ctx } = await project();
  const out = await read(ctx, "src/session.ts");
  assert.match(out, /A file with that name exists at: src[\\/]core[\\/]session\.ts/);
});

test("a folder that does not exist names the nearest one that does", async () => {
  const { ctx } = await project();
  const out = await read(ctx, "src/missing/deep/file.ts");
  assert.match(out, /does not exist; the nearest folder that does is src\//);
});

test("nothing similar anywhere is just the plain message", async () => {
  const { ctx } = await project();
  const out = await read(ctx, "zzzzzzzz.qq");
  assert.match(out, /File not found: zzzzzzzz\.qq/);
  assert.doesNotMatch(out, /Similar names|exists at|nearest folder/);
});

test("a protected folder's files are never named as the same file elsewhere", async () => {
  const { dir, ctx } = await project();
  await fs.mkdir(join(dir, ".ssh"));
  await fs.writeFile(join(dir, ".ssh", "known_hosts"), "x\n");
  const out = await read(ctx, "known_hosts");
  assert.doesNotMatch(out, /\.ssh/);
});

test("the helpers: edit distance and near names", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.deepEqual(nearNames("Util.TS", ["util.ts", "other.ts", "utils.ts"]), ["util.ts", "utils.ts"]);
  assert.deepEqual(nearNames("abc", ["zzzzzz"]), []);
});
