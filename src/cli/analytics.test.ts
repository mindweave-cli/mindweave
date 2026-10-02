/**
 * analytics.test.ts — the usage count is paused: nothing is sent and it cannot be turned on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../memory/store.js";
import { analyticsEnabled, sendAnalyticsPing, setAnalyticsEnabled, ANALYTICS_PAUSED_MESSAGE } from "./analytics.js";

test("an older install that saved the count as ON still sends nothing", async () => {
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(join(stateRoot(), "analytics.json"), JSON.stringify({ enabled: true, id: "old-id" }));
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(null, { status: 204 }); }) as typeof fetch;
  try {
    assert.equal(analyticsEnabled(), false);
    sendAnalyticsPing("3.0.0");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 0, "no request leaves the machine");
  } finally {
    globalThis.fetch = real;
  }
});

test("turning it on is refused and the message says why", () => {
  assert.equal(setAnalyticsEnabled(true), false);
  assert.equal(analyticsEnabled(), false);
  assert.match(ANALYTICS_PAUSED_MESSAGE, /better way to count/);
  assert.match(ANALYTICS_PAUSED_MESSAGE, /nothing is sent/);
});
