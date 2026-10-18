/**
 * rebuildDetail.test.ts — a row saved before the uncut text was kept can still be opened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_DETAIL_LINES, capLines, editDetail, multiEditDetail, withOutcome, withScope, writeDetail } from "./detail.js";
import { rebuildFull } from "./rebuildDetail.js";

const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

test("a written file is rebuilt from the call's own content, under the row's own scope line", () => {
  const detail = withScope("new file · 50 lines", writeDetail(body));
  const full = rebuildFull("write_file", { path: "a.md", content: body }, { detail, content: "Wrote a.md" })!;
  const lines = full.split("\n");
  assert.equal(lines[0], "new file · 50 lines");
  assert.equal(lines.length, 51);
  assert.equal(lines[50], "+ line 50");
});

test("an edit is rebuilt from the old and new strings of the call", () => {
  const edits = [{ old_string: "a\nb\nc\nd\ne", new_string: "1\n2\n3\n4\n5" }, { old_string: "x", new_string: "y" }];
  const ops = edits.map((e) => ({ oldString: e.old_string, newString: e.new_string }));
  const detail = withScope("2 edits · L1-9 · −6 +6", multiEditDetail(ops, 4));
  const full = rebuildFull("edit", { path: "a.ts", edits }, { detail, content: "Edited" })!;
  assert.equal(full, withScope("2 edits · L1-9 · −6 +6", multiEditDetail(ops)));
});

test("a command is rebuilt from the output the model was given, framed by its own header and verdict", () => {
  const out = Array.from({ length: 40 }, (_, i) => `out ${i}`).join("\n");
  const detail = withOutcome("$ build\nout 0\n… 38 earlier lines hidden\nout 39", false, 0, null, 1000, 12);
  const full = rebuildFull("run_command", { command: "build" }, { detail, content: out })!;
  const lines = full.split("\n");
  assert.equal(lines[0], "$ build");
  assert.ok(lines.includes("out 20"), "the middle is back");
  assert.match(lines[lines.length - 1]!, /^✓ 0/);
});

test("nothing is rebuilt when there is nothing more to open, or for a tool with no uncut block", () => {
  const detail = withScope("new file · 2 lines", writeDetail("a\nb"));
  assert.equal(rebuildFull("write_file", { content: "a\nb" }, { detail, content: "" }), undefined, "it fits already");
  assert.equal(rebuildFull("search", { pattern: "x" }, { detail: "a\nb\nc", content: "x\ny\nz\nw" }), undefined);
  assert.equal(rebuildFull("write_file", { path: "a" }, { detail, content: "" }), undefined, "no content in the call");
  assert.equal(rebuildFull(undefined, undefined, { detail, content: "" }), undefined);
  assert.equal(rebuildFull("write_file", { content: body }, { content: "" }), undefined, "no stored row at all");
});

test("a rebuilt block is bounded like a saved one", () => {
  const huge = Array.from({ length: SESSION_DETAIL_LINES * 2 }, (_, i) => `row ${i}`).join("\n");
  const detail = capLines(huge.split("\n").map((l) => `+ ${l}`), 20);
  const full = rebuildFull("write_file", { content: huge }, { detail, content: "" })!;
  assert.ok(full.split("\n").length <= SESSION_DETAIL_LINES + 2);
  assert.match(full, /lines are not kept in the saved session/);
  assert.ok(editDetail("a", "b").length > 0);
});

test("an edit that re-sent a block with a few lines added is not rebuilt as every line removed and added", () => {
  // The row's own count (-0 +2) says only two lines changed; the old and new text would show -5 +9.
  const edits = [{ old_string: "/* c */\n.a {\n  d: none;\n}\n  flex: 1;", new_string: "/* c */\n.a {\n  d: none;\n}\n\n.b {\n  flex: 1;" }];
  const detail = "L363-364 · −0 +2\n  361 │   d: none;\n  362 │ }\n+ 363 │ \n+ 364 │ .b {\n  365 │   flex: 1;";
  assert.equal(rebuildFull("edit", { path: "a.css", edits }, { detail, content: "Edited" }), undefined);
});

test("a read whose text was cleared from the conversation still opens: the saved copy first, then the file as it is now", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { recoverReadText } = await import("./rebuildDetail.js");
  const dir = mkdtempSync(join(tmpdir(), "mw-recover-"));
  const saved = join(dir, "call_1.txt");
  writeFileSync(saved, "  1\tone\n  2\ttwo\n");
  const read = (p: string): string | undefined => { try { return readFileSync(p, "utf8"); } catch { return undefined; } };
  const stub = `[old tool result cleared to save context]\n[saved at ${saved} · 2 lines · ~4 tokens; read_file it]`;
  assert.equal(recoverReadText(stub, undefined, dir, read, resolve), "  1\tone\n  2\ttwo");
  // Cleared before copies were saved: the file itself, and it says so.
  writeFileSync(join(dir, "a.ts"), "x\ny\nz\n");
  const bare = "[old tool result cleared to save context]";
  const whole = recoverReadText(bare, { args: { path: "a.ts" } }, dir, read, resolve)!;
  assert.match(whole, /as it is now/);
  assert.match(whole, /1\tx\n2\ty\n3\tz/);
  const part = recoverReadText(bare, { args: { path: "a.ts", offset: 2, limit: 1 } }, dir, read, resolve)!;
  assert.match(part, /2\ty/);
  assert.doesNotMatch(part, /3\tz/);
  assert.equal(recoverReadText(bare, { args: { path: "gone.ts" } }, dir, read, resolve), undefined);
});

test("a command whose output was cleared is rebuilt from the copy clearing saved", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mw-recover-"));
  const saved = join(dir, "c.txt");
  const out = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(saved, out);
  const detail = "$ npm test\nline 0\nline 1\n  … (38 more lines)\n✓ 0 · 1s";
  const full = rebuildFull("run_command", { command: "npm test" }, { detail, content: `[old tool result cleared to save context]\n[saved at ${saved} · 40 lines · ~80 tokens]` });
  assert.ok(full && full.includes("line 39"), "the whole output is back");
  assert.equal(rebuildFull("run_command", { command: "npm test" }, { detail, content: "[old tool result cleared to save context]" }), undefined, "nothing saved, nothing invented");
});
