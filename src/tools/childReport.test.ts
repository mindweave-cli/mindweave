/**
 * childReport.test.ts — a sub-agent that ran out of steps still says what it found.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_REPORT, WRAP_UP, isPausedReply, lastSaid, reportOf } from "./childReport.js";
import { verifierOutcome } from "./subagentOutcome.js";
import type { Session } from "../memory/types.js";

const PAUSE = "(Paused — reached the step budget of 30 tool steps in one turn. The task isn't finished, but nothing is lost: your progress, edits, and task list are saved. Say \"continue\" to pick up exactly where I left off.)";

function child(said: string[] = []): Session {
  return { toolContext: {}, transcript: said.map((content) => ({ role: "assistant", content })) } as unknown as Session;
}

test("the engine's pause note is told from anything a child said", () => {
  assert.equal(isPausedReply(PAUSE), true);
  assert.equal(isPausedReply(`  ${PAUSE}`), true);
  assert.equal(isPausedReply("Found it. STATUS: complete"), false);
  assert.equal(isPausedReply("It said (Paused later"), false);
});

test("the last thing a child said in words is what is used when it cannot report", () => {
  assert.equal(lastSaid(child(["first", "", "the second thing", PAUSE])), "the second thing");
  assert.equal(lastSaid(child([])), "");
});

test("a child that finished on its own is left alone, and its tools are never touched", async () => {
  const c = child();
  let ran = false;
  const r = await reportOf(c, "All done. STATUS: complete", async () => ((ran = true), "x"));
  assert.deepEqual(r, { reply: "All done. STATUS: complete", exhausted: false });
  assert.equal(ran, false);
  assert.equal(c.toolContext.noTools, undefined);
});

test("a child out of steps is asked, with no tools, for what it found, and its words are the reply", async () => {
  const c = child(["reading the files"]);
  let sawNoTools: boolean | undefined;
  const r = await reportOf(c, PAUSE, async (ch) => {
    sawNoTools = ch.toolContext.noTools;
    return "Checked 3 of 8. Not done: the menu. STATUS: partial";
  });
  assert.equal(sawNoTools, true, "its tools are off for that turn");
  assert.equal(c.toolContext.noTools, false, "and back after it");
  assert.deepEqual(r, { reply: "Checked 3 of 8. Not done: the menu. STATUS: partial", exhausted: true });
  const asked = c.transcript.at(-1)!;
  assert.ok(asked.role === "user" && asked.content === WRAP_UP && asked.synthetic, "the request is on its record, marked as ours");
});

test("if it cannot report, what it said while it worked is used, then a plain note for the parent", async () => {
  const said = await reportOf(child(["Partial: found two callers."]), PAUSE, async () => PAUSE);
  assert.deepEqual(said, { reply: "Partial: found two callers.", exhausted: true });
  const failed = await reportOf(child([]), PAUSE, async () => {
    throw new Error("the provider fell over");
  });
  assert.deepEqual(failed, { reply: NO_REPORT, exhausted: true });
  assert.doesNotMatch(NO_REPORT, /continue/i, "the parent is not told to say 'continue'");
});

test("a verifier that ran out of steps says so, instead of 'no verdict'", () => {
  assert.deepEqual(verifierOutcome("unstated", 0, true), { headline: "Stopped at its step limit · 0 checks", verdict: "partial" });
  assert.deepEqual(verifierOutcome("partial", 3, true), { headline: "Stopped at its step limit · 3 checks", verdict: "partial" });
  assert.equal(verifierOutcome("fail", 3, true).verdict, "fail", "a failure it found is still a failure");
  assert.equal(verifierOutcome("pass", 3, true).verdict, "pass");
  assert.deepEqual(verifierOutcome("unstated", 0), { headline: "No verdict", verdict: "unknown" });
});
