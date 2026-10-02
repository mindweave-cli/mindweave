/**
 * sessionMemory.test.ts — the pure parts of session memory: the update trigger (token
 * growth gated), the injected block, and the budget bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  shouldUpdateSessionMemory,
  renderSessionMemory,
  boundSessionMemory,
  SESSION_MEMORY_TEMPLATE,
} from "./sessionMemory.js";
import { estimateTokens } from "./compaction.js";

const sessionMemorySource = readFileSync(fileURLToPath(new URL("./sessionMemory.ts", import.meta.url)), "utf8");

test("the notes writer loads ITS OWN model's driver before calling it", () => {
  // Same failure shape as dynamo/engine.ts's summarizeAndSplice (see its own test for
  // the full story): `activeDriver()` is a plain global, not scoped to this session, so
  // this background call has to (re-)load its own model's driver immediately before
  // using it rather than trust whatever a sub-agent left the global pointed at.
  const body = sessionMemorySource.match(/export async function updateSessionMemory\([\s\S]*?\n\}/)?.[0];
  assert.ok(body, "updateSessionMemory not found — did it move?");
  assert.match(
    body,
    /await ensureDriver\(model\.model\);[\s\S]{0,40}activeDriver\(\)/,
    "ensureDriver(model.model) must run immediately before activeDriver() is used",
  );
});

test("no update until the session warms past the init bar", () => {
  assert.equal(shouldUpdateSessionMemory(1_000, 0, false), false);
  assert.equal(shouldUpdateSessionMemory(4_000, 0, false), true);
});

test("the init bar is low enough that an ordinary session writes notes", () => {
  // The bar exists only so a two-message session doesn't pay for a model call. Set it
  // high and real work finishes un-noted, which is what made read_session fall back to
  // raw transcripts. A modest session must clear it.
  assert.equal(shouldUpdateSessionMemory(6_000, 0, false), true, "6K is a real session, it gets notes");
});

test("after init, updates only once growth crosses the update threshold", () => {
  assert.equal(shouldUpdateSessionMemory(15_000, 10_000, true), false, "5K growth is not enough");
  assert.equal(shouldUpdateSessionMemory(25_000, 10_000, true), true, "15K growth triggers");
});

test("renderSessionMemory wraps notes in a tagged block, and is empty when blank", () => {
  assert.equal(renderSessionMemory("   "), "");
  const block = renderSessionMemory("# Current State\nbuilding the sidebar");
  assert.match(block, /<session_memory>/);
  assert.match(block, /building the sidebar/);
  assert.match(block, /<\/session_memory>/);
});

test("boundSessionMemory leaves within-budget notes alone but trims oversize ones", () => {
  const small = "# Title\nx";
  assert.equal(boundSessionMemory(small, 10_000), small);
  const huge = "y".repeat(100_000);
  const bounded = boundSessionMemory(huge, 1_000);
  assert.ok(estimateTokens(bounded) <= 1_100, "trimmed near the cap");
  assert.match(bounded, /truncated/);
});

test("the template holds all the expected sections", () => {
  for (const s of [
    "# Session Title",
    "# Current State",
    "# Task specification",
    "# Files and Functions",
    "# Workflow",
    "# Errors & Corrections",
    "# Codebase and System Documentation",
    "# Learnings",
    "# Key results",
    "# Worklog",
  ]) {
    assert.ok(SESSION_MEMORY_TEMPLATE.includes(s), `template has ${s}`);
  }
});
