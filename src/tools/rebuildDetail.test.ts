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
