/**
 * clearedArchive.test.ts — a cleared tool result is kept on disk, and its stub says where.
 *
 * Clearing used to destroy the only copy: a long test run or a fetched page could not be
 * had back without running the call again, and the stub could only say "re-read it".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLEARED_STUB, microcompact } from "./compaction.js";
import { archiveCleared } from "./clearedArchive.js";
import { TOOLS } from "../tools/registry.js";
import type { Entry } from "./types.js";
import type { ToolContext } from "../tools/types.js";

/** A transcript of `n` tool rounds, the first a long test run, so the early ones get cleared. */
function transcript(n: number): Entry[] {
  const out: Entry[] = [{ role: "user", content: "run the tests and fix what fails" }];
  for (let i = 0; i < n; i++) {
    const name = i === 0 ? "run_command" : "read_file";
    const args = i === 0 ? '{"command":"npm test"}' : JSON.stringify({ path: `src/f${i}.ts` });
    out.push({ role: "assistant", content: "", toolCalls: [{ id: `call_${i}`, name, arguments: args }] });
    out.push({ role: "tool", toolCallId: `call_${i}`, content: i === 0 ? `npm test\n${"FAIL src/parse.test.ts line 40\n".repeat(200)}` : `export const f${i} = ${i};\n${"// a line of ordinary source code\n".repeat(12)}` });
  }
  out.push({ role: "assistant", content: "", toolCalls: [{ id: "last", name: "read_file", arguments: '{"path":"x.ts"}' }] });
  out.push({ role: "tool", toolCallId: "last", content: "fresh" });
  return out;
}

test("a cleared result is saved, its stub says where and how big, and read_file can open it", async () => {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-cleared-")));
  const before = transcript(12);
  const { entries, cleared } = microcompact(before);
  assert.ok(cleared > 0, "the setup should clear something");
  const kept = archiveCleared(before, entries, cwd, "session-1", () => false);

  const stub = kept.find((e) => e.role === "tool" && e.toolCallId === "call_0")!;
  assert.ok(stub.content.includes(CLEARED_STUB), "still marked as cleared");
  const path = /\[saved at (.+?) · (\d+) lines/.exec(stub.content);
  assert.ok(path, `no location in the stub: ${stub.content}`);
  assert.equal(readFileSync(path[1]!, "utf8"), (before.find((e) => e.role === "tool" && e.toolCallId === "call_0") as { content: string }).content);
  assert.equal(path[2], "201");

  const read = kept.find((e) => e.role === "tool" && e.toolCallId === "call_1")!;
  assert.match(read.content, /unchanged since/, "a file read says whether the file changed");

  const tool = TOOLS.find((t) => t.name === "read_file")!;
  const ctx = { cwd, roots: [cwd], reads: new Map(), todos: [] } as unknown as ToolContext;
  const r = await tool.execute({ paths: [path[1]], offset: 1, limit: 3 }, ctx);
  assert.match(r.output, /FAIL src\/parse\.test\.ts line 40/, `read_file could not open the saved result: ${r.output.slice(0, 200)}`);
});

test("clearing twice saves nothing new and adds no second location", () => {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-cleared-")));
  const before = transcript(12);
  const once = archiveCleared(before, microcompact(before).entries, cwd, "s", () => null);
  const twice = archiveCleared(once, microcompact(once).entries, cwd, "s", () => null);
  for (const e of twice) if (e.role === "tool") assert.ok((e.content.match(/\[saved at /g) ?? []).length <= 1);
  assert.ok(existsSync(join(cwd)));
});
