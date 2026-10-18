/**
 * readRangeDedup.test.ts — a range the model already holds is not sent again.
 *
 * Only a whole-file read used to be answered "unchanged". A read with offset/limit of lines
 * already in the conversation sent the same text a second time, a few seconds apart, and
 * the model could go on doing it. The presence of a range is derived from the transcript, like
 * the whole-file one, so a cleared result or a changed file is read again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import type { Entry } from "../memory/types.js";
import { readFile } from "./readFile.js";
import { visibleReadRanges } from "../memory/presence.js";
import { CLEARED_STUB } from "../memory/compaction.js";

function setup(): { ctx: ToolContext; path: string } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-range-")));
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;
  return { ctx, path: "a.txt" };
}

/** The conversation as the engine would hold it after one ranged read. */
function transcriptAfter(path: string, args: object, result: { output: string; summary?: string }, cleared = false): Entry[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path, ...args }) }] },
    { role: "tool", toolCallId: "c1", content: cleared ? `${CLEARED_STUB} read_file` : result.output, summary: result.summary },
  ] as unknown as Entry[];
}

async function twice(mutate?: (path: string, ctx: ToolContext) => Promise<void>, cleared = false) {
  const { ctx, path } = setup();
  await fs.writeFile(join(ctx.cwd, path), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"));
  const first = await readFile.execute({ paths: [path], offset: 10, limit: 10 }, ctx);
  const entries = transcriptAfter(path, { offset: 10, limit: 10 }, first, cleared);
  const resolve = (p: string) => join(ctx.cwd, p);
  ctx.transcriptRanges = visibleReadRanges(entries, resolve);
  if (mutate) await mutate(path, ctx);
  const again = await readFile.execute({ paths: [path], offset: 10, limit: 10 }, ctx);
  return { first, again, ctx, path };
}

test("the same range, unchanged and still in the conversation, is answered in a line", async () => {
  const { first, again } = await twice();
  assert.match(first.output, /line 10/);
  assert.doesNotMatch(again.output, /line 10\b/);
  assert.match(again.output, /already have lines 10-19/);
  assert.match(again.summary ?? "", /lines 10-19 \(unchanged\)/);
});

test("a range inside one already held is covered too", async () => {
  const { ctx, path } = await twice();
  const inner = await readFile.execute({ paths: [path], offset: 12, limit: 3 }, ctx);
  assert.match(inner.output, /already have lines 12-14/);
});

test("a range that reaches past what was held is read", async () => {
  const { ctx, path } = await twice();
  const wider = await readFile.execute({ paths: [path], offset: 10, limit: 20 }, ctx);
  assert.match(wider.output, /line 29/);
});

test("a result that was cleared to save context is read again", async () => {
  const { again } = await twice(undefined, true);
  assert.match(again.output, /line 10\b/);
});

test("a file that changed since is read again", async () => {
  const { again } = await twice(async (path, ctx) => {
    await fs.writeFile(join(ctx.cwd, path), Array.from({ length: 60 }, (_, i) => `changed ${i + 1}`).join("\n"));
  });
  assert.match(again.output, /changed 10\b/);
});
