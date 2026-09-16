/**
 * backgroundWake.test.ts — a finished background command must not start a turn under an
 * open menu.
 *
 * The wake used to check only that no turn was running. A command finishing while
 * `/continue` was open started a turn underneath the picker, and picking a session from
 * it swaps the session that turn is running on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReactToBackground, type WakeState } from "./backgroundWake.js";

const idle: WakeState = { ready: true, busy: false, needsKey: false, reacting: false, modalOpen: false, pending: 1 };

test("an idle app wakes for a finished background command", () => {
  assert.equal(shouldReactToBackground(idle), true);
});

test("an open menu or screen holds the wake back", () => {
  assert.equal(shouldReactToBackground({ ...idle, modalOpen: true }), false);
});

test("closing the menu lets the same pending wake through", () => {
  // The caller re-runs the check when modalOpen changes; the event is still pending, so
  // nothing was lost by waiting.
  const held = { ...idle, modalOpen: true };
  assert.equal(shouldReactToBackground(held), false);
  assert.equal(shouldReactToBackground({ ...held, modalOpen: false }), true);
});

test("the conditions that already held a wake back still do", () => {
  assert.equal(shouldReactToBackground({ ...idle, busy: true }), false, "a turn is running");
  assert.equal(shouldReactToBackground({ ...idle, ready: false }), false, "still loading");
  assert.equal(shouldReactToBackground({ ...idle, needsKey: true }), false, "no key to run a turn with");
  assert.equal(shouldReactToBackground({ ...idle, reacting: true }), false, "already waking");
  assert.equal(shouldReactToBackground({ ...idle, pending: 0 }), false, "nothing to report");
});
