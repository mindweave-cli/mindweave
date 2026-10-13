/**
 * commandMenu.test.ts — what the slash menu lists, and how a long name is drawn.
 *
 * A connected server can offer dozens of prompts with long names. They were listed in the
 * bare `/` menu among the commands, and a name wider than its column was not cut, so it
 * wrapped onto the next row and pushed its description out of line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandMatches, fitName, type Completion } from "./components/PromptInput.js";

const list: Completion[] = [
  { name: "/help", description: "help" },
  { name: "/model", description: "model" },
  { name: "/rea:audit_residual_unknowns", description: "a prompt from a server", quiet: true },
  { name: "/rea:investigate_feature", description: "another", quiet: true },
];

test("a bare slash lists the commands and not a server's prompts", () => {
  assert.deepEqual(commandMatches(list, "/").map((c) => c.name), ["/help", "/model"]);
});

test("typing after the slash finds a server's prompts by their name", () => {
  assert.deepEqual(commandMatches(list, "/rea").map((c) => c.name), ["/rea:audit_residual_unknowns", "/rea:investigate_feature"]);
  assert.deepEqual(commandMatches(list, "/rea:inv").map((c) => c.name), ["/rea:investigate_feature"]);
  assert.deepEqual(commandMatches(list, "/h").map((c) => c.name), ["/help"]);
});

test("matching ignores case and a prompt can still be typed in full", () => {
  assert.deepEqual(commandMatches(list, "/REA:AUDIT").map((c) => c.name), ["/rea:audit_residual_unknowns"]);
  assert.deepEqual(commandMatches(list, "/rea:audit_residual_unknowns").length, 1);
});

test("a name wider than its column is cut with an ellipsis, never wrapped", () => {
  assert.equal(fitName("/rea:audit_residual_unknowns", 18), "/rea:audit_residu…");
  assert.equal(fitName("/rea:audit_residual_unknowns", 18).length, 18);
  assert.equal(fitName("/help", 18), "/help" + " ".repeat(13), "a short one is padded to the column");
  assert.equal(fitName("/exactly-eighteen-x", 18).length, 18);
});
