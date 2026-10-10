/**
 * sessionMemory.test.ts — the pure parts of session memory: when a refresh is due (growth
 * and work, mid-turn or at a break), what counts as a usable rewrite, and the budget bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  shouldUpdateSessionMemory,
  sessionMemoryDue,
  toolCallsSince,
  notesAreUsable,
  boundSessionMemory,
  SESSION_MEMORY_TEMPLATE,
} from "./sessionMemory.js";
import type { Entry, Session } from "./types.js";
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

test("after init, nothing happens until the work has grown enough", () => {
  assert.equal(shouldUpdateSessionMemory(8_000, 5_000, true), false, "3K growth is not enough");
  assert.equal(shouldUpdateSessionMemory(12_000, 5_000, true), true, "7K growth at a break triggers");
});

test("in the middle of a turn, growth alone is not enough: real work has to have happened", () => {
  // Three large reads grow the transcript without anything worth writing down yet.
  assert.equal(shouldUpdateSessionMemory(20_000, 5_000, true, 1, false), false);
  assert.equal(shouldUpdateSessionMemory(20_000, 5_000, true, 3, false), true, "three tool calls plus growth");
  // Work without growth never triggers, mid-turn or not.
  assert.equal(shouldUpdateSessionMemory(6_000, 5_000, true, 30, false), false);
  assert.equal(shouldUpdateSessionMemory(6_000, 5_000, true, 30, true), false);
});

test("tool calls are counted from the point the notes last covered", () => {
  const call = (n: number): Entry => ({ role: "assistant", content: "", toolCalls: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: "read_file", arguments: "{}" })) });
  const transcript: Entry[] = [call(2), { role: "user", content: "x" }, call(1), call(3)];
  assert.equal(toolCallsSince(transcript, 0), 6);
  assert.equal(toolCallsSince(transcript, 2), 4);
  assert.equal(toolCallsSince(transcript, 99), 0);
});

test("a session is due once growth and work both say so, and only then mid-turn", () => {
  const big = (n: number): Entry => ({ role: "tool", toolCallId: "t", content: "x".repeat(n) });
  const call = (): Entry => ({ role: "assistant", content: "", toolCalls: [{ id: "c", name: "read_file", arguments: "{}" }] });
  const s = {
    transcript: [{ role: "user", content: "go" }, call(), big(30_000), call(), big(30_000), call(), big(30_000)] as Entry[],
    sessionMemoryInit: true,
    sessionMemoryTokens: 0,
    sessionMemoryEntries: 0,
  } as unknown as Session;
  assert.equal(sessionMemoryDue(s, false), true, "three calls and plenty of growth");
  (s as { sessionMemoryEntries: number }).sessionMemoryEntries = 6;
  assert.equal(sessionMemoryDue(s, false), false, "only one call since the notes' boundary");
  assert.equal(sessionMemoryDue(s, true), true, "but at a break, the growth is enough");
});

test("a rewrite is used only if it is still a whole notes document", () => {
  const good = SESSION_MEMORY_TEMPLATE + "\nthe parser is half rewritten";
  assert.equal(notesAreUsable(undefined, good), true);
  assert.equal(notesAreUsable(undefined, ""), false, "nothing");
  assert.equal(notesAreUsable(undefined, SESSION_MEMORY_TEMPLATE), false, "the skeleton with nothing in it");
  assert.equal(notesAreUsable(undefined, "I cannot help with that."), false, "a refusal");
  assert.equal(notesAreUsable(undefined, good.replace("# Worklog", "")), false, "a section went missing");
  const long = SESSION_MEMORY_TEMPLATE + "\n" + "a detailed line about the work\n".repeat(120);
  assert.equal(notesAreUsable(long, good), false, "a long record collapsed to almost nothing");
  assert.equal(notesAreUsable(long, long.replace("a detailed line", "another line")), true);
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
