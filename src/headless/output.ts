/**
 * output.ts — what a headless run prints, and the exit code it ends with (pure).
 *
 * Three formats, one rule: stdout is for the caller's program, stderr is for a person.
 *
 *  - text:        stdout holds the final answer and nothing else, so `mw -p ... > answer.md` and
 *                 `$(mw -p ...)` do what they look like they do. Progress goes to stderr.
 *  - json:        one object on stdout when the run ends. Progress still goes to stderr.
 *  - stream-json: one JSON object per line on stdout as things happen, ending with the same
 *                 result object json prints. Nothing on stderr: the stream carries it all.
 *
 * A script branches on the exit code, so "finished" (0) has to be tellable from "stopped half way" (4): a step
 * budget or a spent usage limit leaves work undone, and a run that reported success there would hide it.
 */
import type { TurnEvent } from "../core/turnRunner.js";
import type { PauseReason } from "../dynamo/engine.js";
import type { ModeId } from "../cli/modes.js";
import type { OutputFormat } from "./args.js";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_NO_KEY = 3;
export const EXIT_UNFINISHED = 4;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

/** An action that was refused because it needed an approval and nobody was there to give one. */
export interface Denial {
  tool: string;
  /** What it was about (a path or a command), when the call had one. */
  arg?: string;
}

export interface RunUsage {
  /** Fresh input plus output, each counted once. */
  billed_tokens: number;
  input_cached: number;
  input_fresh: number;
  output: number;
}

export interface RunFacts {
  sessionId: string;
  model: string;
  mode: ModeId;
  durationMs: number;
  /** The assistant's last message, which is the answer. */
  resultText: string;
  toolCalls: number;
  errors: string[];
  denials: Denial[];
  paused: PauseReason | null;
  signal: "SIGINT" | "SIGTERM" | null;
  usage: RunUsage;
  costUsd: number;
  costEstimated: boolean;
}

export type ResultSubtype = "success" | "error" | "paused" | "interrupted";

export interface ResultRecord {
  type: "result";
  subtype: ResultSubtype;
  is_error: boolean;
  result: string;
  session_id: string;
  model: string;
  mode: ModeId;
  duration_ms: number;
  tool_calls: number;
  usage: RunUsage;
  total_cost_usd: number;
  cost_estimated: boolean;
  permission_denials: Denial[];
  /** Why the run stopped before it was done; present only for paused and interrupted. */
  stop_reason?: string;
  errors: string[];
}

export function subtypeOf(f: RunFacts): ResultSubtype {
  if (f.signal) return "interrupted";
  if (f.errors.length > 0) return "error";
  if (f.paused) return "paused";
  return "success";
}

/** Why a run stopped unfinished, in words for a person reading a log. */
export function pauseWords(reason: PauseReason): string {
  switch (reason) {
    case "limit":
      return "a usage limit you set is used up";
    case "stepBudget":
      return "it used its step budget";
    case "costTimeLimit":
      return "it reached its cost or time ceiling";
    case "repeatedFailure":
      return "the same step kept failing";
    case "backgroundPoll":
      return "it was only waiting on a background command";
    case "reScope":
      return "the task grew past what was asked";
    case "truncated":
      return "the model hit its output limit mid-answer";
    case "refused":
      return "the provider declined the request";
    case "overflow":
      return "the conversation no longer fits the model's context window";
    case "overloaded":
      return "the provider cut the request off";
    default:
      return String(reason);
  }
}

export function exitCodeOf(f: RunFacts): number {
  switch (subtypeOf(f)) {
    case "interrupted":
      return f.signal === "SIGTERM" ? EXIT_SIGTERM : EXIT_SIGINT;
    case "error":
      return EXIT_FAILED;
    case "paused":
      return EXIT_UNFINISHED;
    default:
      return EXIT_OK;
  }
}

export function resultOf(f: RunFacts): ResultRecord {
  const subtype = subtypeOf(f);
  return {
    type: "result",
    subtype,
    is_error: subtype === "error" || subtype === "interrupted",
    result: f.resultText,
    session_id: f.sessionId,
    model: f.model,
    mode: f.mode,
    duration_ms: f.durationMs,
    tool_calls: f.toolCalls,
    usage: f.usage,
    total_cost_usd: roundUsd(f.costUsd),
    cost_estimated: f.costEstimated,
    permission_denials: f.denials,
    ...(f.signal ? { stop_reason: f.signal } : f.paused && subtype === "paused" ? { stop_reason: f.paused } : {}),
    errors: f.errors,
  };
}

function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** What the run writes for one event. Either or both of the streams may be empty. */
export interface Lines {
  stdout?: string;
  stderr?: string;
}

/** A tool call's label as one short line, the way the progress lines read. */
function toolLine(name: string, arg: string | undefined): string {
  const one = (arg ?? "").replace(/\s+/g, " ").trim();
  const clipped = one.length > 100 ? `${one.slice(0, 99)}…` : one;
  return `› ${name}${clipped ? ` ${clipped}` : ""}`;
}

/**
 * One engine event as output. `null` for the events that carry nothing a script wants
 * (reasoning text, live task lists, per-tool progress ticks, the done marker).
 */
export function linesFor(event: TurnEvent, format: OutputFormat, quiet: boolean): Lines | null {
  if (format === "stream-json") {
    const record = streamRecord(event);
    return record ? { stdout: JSON.stringify(record) + "\n" } : null;
  }
  // A failure is never hidden by --quiet: a script that asked for silence still has to be told why it stopped.
  if (event.type === "notice") return { stderr: `! ${event.title}: ${event.body}\n` };
  if (event.type === "error") return { stderr: `! ${event.text}\n` };
  if (quiet) return null;
  switch (event.type) {
    case "toolStart":
      return { stderr: toolLine(event.name, event.arg) + "\n" };
    case "toolEnd":
      return event.ok || event.quiet ? null : { stderr: `  ✗ ${event.summary}\n` };
    case "subagentStart":
      return { stderr: `› sub-agent ${event.task.replace(/\s+/g, " ").slice(0, 100)}\n` };
    case "activity":
      return { stderr: `${event.error ? "! " : ""}${event.line}\n` };
    default:
      return null;
  }
}

function streamRecord(e: TurnEvent): Record<string, unknown> | null {
  switch (e.type) {
    case "text":
      return { type: "text", delta: e.delta };
    case "replyReset":
      return { type: "reply_reset" };
    case "toolStart":
      return { type: "tool_start", id: e.id, tool: e.tool ?? e.name, label: e.name, ...(e.arg ? { arg: e.arg } : {}), ...(e.args ? { args: e.args } : {}) };
    case "toolEnd":
      return { type: "tool_end", id: e.id, ok: e.ok, summary: e.summary };
    case "subagentStart":
      return { type: "subagent_start", id: e.id, task: e.task };
    case "subagentEnd":
      return { type: "subagent_end", id: e.id, ok: e.ok, summary: e.summary };
    case "compaction":
      return { type: "compaction", before: e.before, after: e.after, window: e.window };
    case "activity":
      return { type: "activity", line: e.line, ...(e.error ? { error: true } : {}) };
    case "notice":
      return { type: "notice", title: e.title, body: e.body };
    case "error":
      return { type: "error", text: e.text };
    default:
      return null;
  }
}

/** The line the stream opens with: what is about to run. */
export function initRecord(f: { sessionId: string; model: string; mode: ModeId; cwd: string; resumed: boolean }): Record<string, unknown> {
  return { type: "init", session_id: f.sessionId, model: f.model, mode: f.mode, cwd: f.cwd, resumed: f.resumed };
}

/** The final bytes for stdout once the run is over. */
export function finalStdout(format: OutputFormat, facts: RunFacts): string {
  if (format === "text") return facts.resultText ? `${facts.resultText.replace(/\s+$/, "")}\n` : "";
  return JSON.stringify(resultOf(facts)) + "\n";
}
