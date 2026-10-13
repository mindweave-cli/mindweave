/**
 * commandBackground.test.ts — when ctrl+X is offered, and what a press does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_OFFER_AFTER_MS, offerBackground, pressBackground } from "./commandBackground.js";
import { ForegroundCommands } from "../tools/foregroundCommands.js";
import { formatHelp } from "./help.js";

test("the offer appears after a couple of seconds, not before", () => {
  assert.equal(offerBackground(null, 10_000, false), false, "nothing running, nothing to offer");
  assert.equal(offerBackground(10_000, 10_000 + COMMAND_OFFER_AFTER_MS - 1, false), false);
  assert.equal(offerBackground(10_000, 10_000 + COMMAND_OFFER_AFTER_MS, false), true);
});

test("no offer while a question is open", () => {
  // The clock stands still then; the command is not what the person is being asked about.
  assert.equal(offerBackground(0, 60_000, true), false);
});

test("a press moves what runs, says nothing when nothing runs, and flags what cannot move", () => {
  assert.equal(pressBackground(undefined), "none");
  const fg = new ForegroundCommands();
  assert.equal(pressBackground(fg), "none", "a stray press needs no comment");

  let moved = 0;
  fg.register({ id: "a", command: "a", startedAt: 0, promote: () => (moved++, true) });
  assert.equal(pressBackground(fg), "moved");
  assert.equal(moved, 1);

  const stuck = new ForegroundCommands();
  stuck.register({ id: "b", command: "b", startedAt: 0, promote: () => false });
  assert.equal(pressBackground(stuck), "stuck", "running but not movable is the one case worth saying");
});

test("/help explains ctrl+X where the person will look", () => {
  const text = formatHelp([{ title: "Commands", commands: [{ name: "/help", description: "help" }] }]);
  assert.match(text, /ctrl\+X/);
  assert.match(text, /background shell/);
});
