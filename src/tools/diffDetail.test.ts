/**
 * diffDetail.test.ts — the rows an edit shows: what changed, numbered, with a little context.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffDetail, newFileDetail, numberedEditDetail } from "./detail.js";
import { edit } from "./edit.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import type { ToolContext } from "./types.js";

const fresh = (): ToolContext => ({ cwd: mkdtempSync(join(tmpdir(), "mw-diff-")), reads: new Map(), todos: [] });

test("a diff row is its sign, the line number, a bar and the line, with context unmarked", () => {
  const rows = diffDetail("a\nb\nc\nd\ne", "a\nb\nX\nd\ne")!.split("\n");
  assert.deepEqual(rows, ["  1 │ a", "  2 │ b", "- 3 │ c", "+ 3 │ X", "  4 │ d", "  5 │ e"]);
});

test("numbers are padded to the widest, so the bars line up", () => {
  const before = Array.from({ length: 120 }, (_, i) => `l${i + 1}`).join("\n");
  const after = before.replace("l98", "changed");
  const rows = diffDetail(before, after)!.split("\n");
  assert.ok(rows.includes("-  98 │ l98"), rows.join("\n"));
  assert.ok(rows.includes("+  98 │ changed"));
  assert.ok(rows.every((r) => r.indexOf("│") === 6), "every bar is in the same column");
});

test("two changes far apart are separated by one gap row", () => {
  const base = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  const after = base.slice();
  after[4] = "A";
  after[50] = "B";
  const rows = diffDetail(base.join("\n"), after.join("\n"))!.split("\n");
  assert.equal(rows.filter((r) => /^ +⋯$/.test(r)).length, 1);
});

test("a long diff is cut with a count, and the cut is not content", () => {
  const before = Array.from({ length: 80 }, (_, i) => `a${i}`).join("\n");
  const after = Array.from({ length: 80 }, (_, i) => `b${i}`).join("\n");
  const rows = diffDetail(before, after, 30)!.split("\n");
  assert.equal(rows.length, 31);
  assert.match(rows[30]!, /^ +… \(\d+ more lines\)$/);
});

test("nothing changed, or too much to compare, gives null so the caller can show both texts", () => {
  assert.equal(diffDetail("same", "same"), null);
});

test("a new file is numbered additions", () => {
  assert.deepEqual(newFileDetail("one\ntwo\n").split("\n"), ["+ 1 │ one", "+ 2 │ two"]);
  assert.equal(newFileDetail(""), "");
});

test("a replaced symbol is numbered from the line it began on, and marks only what differs", () => {
  const rows = numberedEditDetail("function f() {\n  return 1;\n}", "function f() {\n  return 2;\n}", 40).split("\n");
  assert.deepEqual(rows, ["  40 │ function f() {", "- 41 │   return 1;", "+ 41 │   return 2;", "  42 │ }"]);
});

test("the edit tool shows a paragraph that only gained lines as three additions, not as the paragraph twice", async () => {
  const ctx = fresh();
  const para = Array.from({ length: 11 }, (_, i) => `sentence ${i}`);
  await fs.writeFile(join(ctx.cwd, "n.md"), ["head", ...para, "tail", ""].join("\n"));
  await readFile.execute({ path: "n.md" }, ctx);
  const r = await edit.execute(
    { path: "n.md", edits: [{ old_string: `${para.join("\n")}\ntail`, new_string: `${para.join("\n")}\n\n### New\n\ntail` }] },
    ctx,
  );
  assert.equal(r.isError, undefined);
  const added = r.detail!.split("\n").filter((l) => l.startsWith("+"));
  const removed = r.detail!.split("\n").filter((l) => l.startsWith("-"));
  assert.equal(added.length, 3);
  assert.equal(removed.length, 0, "nothing was removed, so nothing is drawn in red");
});

test("rewriting a file shows what changed against what was there; creating one shows additions", async () => {
  const ctx = fresh();
  await fs.writeFile(join(ctx.cwd, "w.txt"), "one\ntwo\nthree\n");
  await readFile.execute({ path: "w.txt" }, ctx);
  const rewrite = await writeFile.execute({ path: "w.txt", content: "one\nTWO\nthree\n" }, ctx);
  assert.match(rewrite.detail!, /^- 2 │ two$/m);
  assert.match(rewrite.detail!, /^\+ 2 │ TWO$/m);
  assert.doesNotMatch(rewrite.detail!, /^[+-] \d+ │ (one|three)$/m, "the unchanged lines are context, not changes");
  const fresh2 = await writeFile.execute({ path: "new.txt", content: "a\nb\n" }, ctx);
  assert.match(fresh2.detail!, /^\+ 1 │ a$/m);
  assert.match(fresh2.detail!, /^\+ 2 │ b$/m);
});

test("the scope label counts what really changed, not the text of each replacement", async () => {
  const ctx = fresh();
  const para = Array.from({ length: 12 }, (_, i) => `sentence ${i}`);
  await fs.writeFile(join(ctx.cwd, "s.md"), ["head", ...para, "tail", ""].join("\n"));
  await readFile.execute({ path: "s.md" }, ctx);
  const r = await edit.execute(
    { path: "s.md", edits: [{ old_string: `${para.join("\n")}\ntail`, new_string: `${para.join("\n")}\n\n### New\n\ntail` }] },
    ctx,
  );
  assert.match(r.summary!, /−0 \+3/, r.summary);
  assert.doesNotMatch(r.summary!, /−13/, "the paragraph that was only re-sent is not counted as removed");
  assert.match(r.detail!, /^L14-16 · −0 \+3$/m, "and the range is the three new lines");
});

test("edits far apart are one label spanning all of them, and CRLF files diff cleanly", async () => {
  const ctx = fresh();
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  await fs.writeFile(join(ctx.cwd, "c.txt"), lines.join("\r\n") + "\r\n");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await edit.execute(
    { path: "c.txt", edits: [{ old_string: "line 50", new_string: "FIFTY" }, { old_string: "line 5\n", new_string: "FIVE\n" }] },
    ctx,
  );
  assert.equal(r.isError, undefined);
  assert.match(r.detail!, /^2 edits · L5-50 · −2 \+2$/m, r.detail);
  const marked = r.detail!.split("\n").filter((l) => /^[+-] /.test(l));
  assert.equal(marked.length, 4, "only the two changed lines, each way: a CRLF file does not make every line differ");
});
