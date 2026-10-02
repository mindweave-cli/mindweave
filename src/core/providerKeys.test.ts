/**
 * providerKeys.test.ts — several keys per provider, managed from a UI.
 *
 * Every case reads the result back from the store (the env slots, the live variable,
 * keys.json), not from what the function returned, because the failure this guards is
 * the one keyStore.test.ts was written for: a change that looks right and quietly loses
 * or swaps a key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../cli/bootstrap.js";
import { keysFor } from "../cli/keyStore.js";
import {
  addProviderKey,
  editProviderKey,
  failoverKey,
  makeDefaultProviderKey,
  providerKeys,
  removeProviderKey,
  renameProviderKey,
  setProviderAutoSwitch,
  setProviderKeyDisabled,
  useProviderKey,
} from "./providerKeys.js";

const P = "glm";
const V = "ZAI_API_KEY";

function fresh(): void {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "provkeys-"));
  for (const k of Object.keys(process.env)) if (k.startsWith(V)) delete process.env[k];
  loadConfig(mkdtempSync(join(tmpdir(), "provkeys-proj-")));
}
const stored = () => keysFor(V).map((k) => k.value).join(" ");
const live = () => process.env[V];
const three = () => {
  addProviderKey(P, "key-aaaa");
  addProviderKey(P, "key-bbbb", "Work");
  addProviderKey(P, "key-cccc");
};

test("keys are added in order; the first is default and live; views never carry a whole key", () => {
  fresh();
  three();
  assert.equal(stored(), "key-aaaa key-bbbb key-cccc");
  assert.equal(live(), "key-aaaa");
  const view = providerKeys(P);
  assert.deepEqual(view.keys.map((k) => [k.hint, k.label, k.live, k.isDefault]), [
    ["…aaaa", "", true, true],
    ["…bbbb", "Work", false, false],
    ["…cccc", "", false, false],
  ]);
  for (const whole of ["key-aaaa", "key-bbbb", "key-cccc"]) {
    assert.ok(!JSON.stringify(view).includes(whole), "a view must not contain a whole key");
  }
  assert.equal(addProviderKey(P, "key-bbbb").ok, false, "the same key twice is refused");
});

test("switching off the live key moves the drivers to the next one that is on", () => {
  fresh();
  three();
  setProviderKeyDisabled(P, 1, true);
  assert.equal(live(), "key-bbbb");
  assert.equal(useProviderKey(P, 1).ok, false, "a switched-off key cannot be used");
  setProviderKeyDisabled(P, 2, true);
  setProviderKeyDisabled(P, 3, true);
  assert.equal(live(), undefined, "all off: nothing is sent");
  assert.equal(stored(), "key-aaaa key-bbbb key-cccc", "switching off never deletes");
});

test("making a key the default moves it to the front, keeps the rest in order, and its name follows it", () => {
  fresh();
  three();
  makeDefaultProviderKey(P, 2);
  assert.equal(stored(), "key-bbbb key-aaaa key-cccc");
  assert.equal(live(), "key-bbbb");
  assert.equal(providerKeys(P).keys[0]!.label, "Work");
});

test("editing the live key changes what is sent at once, and keeps its name", () => {
  fresh();
  three();
  useProviderKey(P, 2);
  editProviderKey(P, 2, "key-dddd");
  assert.equal(live(), "key-dddd");
  assert.equal(stored(), "key-aaaa key-dddd key-cccc");
  assert.equal(providerKeys(P).keys[1]!.label, "Work");
  renameProviderKey(P, 2, "");
  assert.equal(providerKeys(P).keys[1]!.label, "");
});

test("a refused key moves to the next one only when auto-switch is on, skipping off and tried keys", () => {
  fresh();
  three();
  const tried = new Set<string>();
  assert.equal(failoverKey(V, 402, tried), null, "auto-switch off: the refusal stands");
  assert.equal(providerKeys(P).keys[0]!.failure?.reason, "no-credit", "but the refusal is recorded");

  setProviderAutoSwitch(P, true);
  setProviderKeyDisabled(P, 2, true);
  const turn = new Set<string>();
  const moved = failoverKey(V, 402, turn);
  assert.deepEqual(moved, { from: "…aaaa", to: "…cccc", reason: "no-credit" }, "skips the disabled key");
  assert.equal(live(), "key-cccc");
  assert.equal(failoverKey(V, 429, turn), null, "every usable key tried in this turn: stop, don't loop");
});

test("removing a key clears its name and settles the live key on one that is on", () => {
  fresh();
  three();
  useProviderKey(P, 2);
  removeProviderKey(P, 2);
  assert.equal(stored(), "key-aaaa key-cccc");
  assert.equal(live(), "key-aaaa");
  addProviderKey(P, "key-bbbb");
  assert.equal(providerKeys(P).keys[2]!.label, "", "a re-added key does not inherit the old name");
});
