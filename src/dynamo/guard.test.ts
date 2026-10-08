import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guardOptions,
  GUARD_REFUSAL,
  GUARD_REFUSAL_INPUT,
  guardRefusalWith,
  describeCall,
  guardQuestion,
  guardDetail,
  interpretGuardChoice,
} from "./guard.js";

test("interpretGuardChoice maps each option to its action", () => {
  const opts = guardOptions("run_command");
  assert.equal(interpretGuardChoice(opts[0], "run_command"), "proceed");
  assert.equal(interpretGuardChoice(opts[1], "run_command"), "allow-kind");
});

test("a session grant names the KIND of action, so it cannot be read as a blanket yes", () => {
  // It used to say "Yes, and stop asking this session" and mean it: approving one file
  // edit turned the gate off for shell commands too. The label now says what is being
  // granted, and the engine only ever grants that one tool.
  const edit = guardOptions("edit")[1]!;
  const shell = guardOptions("run_command")[1]!;
  assert.notEqual(edit, shell, "two different actions offer the same grant");
  assert.match(edit, /File edit/);
  assert.match(shell, /Shell execution/);
  assert.doesNotMatch(edit, /stop asking this session$/, "the blanket wording is back");
  // And an answer given for one action does not read as a grant for another.
  assert.equal(interpretGuardChoice(shell, "edit"), "refuse", "a grant leaked across actions");
});

test("a refusal can carry what the user wants instead", () => {
  assert.ok(GUARD_REFUSAL_INPUT.label.length > 0);
  const text = guardRefusalWith("use pnpm, not npm");
  assert.match(text, /use pnpm, not npm/);
  assert.match(text, /declined/i);
  assert.match(text, /do not retry/i, "the declined action must not be attempted again");
});

test("interpretGuardChoice fails safe on cancel / unknown answers", () => {
  assert.equal(interpretGuardChoice(undefined, "edit"), "refuse"); // Esc / no channel
  assert.equal(interpretGuardChoice("", "edit"), "refuse");
  assert.equal(interpretGuardChoice("whatever", "edit"), "refuse");
});

test("describeCall names the file for edit/write tools", () => {
  assert.equal(describeCall("edit_file", { path: "src/app.ts" }), "edit_file — src/app.ts");
  assert.equal(describeCall("write_file", { path: "a/b.ts" }), "write_file — a/b.ts");
  assert.equal(describeCall("replace_symbol_body", { path: "m.ts", name: "greet" }), "replace_symbol_body — m.ts");
});

test("describeCall shows the command for run_command, clipped", () => {
  assert.equal(describeCall("run_command", { command: "npm test" }), "run_command — npm test");
  const long = describeCall("run_command", { command: "x".repeat(200) });
  assert.ok(long.length < 120, "long commands are clipped");
  assert.ok(long.endsWith("…"));
});

test("describeCall shows the task for spawn_subagent", () => {
  assert.equal(describeCall("spawn_subagent", { task: "find call sites" }), "spawn_subagent — find call sites");
});

test("describeCall degrades gracefully for unknown tools", () => {
  assert.equal(describeCall("some_external_tool", { path: "/tmp/x" }), "some_external_tool — /tmp/x");
  assert.equal(describeCall("weird_tool", {}), "weird_tool");
});

test("the question is one line and there are exactly 3 options", () => {
  // One line because it renders inside a height-bounded box. What the call actually is
  // moved to guardDetail, which prints into the transcript — see the test below.
  const q = guardQuestion();
  assert.match(q, /Sentinel/);
  assert.equal(q.split("\n").length, 1);
  // Two choices plus the typed refusal row — ApprovalBox renders at most six.
  assert.equal(guardOptions("edit").length, 2);
  assert.ok(GUARD_REFUSAL.length > 0);
});

test("guardDetail spells out what is about to happen, in full", () => {
  const d = guardDetail("run_command", { command: "git push origin main --force" });
  assert.match(d, /Action: Shell execution/, "named in the user's terms, not the tool's");
  assert.match(d, /\$ git push origin main --force/);
  assert.match(d, /Tool: run_command/, "the exact tool is still recorded");
});

test("a command is shown WHOLE, because the tail is where the damage is", () => {
  // A clipped command hides the end of it, and on a shell command that is exactly the
  // part worth reading — `… && rm -rf /`. This is the one field that is never trimmed.
  const long = "npm run build " + "--flag ".repeat(60) + "&& rm -rf dist";
  const d = guardDetail("run_command", { command: long });
  assert.ok(d.includes(long), "the command must not be truncated");
  assert.match(d, /rm -rf dist/);
});

test("guardDetail states facts and never invents a risk rating", () => {
  // The reference design shows "Risk: High". Nothing in Mindweave knows which commands
  // are dangerous, so a severity here would be a guess presented as an assessment —
  // and a wrong "Low" is worse than no line at all.
  const d = guardDetail("run_command", { command: "rm -rf /" });
  assert.doesNotMatch(d, /Risk:/i);
});

test("guardDetail names the file for an edit, and the task for a sub-agent", () => {
  assert.match(guardDetail("edit", { path: "src/App.tsx" }), /Action: File edit/);
  assert.match(guardDetail("edit", { path: "src/App.tsx" }), /File: src\/App\.tsx/);
  assert.match(guardDetail("spawn_subagent", { task: "audit the auth flow" }), /Task: audit the auth flow/);
});

test("a command prefix adds a third, standing answer that maps to its own decision", async () => {
  const { guardOptions, interpretGuardChoice } = await import("./guard.js");
  assert.equal(guardOptions("run_command").length, 2, "no prefix, no third option");
  const options = guardOptions("run_command", "npm test");
  assert.equal(options.length, 3);
  assert.match(options[2]!, /never ask again for "npm test" in this project/);
  assert.equal(interpretGuardChoice(options[0], "run_command", "npm test"), "proceed");
  assert.equal(interpretGuardChoice(options[1], "run_command", "npm test"), "allow-kind");
  assert.equal(interpretGuardChoice(options[2], "run_command", "npm test"), "allow-prefix");
  // The standing answer does not exist without a prefix: the same text is just an unknown answer.
  assert.equal(interpretGuardChoice(options[2], "run_command"), "refuse");
  assert.equal(interpretGuardChoice("No", "run_command", "npm test"), "refuse");
});
