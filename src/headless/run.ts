/**
 * run.ts — one task, no screen (`mindweave -p "task"`).
 *
 * A thin client of the same front door the desktop app uses (core/turnRunner.ts): open a session,
 * run one turn, read what happened. The engine, the tools, the user's hooks, key failover, usage
 * limits, compaction and the saved session are all the ones an interactive run has, so nothing
 * here needs to be kept in step with them. What this file adds is only what a script needs:
 * where the prompt comes from, which stream gets what, and an exit code that means something.
 *
 * Everything that touches the process (stdin, signals, exiting) is injected, so the whole flow
 * runs inside a test against a scripted provider. `main.ts` is the one place that wires the real ones.
 *
 * Nobody is there to answer a question. No approval channel is attached, which is the same state a
 * sub-agent runs in: Sentinel's gate says there is nobody to ask, `ask_user` tells the model to use
 * its best judgment, and writes outside the workspace are refused. That is what makes the mode safe to
 * leave unattended, and it needs no mode of its own.
 */
import { applySessionMode, disposeSession, prepareMessage, runTurn, sessionMode, type TurnEvent } from "../core/turnRunner.js";
import { defaultModeFor } from "../core/permissions.js";
import { createSession, resumeSession } from "../memory/session.js";
import type { Session } from "../memory/types.js";
import { hasApiKey } from "../cli/bootstrap.js";
import { DEFAULT_MODE } from "../cli/modes.js";
import { rootBreadth } from "../cli/trust.js";
import { allProviders, manifestForModel, modelsOf } from "../drivers/registry.js";
import { usableFallback, withModel } from "../dynamo/model.js";
import type { PauseReason } from "../dynamo/engine.js";
import type { HeadlessOptions } from "./args.js";
import {
  EXIT_FAILED,
  EXIT_NO_KEY,
  EXIT_USAGE,
  exitCodeOf,
  finalStdout,
  initRecord,
  linesFor,
  pauseWords,
  subtypeOf,
  type Denial,
  type RunFacts,
} from "./output.js";

/** Piped context larger than this is refused, not silently cut: a half-read diff gives a confident wrong review. */
export const MAX_STDIN_BYTES = 2 * 1024 * 1024;

/** What an unattended run adds to the system prompt. The contract only: nobody answers, so finish, and report in full. */
export const UNATTENDED_NOTE =
  "This run is unattended: no one is watching and no one can answer. Never end with a question or an offer such as " +
  '"want me to...?". Where something is ambiguous, choose the most reasonable option, say which you chose, and finish ' +
  "the work. Stop early only for a decision that only the user can make, and then say exactly what you need. Your " +
  "final reply is read later by a script or a person, so make it a complete report of what you did and found.";

export interface Writer {
  write(text: string): unknown;
}

export interface HeadlessIO {
  stdout: Writer;
  stderr: Writer;
  /** Everything piped to stdin; null when stdin is a terminal or empty. */
  stdin: string | null;
  /** stdin held more than MAX_STDIN_BYTES. */
  stdinTooBig?: boolean;
}

export interface HeadlessContext {
  /** The folder the run is rooted in. */
  cwd: string;
  /** Aborted by SIGINT / SIGTERM; the turn stops and the session is saved. */
  signal?: AbortSignal;
  /** Which signal fired, once `signal` is aborted. */
  firedSignal?: () => "SIGINT" | "SIGTERM" | null;
}

export async function runHeadless(options: HeadlessOptions, io: HeadlessIO, ctx: HeadlessContext): Promise<number> {
  const started = Date.now();
  const say = (text: string) => void io.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  const usage = (text: string) => {
    say(`mindweave: ${text}`);
    return EXIT_USAGE;
  };

  // A script gets a folder it named, never a whole machine by accident. The interactive app asks about
  // this once per folder; here there is nobody to ask, so the broad cases are refused.
  const breadth = rootBreadth(ctx.cwd);
  if (breadth !== "ordinary") {
    return usage(`refusing to work in ${breadth === "home" ? "your home folder" : "a drive root"}. Run it from inside a project folder.`);
  }
  if (io.stdinTooBig) {
    return usage(`the piped input is larger than ${MAX_STDIN_BYTES / (1024 * 1024)} MB. Write it to a file in the project and name the file in the task.`);
  }
  const argText = options.prompt?.trim() ?? "";
  const piped = io.stdin && io.stdin.trim() ? io.stdin : "";
  if (!argText && !piped) {
    return usage('nothing to do. Give a task: mindweave -p "what to do", or pipe it in.');
  }

  let session: Session | null = null;
  try {
    const resumed = options.resumeId !== undefined || options.continueLast;
    session = resumed ? await resumeSession(ctx.cwd, options.resumeId) : await createSession(ctx.cwd);
    if (!session) {
      return usage(options.resumeId ? `no saved session '${options.resumeId}' in this folder.` : "no earlier session in this folder to continue.");
    }

    // The model: what this project already uses, exactly as the interactive app starts. --model changes it
    // for this run only (setSessionModel would save it). Its key being missing is then an error, not a quiet swap.
    if (options.model) {
      if (!isKnownModel(options.model)) return usage(`unknown model '${options.model}'. /model in a session lists them.`);
      session.modelConfig = withModel(session.modelConfig, options.model);
    }
    const manifest = manifestForModel(session.modelConfig.model);
    if (!manifest.local && !hasApiKey(manifest.apiKeyEnv)) {
      const other = options.model ? null : usableFallback(session.modelConfig.model, hasApiKey);
      if (!other) {
        say(`mindweave: no API key for ${manifest.label}. Set ${manifest.apiKeyEnv} in ~/.mindweave/.env or the environment (keys: ${manifest.keysUrl}).`);
        return EXIT_NO_KEY;
      }
      session.modelConfig = withModel(session.modelConfig, other);
      say(`no ${manifest.label} key, using ${manifestForModel(other).label} instead.`);
    }

    // Lightning by default: the work is done directly, as it is interactively. A project can set its own default.
    const mode = options.mode ?? (await defaultModeFor(ctx.cwd)) ?? DEFAULT_MODE;
    applySessionMode(session, mode);
    // Tells the model what the code already enforces, so it finishes instead of ending on "want me to...?", which
    // in a script is a dead end. Carried at the end of the system prompt: cached, and absent from an interactive run.
    session.toolContext.agentPrompt = UNATTENDED_NOTE;

    const facts: RunFacts = {
      sessionId: session.id,
      model: session.modelConfig.model,
      mode: sessionMode(session),
      durationMs: 0,
      resultText: "",
      toolCalls: 0,
      errors: [],
      denials: [],
      paused: null,
      signal: null,
      usage: { billed_tokens: 0, input_cached: 0, input_fresh: 0, output: 0 },
      costUsd: 0,
      costEstimated: false,
    };

    const format = options.format;
    const calls = new Map<string, { name: string; arg?: string }>();
    const write = (e: TurnEvent) => {
      const aborted = ctx.signal?.aborted === true;
      if (e.type === "toolStart") {
        facts.toolCalls++;
        calls.set(e.id, { name: e.tool ?? e.name, ...(e.arg ? { arg: e.arg } : {}) });
      } else if (e.type === "toolEnd" && !e.ok && /^declined /.test(e.summary)) {
        const c = calls.get(e.id);
        const denial: Denial = { tool: c?.name ?? "unknown", ...(c?.arg ? { arg: c.arg } : {}) };
        facts.denials.push(denial);
      } else if (!aborted && (e.type === "error" || e.type === "notice")) {
        // reportFailure speaks in a notice for a refusal or an outage and an error for the rest; both end the run.
        facts.errors.push(e.type === "error" ? e.text : `${e.title}: ${e.body}`);
      }
      const lines = aborted && (e.type === "error" || e.type === "notice") ? null : linesFor(e, format, options.quiet);
      if (lines?.stdout) io.stdout.write(lines.stdout);
      if (lines?.stderr) io.stderr.write(lines.stderr);
    };

    if (format === "stream-json") {
      io.stdout.write(JSON.stringify(initRecord({ sessionId: session.id, model: facts.model, mode: facts.mode, cwd: session.cwd, resumed })) + "\n");
    }

    // What the model is given. Typed words go through the same attachment rules as the interactive prompt (a path
    // in quotes attaches the file). Piped text never does: it is data, and a path inside it is not the user's request.
    let content: string;
    let images: Awaited<ReturnType<typeof prepareMessage>>["images"] = [];
    if (argText) {
      const prepared = await prepareMessage(session, { text: argText, ...(piped ? { pastes: [piped] } : {}) }, write);
      content = prepared.content;
      images = prepared.images;
    } else {
      content = piped;
    }

    const before = { ...(session.spend ?? { billed: 0, cacheHit: 0, cacheMiss: 0, output: 0, costUsd: 0 }) };
    const startLen = session.transcript.length;

    await runTurn(session, { content, images }, {
      onEvent: write,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onPause: (reason: PauseReason) => {
        facts.paused = reason;
      },
    });

    facts.signal = ctx.signal?.aborted ? (ctx.firedSignal?.() ?? "SIGINT") : null;
    facts.durationMs = Date.now() - started;
    facts.resultText = lastAnswer(session, startLen);
    const after = session.spend;
    if (after) {
      facts.usage = {
        billed_tokens: after.billed - before.billed,
        input_cached: after.cacheHit - before.cacheHit,
        input_fresh: after.cacheMiss - before.cacheMiss,
        output: after.output - before.output,
      };
      facts.costUsd = after.costUsd - before.costUsd;
      facts.costEstimated = after.estimated;
    }

    if (subtypeOf(facts) === "paused" && format !== "stream-json") {
      say(`! stopped before it was done: ${pauseWords(facts.paused!)}. Carry on with --continue.`);
    }
    io.stdout.write(finalStdout(format, facts));
    return exitCodeOf(facts);
  } catch (error) {
    say(`mindweave: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  } finally {
    if (session) await disposeSession(session).catch(() => {});
  }
}

/** The assistant's last words this run, which is the answer. */
function lastAnswer(session: Session, from: number): string {
  for (let i = session.transcript.length - 1; i >= from; i--) {
    const entry = session.transcript[i]!;
    if (entry.role === "assistant" && typeof entry.content === "string" && entry.content.trim()) return entry.content.trim();
  }
  return "";
}

function isKnownModel(model: string): boolean {
  return allProviders().some((p) => modelsOf(p).some((m) => m.id === model) || p.ownsModel?.(model) === true);
}
