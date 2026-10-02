/**
 * contextSettings.test.ts — the user's own auto-compaction bar: project wins over
 * global, the live session picks it up at once (no restart), and the engine's actual
 * compaction bar (engine.ts's effectiveAutoCompactThreshold) agrees with the view.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../memory/session.js";
import { effectiveAutoCompactThreshold } from "../dynamo/engine.js";
import { autoCompactThreshold } from "../dynamo/contextWindow.js";
import { CONTEXT_MIN_TOKENS, contextView, resetContextOverride, setContextOverride } from "./contextSettings.js";

// Well under any real model's window, so the clamp never interferes with these numbers.
const SMALL = 60_000;
const BIGGER = 80_000;

async function fresh() {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "ctx-state-"));
  const cwd = mkdtempSync(join(tmpdir(), "ctx-proj-"));
  return createSession(cwd);
}

test("with no override, the view and the engine agree on Mindweave's own default", async () => {
  const s = await fresh();
  const view = await contextView(s);
  assert.equal(view.effective.source, "default");
  assert.equal(view.effective.tokens, autoCompactThreshold(s.modelConfig.model));
  assert.equal(effectiveAutoCompactThreshold(s), autoCompactThreshold(s.modelConfig.model));
});

test("a project override wins over global, and the live session sees it without a restart", async () => {
  const s = await fresh();
  assert.equal((await setContextOverride(s, "global", BIGGER)).ok, true);
  assert.equal((await setContextOverride(s, "project", SMALL)).ok, true);
  const view = await contextView(s);
  assert.equal(view.effective.source, "project");
  assert.equal(view.effective.tokens, SMALL);
  assert.equal(view.globalOverride, BIGGER);
  // The write path calls refreshGovernance itself, so the session's own compaction
  // bar — what maybeCompact actually decides on — has to already match, not just the view.
  assert.equal(effectiveAutoCompactThreshold(s), SMALL);
});

test("clearing the project override falls back to global, not straight to the default", async () => {
  const s = await fresh();
  await setContextOverride(s, "global", BIGGER);
  await setContextOverride(s, "project", SMALL);
  await resetContextOverride(s, "project");
  const view = await contextView(s);
  assert.equal(view.effective.source, "global");
  assert.equal(view.effective.tokens, BIGGER);
  assert.equal(effectiveAutoCompactThreshold(s), BIGGER);
});

test("a tiny value is clamped up to the floor rather than accepted as-is", async () => {
  const s = await fresh();
  assert.equal((await setContextOverride(s, "project", 1)).ok, true, "clamped, not refused");
  const view = await contextView(s);
  assert.equal(view.effective.tokens, CONTEXT_MIN_TOKENS);
});

test("zero or negative is refused outright — there is nothing sensible to clamp it to", async () => {
  const s = await fresh();
  assert.equal((await setContextOverride(s, "project", 0)).ok, false);
  assert.equal((await setContextOverride(s, "project", -5)).ok, false);
});

test("a huge value is clamped down to the model's real window, never above it", async () => {
  const s = await fresh();
  await setContextOverride(s, "project", 999_999_999);
  const view = await contextView(s);
  assert.equal(view.effective.tokens, view.recommendation.window);
});

test("a universal override reaches a different project too", async () => {
  const s = await fresh();
  await setContextOverride(s, "global", SMALL);
  const other = await createSession(mkdtempSync(join(tmpdir(), "ctx-other-")));
  assert.equal(effectiveAutoCompactThreshold(other), SMALL);
});
