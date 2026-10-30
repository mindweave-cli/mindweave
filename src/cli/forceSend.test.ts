/**
 * forceSend.test.ts — what ctrl+F does with the turn.
 *
 * Seen as: a message typed during a long model call (a whole file written in one call, about half a minute) and ctrl+F pressed over
 * and over with nothing happening, because the key only waited for the step to end by itself. It now ends the step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forceSendPlan } from "./messageQueue.js";

const base = { busy: true, movedCommand: "none" as const, workersAtWork: false, userCommandRunning: false };

test("idle: it is Enter", () => {
  assert.equal(forceSendPlan({ ...base, busy: false }), "send");
});

test("the model is writing and nothing else is running: that request is cut and the message goes out at once", () => {
  assert.equal(forceSendPlan(base), "cut");
});

test("a command the turn waits on is moved to the background, and the step ends by itself", () => {
  assert.equal(forceSendPlan({ ...base, movedCommand: "moved" }), "ends");
  assert.equal(forceSendPlan({ ...base, movedCommand: "stuck" }), "ends");
});

test("sub-agents at work are not cut; the screen says the message waits for them", () => {
  assert.equal(forceSendPlan({ ...base, workersAtWork: true }), "wait");
});

test("a command the person ran with ! is theirs: the turn is not cut for it", () => {
  assert.equal(forceSendPlan({ ...base, userCommandRunning: true }), "ends");
});
