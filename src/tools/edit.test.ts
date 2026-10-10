import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile } from "./readFile.js";
import { edit } from "./edit.js";

function freshCtx(): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-test-"));
  return { cwd: dir, reads: new Map(), todos: [] };
}

test("edit applies several edits to one file in order", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta gamma");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await edit.execute(
    {
      path: "c.txt",
      edits: [
        { old_string: "alpha", new_string: "ONE" },
        { old_string: "beta", new_string: "TWO" },
        { old_string: "gamma", new_string: "THREE" },
      ],
    },
    ctx,
  );
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "ONE TWO THREE");
  assert.match(r.output, /3 edits, 3 replacements/);
});

test("edit lets a later edit target text an earlier edit produced", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "hello world");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await edit.execute(
    {
      path: "c.txt",
      edits: [
        { old_string: "hello", new_string: "hi" },
        { old_string: "hi world", new_string: "hi there" },
      ],
    },
    ctx,
  );
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "hi there");
});

test("edit is atomic: one bad edit writes nothing", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await edit.execute(
    {
      path: "c.txt",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "does-not-exist", new_string: "x" },
      ],
    },
    ctx,
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /edit #2/);
  // The file is untouched — the first edit did NOT land.
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "alpha beta");
});

test("edit refuses a file that wasn't read WHEN the edit does not match it", async () => {
  // This used to refuse ANY edit to an unread file, before looking. That cost a whole
  // extra round trip plus a full re-read every time the model already knew the text —
  // measured on a real session as four refusals, four ~9,000-token reads, and then the
  // same four edits applying first try. An `old_string` is matched against the file's
  // current bytes, so a unique match is the evidence; a guess like this one is not.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  const r = await edit.execute(
    { path: "c.txt", edits: [{ old_string: "beta", new_string: "B" }] },
    ctx,
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /has not been read/);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "alpha", "nothing may be written");
});

test("edit preserves CRLF line endings", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "a\r\nb\r\nc");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await edit.execute(
    { path: "c.txt", edits: [{ old_string: "a\nb", new_string: "A\nB" }] },
    ctx,
  );
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "A\r\nB\r\nc");
});

test("edit rejects an empty edits array", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await edit.execute({ path: "c.txt", edits: [] }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /non-empty array/);
});

test("a long edit keeps the whole diff to open, past the rows the row shows", async () => {
  const ctx = freshCtx();
  const before = Array.from({ length: 60 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 60 }, (_, i) => `new ${i}`).join("\n");
  await fs.writeFile(join(ctx.cwd, "big.txt"), `${before}\ntail\n`);
  await readFile.execute({ path: "big.txt" }, ctx);
  const r = await edit.execute({ path: "big.txt", edits: [{ old_string: before, new_string: after }] }, ctx);
  assert.equal(r.isError, undefined);
  assert.ok((r.detail ?? "").includes("more line"), "the row itself is cut short");
  assert.ok(r.detailFull, "and the whole diff is kept");
  assert.ok(r.detailFull!.includes("- old 59") && r.detailFull!.includes("+ new 59"), "both ends of the change are in it");
  assert.ok(r.detailFull!.split("\n").length > (r.detail ?? "").split("\n").length);
});

test("an edit one line past what the row shows can still be opened", async () => {
  // The row shows thirty lines and a marker. Thirty-one lines of change used to be thirty and
  // a marker, the same size as the whole, so nothing was thought to be hidden and the row said
  // "(1 more line)" with no way to open it.
  const { hasMore } = await import("../cli/transcript.js");
  const ctx = freshCtx();
  const before = Array.from({ length: 11 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 20 }, (_, i) => `new ${i}`).join("\n");
  await fs.writeFile(join(ctx.cwd, "m.txt"), `${before}\ntail\n`);
  await readFile.execute({ path: "m.txt" }, ctx);
  const r = await edit.execute({ path: "m.txt", edits: [{ old_string: before, new_string: after }] }, ctx);
  assert.match(r.detail ?? "", /\(1 more line\)/, "the setup is the one-line-over case");
  assert.equal(hasMore(r.detail, r.detailFull), true, "and it is openable");
});
