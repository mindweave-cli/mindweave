/**
 * Tool-call arguments that are not valid JSON: the model is told so (not "`path` is required"), and the broken
 * text does not travel in the history. Both shapes below were seen in real sessions: an edit whose reply was cut
 * one brace short, and a `ui` call with a stray colon inside a step.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { argsProblem, argsRefusal, wireArguments } from "./toolArgs.js";

test("valid arguments, and none at all, are not a problem", () => {
  assert.equal(argsProblem(""), null);
  assert.equal(argsProblem("{}"), null);
  assert.equal(argsProblem('{"path": "a.txt", "n": 2}'), null);
});

test("a stray colon names where it broke", () => {
  const raw = '{"action": "steps", "steps": [{"action": "click", "name": "Toggle"}, {"action": "wait_ms": 800}]}';
  const problem = argsProblem(raw)!;
  assert.match(problem, /not valid JSON/);
  assert.match(problem, /wait_ms/, "the piece of text near the fault is quoted");
  assert.doesNotMatch(problem, /cut off at the output limit/, "a balanced call is not blamed on the output limit");
});

test("a reply cut off before the JSON closes says so", () => {
  const raw = '{"path": "src/a.ts", "edits": "[{\\"old_string\\": \\"x\\", \\"new_string\\": \\"y\\"}]"';
  const problem = argsProblem(raw)!;
  assert.match(problem, /output limit/);
});

test("arguments that are JSON but not an object are refused", () => {
  assert.match(argsProblem('"{\\"path\\": \\"a\\"}"')!, /one JSON object, and this was a string/);
  assert.match(argsProblem("[1,2]")!, /an array/);
  assert.match(argsProblem("null")!, /null/);
});

test("the refusal names the tool and says nothing ran", () => {
  const text = argsRefusal("edit", argsProblem("{oops")!);
  assert.match(text, /^Not run: the arguments for `edit`/);
  assert.match(text, /nothing was changed/);
  assert.match(text, /valid JSON\.$/);
});

test("what goes back to the provider is always valid JSON", () => {
  assert.equal(wireArguments('{"a":1}'), '{"a":1}');
  assert.equal(wireArguments(""), "");
  const big = '{"content": "' + "x".repeat(5000);
  const sent = wireArguments(big);
  const parsed = JSON.parse(sent) as { _invalid_json: string };
  assert.ok(parsed._invalid_json.startsWith('{"content": "xxx'), "the model still sees what it tried");
  assert.ok(sent.length < 500, "the broken text is not carried whole into every later request");
  assert.match(parsed._invalid_json, /5013 characters in all/);
});
