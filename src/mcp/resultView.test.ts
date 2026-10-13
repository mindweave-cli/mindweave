/**
 * resultView.test.ts — how an MCP call reads on screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { argsLine, elapsedLabel, mcpDetailText, mcpErrorReason, mcpSummary, resultLines } from "./resultView.js";

test("a JSON error is reduced to the server's own message", () => {
  const text = JSON.stringify({ error: { code: "target_unavailable", category: "unavailable", message: "No app is open. Ask the user which app to investigate." } });
  assert.equal(mcpErrorReason(text), "No app is open. Ask the user which app to investigate.");
});

test("the other common error shapes give a reason too", () => {
  assert.equal(mcpErrorReason(JSON.stringify({ error: "bad path" })), "bad path");
  assert.equal(mcpErrorReason(JSON.stringify({ error: { code: "E_NOPE" } })), "E_NOPE");
  assert.equal(mcpErrorReason(JSON.stringify({ message: "rate limited" })), "rate limited");
});

test("plain text gives its first line, without a leading Error:", () => {
  assert.equal(mcpErrorReason("Error: file not found\nat foo.js:1"), "file not found");
  assert.equal(mcpErrorReason("\n\n  boom  \nmore"), "boom");
});

test("a reason is never empty and never a paragraph", () => {
  assert.match(mcpErrorReason(""), /said nothing more/);
  const long = mcpErrorReason("x".repeat(2000));
  assert.ok(long.length <= 400 && long.endsWith("…"));
});

test("durations read as a person says them", () => {
  assert.equal(elapsedLabel(5), "5ms");
  assert.equal(elapsedLabel(1400), "1.4s");
  assert.equal(elapsedLabel(42_000), "42s");
  assert.equal(elapsedLabel(130_000), "2m 10s");
});

test("the verdict is the time when it worked and the reason when it did not", () => {
  assert.equal(mcpSummary(false, "{}", 1400), "1.4s");
  assert.equal(mcpSummary(false, "{}"), "");
  assert.equal(mcpSummary(true, "Error: nope", 5), "nope");
});

test("results are laid out for reading", () => {
  assert.deepEqual(resultLines('{"a":{"b":1}}'), ["{", '  "a": {', '    "b": 1', "  }", "}"]);
  assert.deepEqual(resultLines("one\n\n\n\ntwo\n\n"), ["one", "", "two"], "no runs of blank lines, none at the ends");
  assert.deepEqual(resultLines("not { json"), ["not { json"], "text that only looks like JSON is left alone");
});

test("the block under a call says what was asked, then what came back, and cuts with a count", () => {
  assert.equal(argsLine({}), "no arguments");
  assert.equal(argsLine({ path: "C:\\x" }), '{"path":"C:\\\\x"}');
  const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const shown = mcpDetailText({ q: 1 }, body, 5).split("\n");
  assert.equal(shown[0], 'asked  {"q":1}');
  assert.equal(shown[1], "");
  assert.equal(shown[2], "line 1");
  assert.match(shown[shown.length - 1]!, /… \(15 more lines\)/, "the cut says how much is behind it, in the form the row recognises");
  assert.match(mcpDetailText({}, "", 5), /\(it returned nothing\)/);
});
