/**
 * presence.test.ts — "can the model still see this file?" is DERIVED, never stored.
 *
 * The headline test is the last one: it is the §1.5 defect, and it can only be written
 * honestly now that the ledger surgery that used to mask it is gone. Revert the
 * `ctx.transcriptFull` guard in readFile.ts and it goes red — the model is handed
 * "unchanged, use your earlier read" for content that microcompaction deleted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullReadPaths } from "./presence.js";
import { microcompact } from "./compaction.js";
import { readFile } from "../tools/readFile.js";
import type { ToolContext } from "../tools/types.js";
type Entry = import("./types.js").Entry;

const id = (p: string) => p; // paths in these fixtures are already "absolute"

// Long enough to be worth clearing: a result smaller than its own stub is left alone.
function transcript(args: string, result = "the file contents" + "\n// more of the file, enough to be worth clearing".repeat(8)): Entry[] {
  return [
    { role: "user", content: "read it" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: args }] },
    { role: "tool", toolCallId: "1", content: result },
    { role: "assistant", content: "", toolCalls: [{ id: "2", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "2", content: "something else" },
    { role: "assistant", content: "done" },
  ];
}

test("a whole-file read still in the transcript counts as present", () => {
  const present = fullReadPaths(transcript('{"path":"/proj/a.ts"}'), id);
  assert.ok(present.has("/proj/a.ts"));
});

test("a read whose body microcompaction cleared is NOT present", () => {
  const { entries, cleared } = microcompact(transcript('{"path":"/proj/a.ts"}'), 1);
  assert.equal(cleared, 1); // guard: the fixture really did get swept
  assert.ok(!fullReadPaths(entries, id).has("/proj/a.ts"));
});

test("a RANGED read is not presence — only a window was ever sent", () => {
  const ranged = fullReadPaths(transcript('{"path":"/proj/a.ts","offset":10,"limit":20}'), id);
  assert.ok(!ranged.has("/proj/a.ts"));
});

test("malformed arguments and unresolvable paths are simply not claimed", () => {
  assert.equal(fullReadPaths(transcript("{not json"), id).size, 0);
  assert.equal(fullReadPaths(transcript('{"path":"/proj/a.ts"}'), () => undefined).size, 0);
});

test("read_symbol is not a whole-file read", () => {
  const t = transcript('{"path":"/proj/a.ts"}');
  (t[1] as { toolCalls: { name: string }[] }).toolCalls[0].name = "read_symbol";
  assert.equal(fullReadPaths(t, id).size, 0);
});

test("a recorded fullContentOf is preferred over re-resolving the arguments", () => {
  const t = transcript('{"path":"a.ts"}');
  (t[2] as { fullContentOf?: string }).fullContentOf = "/was/read/here/a.ts";
  // The resolver stands in for a cwd that has since moved: it would answer /now/a.ts.
  const present = fullReadPaths(t, () => "/now/a.ts");
  assert.ok(present.has("/was/read/here/a.ts"));
  assert.ok(!present.has("/now/a.ts"), "a cd since the read invented a claim about a different file");
});

test("a stubbed result is absent even when it recorded fullContentOf", () => {
  const t = transcript('{"path":"a.ts"}');
  (t[2] as { fullContentOf?: string }).fullContentOf = "/proj/a.ts";
  const { entries } = microcompact(t, 1);
  assert.ok(!fullReadPaths(entries, id).has("/proj/a.ts"));
});

// ── the defect this whole change exists for ────────────────────────────────────
test("read_file re-sends a file whose earlier read was compacted away", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-presence-"));
  const path = join(dir, "a.ts");
  await fs.writeFile(path, "hello\nworld\n");
  const stat = await fs.stat(path);

  // The ledger's FACT: this file was read whole, at this exact mtime/size. True, and it
  // stays true — nothing below invalidates it.
  const ledger = { mtimeMs: stat.mtimeMs, size: stat.size, full: true, touchedAt: 1 };

  // Presence says the earlier read is still in the transcript → dedup is correct.
  const seen: ToolContext = { cwd: dir, reads: new Map([[path, { ...ledger }]]), todos: [], transcriptFull: new Set([path]) };
  const deduped = await readFile.execute({ path },seen);
  assert.ok(!deduped.output.includes("hello"), "content re-sent even though it is still in context");

  // Same ledger fact, but microcompaction has since cleared that result. Presence is
  // empty, so the content MUST come back — this is where a stored "you have it" bit lies.
  const swept: ToolContext = { cwd: dir, reads: new Map([[path, { ...ledger }]]), todos: [], transcriptFull: new Set() };
  const reread = await readFile.execute({ path },swept);
  assert.ok(reread.output.includes("hello"), "model was told 'unchanged' for content it can no longer see");

  // And the ledger kept its fact: staleness state and recency survive compaction, so the
  // file stays a working-set candidate and the edit freshness gate still works.
  assert.equal(swept.reads.get(path)?.mtimeMs, stat.mtimeMs);
  assert.ok((swept.reads.get(path)?.touchedAt ?? 0) > 0);
});
