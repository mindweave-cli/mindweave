/**
 * output.test.ts — what a headless run prints and how it exits.
 *
 * The contract scripts depend on: stdout carries only what a program should read, stderr carries
 * what a person should, and the exit code separates "done" from "stopped half way".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_SIGINT,
  EXIT_SIGTERM,
  EXIT_UNFINISHED,
  exitCodeOf,
  finalStdout,
  initRecord,
  linesFor,
  pauseWords,
  resultOf,
  subtypeOf,
  type Lines,
  type RunFacts,
} from "./output.js";
import type { TurnEvent } from "../core/turnRunner.js";

function facts(over: Partial<RunFacts> = {}): RunFacts {
  return {
    sessionId: "s1",
    model: "gemini-3.7-flash",
    mode: "lightning",
    durationMs: 1234,
    resultText: "All done.",
    toolCalls: 2,
    errors: [],
    denials: [],
    paused: null,
    signal: null,
    usage: { billed_tokens: 110, input_cached: 0, input_fresh: 100, output: 10 },
    costUsd: 0.0012345678,
    costEstimated: true,
    ...over,
  };
}

const toolStart: TurnEvent = { type: "toolStart", id: "t1", name: "Read", arg: "src/a.ts", kind: "read", group: false, tool: "read_file" };

// ── exit codes ───────────────────────────────────────────────────────────────

test("finished is 0; a failed run is 1; stopped unfinished is 4; a signal keeps its conventional code", () => {
  assert.equal(exitCodeOf(facts()), EXIT_OK);
  assert.equal(exitCodeOf(facts({ errors: ["boom"] })), EXIT_FAILED);
  assert.equal(exitCodeOf(facts({ paused: "stepBudget" })), EXIT_UNFINISHED);
  assert.equal(exitCodeOf(facts({ signal: "SIGINT" })), EXIT_SIGINT);
  assert.equal(exitCodeOf(facts({ signal: "SIGTERM" })), EXIT_SIGTERM);
});

test("a failure outranks a pause, and a signal outranks both", () => {
  assert.equal(subtypeOf(facts({ errors: ["x"], paused: "limit" })), "error");
  assert.equal(subtypeOf(facts({ errors: ["x"], paused: "limit", signal: "SIGTERM" })), "interrupted");
});

// ── the result object ────────────────────────────────────────────────────────

test("the result object carries the answer, the session, the cost and the way it ended", () => {
  const r = resultOf(facts());
  assert.equal(r.type, "result");
  assert.equal(r.subtype, "success");
  assert.equal(r.is_error, false);
  assert.equal(r.result, "All done.");
  assert.equal(r.session_id, "s1");
  assert.equal(r.total_cost_usd, 0.001235, "rounded to a millionth of a dollar");
  assert.equal(r.cost_estimated, true);
  assert.equal(r.stop_reason, undefined, "a finished run has no stop reason");
});

test("a paused run says why; an interrupted run names the signal; an error lists its errors", () => {
  const p = resultOf(facts({ paused: "stepBudget" }));
  assert.equal(p.subtype, "paused");
  assert.equal(p.is_error, false, "stopping unfinished is not a failure, but the exit code is not 0");
  assert.equal(p.stop_reason, "stepBudget");
  assert.equal(resultOf(facts({ signal: "SIGTERM" })).stop_reason, "SIGTERM");
  const e = resultOf(facts({ errors: ["provider returned 500"] }));
  assert.equal(e.is_error, true);
  assert.deepEqual(e.errors, ["provider returned 500"]);
});

test("every pause reason has words a person can read in a log", () => {
  for (const r of ["limit", "stepBudget", "costTimeLimit", "repeatedFailure", "backgroundPoll", "reScope", "truncated", "refused", "overflow", "overloaded"] as const) {
    assert.match(pauseWords(r), /\w{4}/);
  }
});

// ── what goes where ──────────────────────────────────────────────────────────

test("text mode: the final stdout is the answer and a newline, nothing else", () => {
  assert.equal(finalStdout("text", facts({ resultText: "  Fixed it.\n\n" })), "  Fixed it.\n");
  assert.equal(finalStdout("text", facts({ resultText: "" })), "", "no answer, no output: a script sees an empty string");
});

test("json mode: exactly one line of valid JSON", () => {
  const out = finalStdout("json", facts());
  assert.equal(out.endsWith("\n"), true);
  assert.equal(out.trim().split("\n").length, 1);
  assert.equal(JSON.parse(out).result, "All done.");
});

test("text and json: tool calls are one short line each on stderr, never on stdout", () => {
  for (const fmt of ["text", "json"] as const) {
    const l: Lines = linesFor(toolStart, fmt, false)!;
    assert.equal(l.stdout, undefined);
    assert.equal(l.stderr, "› Read src/a.ts\n");
  }
});

test("a long tool argument is cut to one line", () => {
  const l = linesFor({ ...toolStart, arg: "a\nb ".repeat(80) } as TurnEvent, "text", false)!;
  assert.equal(l.stderr!.trimEnd().split("\n").length, 1);
  assert.ok(l.stderr!.length < 130);
});

test("--quiet hides progress but never a failure", () => {
  assert.equal(linesFor(toolStart, "text", true), null);
  assert.equal(linesFor({ type: "activity", line: "compacting" }, "text", true), null);
  assert.equal(linesFor({ type: "error", text: "boom" }, "text", true)!.stderr, "! boom\n");
  assert.equal(linesFor({ type: "notice", title: "Out of credit", body: "top up" }, "json", true)!.stderr, "! Out of credit: top up\n");
});

test("a failed tool is shown on stderr; a quiet or successful one is not", () => {
  assert.equal(linesFor({ type: "toolEnd", id: "t1", ok: false, summary: "no such file" }, "text", false)!.stderr, "  ✗ no such file\n");
  assert.equal(linesFor({ type: "toolEnd", id: "t1", ok: true, summary: "read 40 lines" }, "text", false), null);
});

test("stream-json: everything goes to stdout as one JSON object per line, and nothing to stderr", () => {
  const events: TurnEvent[] = [
    { type: "text", delta: "Hel" },
    toolStart,
    { type: "toolEnd", id: "t1", ok: true, summary: "read" },
    { type: "error", text: "boom" },
    { type: "notice", title: "T", body: "B" },
  ];
  const types = events.map((e) => {
    const l = linesFor(e, "stream-json", true)!;
    assert.equal(l.stderr, undefined);
    assert.equal(l.stdout!.endsWith("\n"), true);
    return JSON.parse(l.stdout!).type;
  });
  assert.deepEqual(types, ["text", "tool_start", "tool_end", "error", "notice"]);
});

test("events a program has no use for are dropped from the stream", () => {
  for (const e of [{ type: "reasoning", delta: "hmm" }, { type: "done" }, { type: "usage", promptTokens: 1, completionTokens: 1, totalTokens: 2 }, { type: "toolProgress", id: "t", text: "x" }] as TurnEvent[]) {
    assert.equal(linesFor(e, "stream-json", false), null, e.type);
  }
});

test("the stream opens with an init record naming the session, model and mode", () => {
  const r = initRecord({ sessionId: "s1", model: "m", mode: "architect", cwd: "/p", resumed: false });
  assert.deepEqual(r, { type: "init", session_id: "s1", model: "m", mode: "architect", cwd: "/p", resumed: false });
});
