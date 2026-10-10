/**
 * help.test.ts — `/help` renders from the live command lists, aligns as one column,
 * and never prints an empty heading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHelp } from "./help.js";

const BUILT_IN = [
  { name: "/model", description: "choose which model answers" },
  { name: "/undo", description: "roll back the file changes from the last turn" },
];

test("commands are listed with their descriptions", () => {
  const text = formatHelp([{ title: "Commands", commands: BUILT_IN }]);
  assert.match(text, /Commands/);
  assert.match(text, /\/model\s+choose which model answers/);
  assert.match(text, /\/undo\s+roll back the file changes from the last turn/);
});

test("an empty section is dropped, not printed as a bare heading", () => {
  const text = formatHelp([
    { title: "Commands", commands: BUILT_IN },
    { title: "Project skills", commands: [] },
  ]);
  assert.doesNotMatch(text, /Project skills/);
});

test("descriptions align on one column across every section", () => {
  const text = formatHelp([
    { title: "Commands", commands: [{ name: "/go", description: "short name" }] },
    { title: "Project skills", commands: [{ name: "/a-much-longer-one", description: "long name" }] },
  ]);
  // The longest name in ANY section sets the column, so both descriptions start
  // at the same offset — per-section widths would produce a ragged edge.
  const lines = text.split("\n").filter((l) => l.includes("name"));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.indexOf("short name"), lines[1]!.indexOf("long name"));
});

test("the things with no autocomplete entry are still discoverable", () => {
  const text = formatHelp([{ title: "Commands", commands: BUILT_IN }]);
  assert.match(text, /@path/); // attachments
  assert.match(text, /Esc/); // interrupt
});

test("the folded lines are explained, since nothing on one says how to open it", () => {
  const text = formatHelp([{ title: "Commands", commands: BUILT_IN }]);
  assert.match(text, /About the lines that fold/);
  assert.match(text, /Ran 3 commands, read 2 files/);
  assert.match(text, /Click\s+a line that ends in ▸ opens it/);
  assert.match(text, /Ctrl\+O/);
  assert.match(text, /PageUp \/ wheel/);
});
