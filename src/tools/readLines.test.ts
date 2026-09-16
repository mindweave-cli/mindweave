/**
 * readLines.test.ts — how read_file counts lines, and what it says about an empty file.
 *
 * Both defects here were silent. Splitting a file on newlines leaves an empty piece after
 * the final one, and counting that piece gave nearly every source file a phantom blank
 * last line: one line too many in every total, and an offset one past the real end that
 * slipped under the guard meant to refuse it. And an empty file came back as a blank
 * line 1, which is exactly what a file holding one blank line looks like, so the model
 * had no way to tell "nothing here" from "one empty line".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile, fileLines } from "./readFile.js";

function freshCtx(): ToolContext {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-readlines-")));
  return { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
}

async function read(ctx: ToolContext, name: string, body: string, extra: object = {}) {
  await fs.writeFile(join(ctx.cwd, name), body);
  return readFile.execute({ paths: [name], ...extra }, ctx);
}

test("a file ending in a newline has no phantom blank last line", async () => {
  const r = await read(freshCtx(), "two.ts", "first\nsecond\n");
  assert.equal(r.isError, undefined);
  assert.match(r.output, /1\tfirst\n2\tsecond/);
  assert.doesNotMatch(r.output, /^3\t/m, "the final newline was counted as a third line");
});

test("an offset one past the real end is refused, not answered with a blank line", async () => {
  // The guard existed; the phantom line put the end one further away than it is, so this
  // exact read returned "3\t" and the model paged into nothing believing it was content.
  const r = await read(freshCtx(), "two.ts", "first\nsecond\n", { offset: 3 });
  assert.equal(r.isError, true);
  assert.match(r.output, /past the end of the file \(2 lines\)/);
});

test("an empty file says it is empty, and is not an error", async () => {
  const ctx = freshCtx();
  const r = await read(ctx, "empty.ts", "");
  assert.equal(r.isError, undefined, "reading an empty file succeeded; it is not a failure");
  assert.match(r.output, /this file is empty/);
  assert.doesNotMatch(r.output, /^1\t/m, "an empty file must not render as a blank line 1");
});

test("an empty file is recorded as fully read, so writing to it afterwards is not blocked", async () => {
  // read-before-write keys off this flag. An empty file read with an offset still showed
  // the whole of it, and leaving it partial would make the model re-read to write.
  const ctx = freshCtx();
  await read(ctx, "empty.ts", "", { offset: 4 });
  const entry = [...ctx.reads.values()][0];
  assert.equal(entry?.full, true);
});

test("a lone newline is one blank line, which is not the same as empty", async () => {
  const r = await read(freshCtx(), "blank.ts", "\n");
  assert.doesNotMatch(r.output, /this file is empty/);
  assert.match(r.output, /^1\t$/m);
});

test("a large file's advertised line total matches what paging can reach", async () => {
  // Past the whole-read budget the tool answers with a size instead of content, and the
  // model pages by that number. Counted with the phantom line, the last page pointed one
  // line beyond the file.
  const body = Array.from({ length: 1000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n") + "\n";
  const r = await read(freshCtx(), "big.ts", body);
  assert.match(r.output, /big\.ts is 1000 lines/, r.output.slice(0, 200));
});

test("fileLines counts lines the way a person would", () => {
  const b = (s: string) => Buffer.from(s, "utf8");
  assert.deepEqual(fileLines(b("")), []);
  assert.deepEqual(fileLines(b("a")), ["a"]);
  assert.deepEqual(fileLines(b("a\n")), ["a"]);
  assert.deepEqual(fileLines(b("a\nb")), ["a", "b"]);
  assert.deepEqual(fileLines(b("a\r\nb\r\n")), ["a", "b"], "CRLF must count the same as LF");
  assert.deepEqual(fileLines(b("\n")), [""]);
  assert.deepEqual(fileLines(b("a\n\n")), ["a", ""], "a real trailing blank line is kept");
});
