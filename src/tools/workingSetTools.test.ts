/**
 * workingSetTools.test.ts — the tool-side pieces of the working set: recordWrite now
 * marks a file `full:false` (the model has a window, not the file) + records recency
 * and focus, and read_file short-circuits a re-read of a file already in the set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile } from "./readFile.js";
import { recordWrite, resolvePath } from "./paths.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function freshCtx(): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ws-tool-"));
  return { cwd: dir, reads: new Map(), todos: [] };
}

test("recordWrite marks the file full:false with recency + focus", async () => {
  const ctx = freshCtx();
  const p = join(ctx.cwd, "a.ts");
  await fs.writeFile(p, "one\ntwo\nthree\n");
  await recordWrite(ctx, p, { start: 2, end: 2 });
  const rec = ctx.reads.get(p)!;
  assert.equal(rec.full, false); // the fix: an edit gives a window, not the whole file
  assert.ok((rec.touchedAt ?? 0) > 0);
  assert.deepEqual(rec.focus, [{ start: 2, end: 2 }]);
});

test("an unchanged file already in the transcript is not re-sent", async () => {
  // The ONLY dedup left, and the honest one: the content really is still in the
  // conversation, where the provider has cached it.
  const ctx = freshCtx();
  const p = join(ctx.cwd, "b.ts");
  await fs.writeFile(p, "const other = 7;\n");
  await readFile.execute({ path: "b.ts" }, ctx);
  ctx.transcriptFull = new Set([p]);
  const r = await readFile.execute({ path: "b.ts" }, ctx);
  assert.match(r.output, /unchanged/);
});

// ── the description has to keep telling the truth ─────────────────────────────
// read_file's description now states its contract: the caps, the two replies that
// mean "you already have this", and the fact that reading is what unlocks editing.
// That is worth ~230 tokens on every turn, and it is only worth it while it is
// accurate. A description that drifts from the behaviour is worse than a thin one,
// because the model believes it and cannot tell. These pin the claims to the code.

test("read_file's description matches the replies the tool actually sends", async () => {
  const desc = readFile.description;
  const ctx = freshCtx();
  const p = join(ctx.cwd, "a.ts");
  await fs.writeFile(p, "const value = 42;\n");
  await readFile.execute({ path: "a.ts" }, ctx);

  // The description must NOT promise a <working_files> block any more — it is not sent,
  // and a model told to "read it from there" would be looking for something absent.
  assert.doesNotMatch(desc, /<working_files>/, "the block is gone; the description cannot promise it");

  // The one claim that remains: an unchanged file is not re-sent.
  ctx.transcriptFull = new Set([p]);
  const unchanged = await readFile.execute({ path: "a.ts" }, ctx);
  assert.match(desc, /unchanged since your earlier read/i);
  assert.match(unchanged.output, /unchanged since you last read it/i);
  assert.ok(!unchanged.isError, "a short-circuit is a success, not a failure");
});

test("read_file's description states the caps the code actually enforces", () => {
  const desc = readFile.description;
  assert.match(desc, /2000 lines/, "the default line cap must be the real one");
  assert.match(desc, /256 KB/, "the whole-file size cap must be the real one");
});

test("the tools read_file says require a prior read really do check for one", () => {
  // Named in the description, so a rename or a dropped gate would make it a lie.
  const gate = readFileSync(fileURLToPath(new URL("./editTarget.ts", import.meta.url)), "utf8");
  const write = readFileSync(fileURLToPath(new URL("./writeFile.ts", import.meta.url)), "utf8");
  assert.match(gate, /has not been read this session/);
  assert.match(write, /hasn't been read this session/);
  for (const name of ["edit", "replace_symbol_body", "write_file", "read_symbol"]) {
    assert.match(readFile.description, new RegExp(name), `${name} is named in the description`);
  }
});
