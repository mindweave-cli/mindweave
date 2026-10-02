/**
 * marathon.ts — goal-mode autonomy.
 *
 * Give it an objective; it keeps running turns across the session's normal
 * step-ceiling pauses — auto-resuming instead of waiting for the user to say
 * "continue" — until one of exactly three things is true: the goal is VERIFIED
 * done, it hits a wall only the user can get it past, or it runs out of budget.
 * A fourth, mechanical stop (genuinely stuck) exists so an unattended run can
 * never spiral the way the AutoGPT/BabyAGI generation of agents did.
 *
 * DELIBERATELY NOT A MODE. Lightning/Architect/Sentinel decide approval — whether
 * a tool call needs asking about. Marathon decides whether the LOOP keeps going
 * once a turn pauses. The two are orthogonal by design (the user's explicit call):
 * Marathon orchestrates ordinary `respond()` turns on whichever mode is already
 * active, and never touches approval itself. Running it under Sentinel means it
 * really will stop and ask, same as any other turn would — that's a property of
 * the mode the user chose, not something Marathon overrides.
 *
 * WHY THIS SHAPE: an unattended loop needs a small, fixed set of ways to end
 * (verified / blocked / budget, plus stuck), and two things decide whether it
 * can be trusted:
 *
 *   1. Verification must be a STRUCTURALLY SEPARATE check, never the worker's own
 *      say-so: a fresh model decides whether the goal is done, not the one that
 *      did the work. Mindweave already has exactly this primitive:
 *      `spawn_subagent`'s `verify:true` path, whose whole point is that an
 *      unevidenced "pass" is downgraded, not trusted (`tools/verifyReport.ts`).
 *      This module reuses it as-is via `forkSession` — no second verification
 *      mechanism is invented.
 *   2. Stuck detection needs concrete, numeric thresholds, not vibes (4+ identical
 *      action→result, 3+ identical action→error, 3+ no-progress turns, 6+
 *      alternating ping-pong), see `detectStuck` below. They are directly
 *      checkable against a transcript Mindweave already has in full.
 *
 * Everything else needed already existed and is reused, not rebuilt: the step
 * ceiling and clean-pause-with-intact-state mechanic (`engine.ts`'s `pauseTask`
 * family — Marathon's real job is auto-resuming across it), compaction for
 * context pressure (session notes + MINDWEAVE.md are the external memory, not
 * everything in context), and `pricing.ts`'s `taskLimitReason`/`TaskLimits`
 * for the budget axis (per-run cost tracking is not optional for an unattended
 * run — reused rather than a second cost mechanism).
 *
 * It depends only on `Session` + `respond()`, exactly like every other
 * engine-level primitive both front ends share through `core/turnRunner.ts`, and
 * nothing here assumes which one is calling it.
 */
import type { Entry, Session } from "../memory/types.js";
import type { Usage } from "../drivers/types.js";
import type { TodoItem } from "../tools/types.js";
import type { ImageRef } from "../memory/images.js";
import { forkSession } from "../memory/session.js";
import { respond, type PauseReason, type RespondOptions } from "./engine.js";
import { summarizeTask, taskLimitReason, type TaskLimits } from "./pricing.js";
import { VERIFIER_PROMPT, VERDICT_INSTRUCTION, parseVerdict, type VerdictReport } from "../tools/verifyReport.js";

/** How many consecutive non-passing verifications before Marathon gives up and
 *  hands back to the user, rather than retry the same goal forever. Same shape as
 *  `engine.ts`'s own `MAX_COMPACT_FAILURES` circuit breaker — a small, named
 *  constant, not a magic number buried in a condition. */
export const MAX_MARATHON_VERIFY_FAILS = 10;

/** Tool-round budget for the verification sub-agent. Generous on purpose: proving
 *  a goal is really done can mean running a build, a full test suite, AND trying
 *  to break the result — the same adversarial bar `verify:true` always sets. */
const VERIFY_BUDGET = 40;

/** How many recent transcript entries `runMarathon` hands to `detectStuck` after
 *  every turn. Generous enough to contain the longest pattern it looks for (the
 *  6-step ping-pong) with room either side; cheap since it's a slice, not a scan
 *  of the whole session. */
const STUCK_WINDOW = 40;

/** Default wait before retrying after a `backgroundPoll` pause — nothing changed,
 *  so there is no reason to spin immediately; not so long that a quick shell makes
 *  the whole run feel stalled. */
const DEFAULT_BACKGROUND_POLL_WAIT_MS = 5_000;

export type MarathonStatus = "running" | "done" | "blocked" | "stuck" | "budgetExceeded";

/** Everything Marathon needs to remember about one goal, and the only thing
 *  persisted (`SessionMeta.marathon` — see memory/store.ts and memory/session.ts)
 *  so a goal survives a restart instead of silently vanishing mid-run. */
export interface MarathonState {
  goal: string;
  startedAt: number;
  /** respond() calls run toward this goal — a fresh send plus every auto-resume. */
  turnsSpent: number;
  /** Of those, how many were auto-resumed across a pause rather than a fresh start. */
  resumes: number;
  /** Verification attempts in a row that did NOT come back a clean pass. Reset to
   *  0 the moment one does. */
  consecutiveVerifyFails: number;
  status: MarathonStatus;
  /** The goal message is already in the transcript. A run stopped in its opening turn then
   *  picks up from there when resumed, instead of planning (and asking questions) again. */
  goalSent?: boolean;
  /** Set once `status` leaves "running" — why, in plain words, for whoever reads
   *  this state back (a UI, a log, the user). */
  outcome?: string;
  lastVerification?: { at: number; verdict: VerdictReport["verdict"]; note: string };
  /** The model's task list as of its last rewrite, kept so a front end reopening a
   *  resumed run can draw the checklist before the model has rewritten it. */
  todos?: TodoItem[];
}

/** A fresh Marathon over `goal`, not yet run. */
export function initMarathon(goal: string): MarathonState {
  return { goal, startedAt: Date.now(), turnsSpent: 0, resumes: 0, consecutiveVerifyFails: 0, status: "running" };
}

// ---------------------------------------------------------------------------
// Stuck detection (pure) — fixed numeric thresholds, checked directly against
// Mindweave's full transcript.
// ---------------------------------------------------------------------------

const SAME_RESULT_LIMIT = 4; // identical action -> identical observation, repeated
const SAME_ERROR_LIMIT = 3; // identical action -> an error, repeated
const NO_PROGRESS_LIMIT = 3; // consecutive assistant turns with no tool call at all
const PING_PONG_LIMIT = 6; // A,B,A,B,... alternating between the same two actions

export interface StuckCheck {
  stuck: boolean;
  /** Plain-language reason, present exactly when `stuck` is true. */
  reason?: string;
}

/** Tools whose repeated, identical answer is what WAITING looks like rather than being
 *  stuck: polling a running background command returns the same "still running" until
 *  it isn't. Left in, a two-minute build would trip the same-result rule in seconds. */
const WAIT_TOOLS = new Set(["shells"]);

interface ToolStep {
  /** A stable fingerprint of the CALL (name + arguments) — two calls are "the
   *  same action" if this matches, whatever came back. Not the result: that's
   *  compared separately, because "same action, same result" and "same action,
   *  different result" mean opposite things here. */
  sig: string;
  result: string;
  isError: boolean;
}

/** Pair every tool result with the call that produced it, in transcript order. A
 *  result with no matching call (shouldn't happen, but a resumed/edited session
 *  is not something to trust blindly) is simply skipped rather than crashing. */
function toolSteps(entries: readonly Entry[]): ToolStep[] {
  const calls = new Map<string, string>(); // call id -> signature
  const steps: ToolStep[] = [];
  for (const e of entries) {
    if (e.role === "assistant") {
      for (const call of e.toolCalls ?? []) {
        if (!WAIT_TOOLS.has(call.name)) calls.set(call.id, `${call.name}:${call.arguments}`);
      }
    } else if (e.role === "tool") {
      const sig = calls.get(e.toolCallId);
      if (sig !== undefined) steps.push({ sig, result: e.content, isError: e.isError === true });
    }
  }
  return steps;
}

/**
 * Is the tail of this transcript a genuinely stuck loop, not just ordinary work?
 * Pure — takes whatever slice the caller hands it (`runMarathon` passes the most
 * recent `STUCK_WINDOW` entries), so it's fully testable with hand-built fixtures.
 *
 * Checked in this order because they're independent failure shapes, not a
 * priority ranking — the first one that matches is reported, since one honest
 * reason is more useful than a list of everything that happened to also be true.
 */
export function detectStuck(recent: readonly Entry[]): StuckCheck {
  const steps = toolSteps(recent);

  const lastSame = steps.slice(-SAME_RESULT_LIMIT);
  if (lastSame.length === SAME_RESULT_LIMIT && lastSame.every((s) => s.sig === lastSame[0]!.sig && s.result === lastSame[0]!.result)) {
    return { stuck: true, reason: `the same action produced the exact same result ${SAME_RESULT_LIMIT} times in a row` };
  }

  const lastError = steps.slice(-SAME_ERROR_LIMIT);
  if (lastError.length === SAME_ERROR_LIMIT && lastError.every((s) => s.sig === lastError[0]!.sig && s.isError)) {
    return { stuck: true, reason: `the same action failed the same way ${SAME_ERROR_LIMIT} times in a row` };
  }

  const assistantEntries = recent.filter((e) => e.role === "assistant");
  const lastAssistant = assistantEntries.slice(-NO_PROGRESS_LIMIT);
  if (
    lastAssistant.length === NO_PROGRESS_LIMIT &&
    lastAssistant.every((e) => e.role === "assistant" && (!e.toolCalls || e.toolCalls.length === 0))
  ) {
    return { stuck: true, reason: `${NO_PROGRESS_LIMIT} messages in a row with no action taken` };
  }

  const lastPingPong = steps.slice(-PING_PONG_LIMIT);
  if (lastPingPong.length === PING_PONG_LIMIT) {
    const [a, b] = [lastPingPong[0]!.sig, lastPingPong[1]!.sig];
    if (a !== b && lastPingPong.every((s, i) => s.sig === (i % 2 === 0 ? a : b))) {
      return { stuck: true, reason: `alternating between the same two actions with no progress` };
    }
  }

  return { stuck: false };
}

// ---------------------------------------------------------------------------
// The decision (pure) — everything `runMarathon` learns after one turn, turned
// into exactly one of: keep going unattended, check if that's really done,
// wait, or stop (and why). This is where almost all of Marathon's correctness
// lives, which is exactly why it's a plain function over plain data rather than
// buried in the orchestrator's control flow.
// ---------------------------------------------------------------------------

export type MarathonDecision =
  | { action: "resume" }
  | { action: "verify" }
  | { action: "wait" }
  | { action: "stop"; status: Exclude<MarathonStatus, "running">; reason: string };

export interface MarathonDecisionInputs {
  /** What `respond()`'s `onPause` reported for the turn that just ended, or null
   *  when the turn simply finished on its own (which is itself a "looks done"
   *  signal — the model stopped talking — so it goes through verification too,
   *  same as an explicit re-scope pause). */
  pauseReason: PauseReason | null;
  stuck: StuckCheck;
  /** `taskLimitReason`'s own string when the goal's own cost/time ceiling has
   *  been hit, else null. Absent ceiling (no `limits` passed to `runMarathon`)
   *  means this is always null — no budget check runs at all, same as an
   *  interactive turn's "no ceiling unless asked" default. */
  budgetExceeded: string | null;
}

/**
 * The whole state machine, in one place. Order matters: budget and stuck are
 * checked FIRST and unconditionally, because both mean "stop no matter what the
 * turn itself claimed" — a turn that happens to also look done while the goal is
 * over budget is still over budget.
 */
export function decide(inputs: MarathonDecisionInputs): MarathonDecision {
  if (inputs.budgetExceeded) return { action: "stop", status: "budgetExceeded", reason: inputs.budgetExceeded };
  if (inputs.stuck.stuck) return { action: "stop", status: "stuck", reason: inputs.stuck.reason! };

  switch (inputs.pauseReason) {
    // The user's own usage limit held the run: handled by the loop before it ever asks here
    // (the run stays resumable), and listed so this switch stays exhaustive.
    case "limit":
      return { action: "wait" };
    // The engine's OWN repeated-failure breaker already gave up on this exact
    // approach — nothing left for Marathon to try alone.
    case "repeatedFailure":
      return { action: "stop", status: "stuck", reason: "the same step failed repeatedly and the engine's own breaker stopped retrying it" };
    // A provider safety refusal is a decision, not a glitch — no amount of
    // auto-resuming changes a "no".
    case "refused":
      return { action: "stop", status: "blocked", reason: "the model's provider declined the request" };
    // The engine's automatic overflow-and-retry already ran once and the
    // conversation still didn't fit — a second blind attempt is likely to repeat it.
    case "overflow":
      return { action: "stop", status: "stuck", reason: "the conversation stopped fitting the model's context window even after the engine's own automatic recovery" };
    // A hard, admin-set ceiling (env-configured, not Marathon's own) fired —
    // treat it exactly like Marathon's own budget running out.
    case "costTimeLimit":
      return { action: "stop", status: "budgetExceeded", reason: "hit the engine's own cost/time ceiling" };
    // Transient: an output cutoff or a provider infra hiccup. Nothing is wrong
    // with the goal — just pick the turn back up.
    case "truncated":
    case "overloaded":
    case "stepBudget":
      return { action: "resume" };
    // Nothing to do but wait for a shell that's already running.
    case "backgroundPoll":
      return { action: "wait" };
    // The model itself signalled it thinks the stated scope is done (re-scope
    // guard), or it just stopped talking with no pause at all — both are "looks
    // done" claims, and per this whole design's first principle, a claim is not
    // a fact until something independent checks it.
    case "reScope":
    case null:
      return { action: "verify" };
  }
}

// ---------------------------------------------------------------------------
// Verification — the ONLY "is it really done" check. Reuses `spawn_subagent`'s
// own verifier primitive (`forkSession` + the VERIFIER_PROMPT/VERDICT contract
// from tools/verifyReport.ts) directly, exactly as the model itself would if it
// called spawn_subagent with verify:true — no second verification mechanism.
// ---------------------------------------------------------------------------

export async function verifyGoal(
  session: Session,
  goal: string,
  options: { signal?: AbortSignal; onEvent?: RespondOptions["onEvent"] } = {},
): Promise<VerdictReport> {
  const task = `Verify whether this goal has actually been achieved:\n\n${goal}\n\n${VERDICT_INSTRUCTION}`;
  const child = forkSession(session, task, { readOnly: true, agentPrompt: VERIFIER_PROMPT });
  const reply = await respond(child, { signal: options.signal, maxSteps: VERIFY_BUDGET, ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
  return parseVerdict(reply);
}

// ---------------------------------------------------------------------------
// Progress events — what a front end draws while a run is going. The same small
// set for both the CLI and the desktop app, and one plain-language rendering of
// each (`describeMarathonEvent`), so the two can never word the same moment
// differently.
// ---------------------------------------------------------------------------

export type MarathonEvent =
  | { type: "started"; goal: string }
  | { type: "resumed"; goal: string; turnsSpent: number }
  /** A turn is about to run. `plan` is the opening turn, the only one where questions
   *  are allowed; every turn after it is `work`. */
  | { type: "turn"; n: number; phase: "plan" | "work" }
  /** The opening turn is over: questions are closed and the run carries on by itself. */
  | { type: "planned" }
  /** A pause was carried past instead of being handed to the user. */
  | { type: "continuing"; reason: PauseReason }
  | { type: "waiting" }
  | { type: "verifying" }
  /** The independent check is working: what it is doing right now, so the wait is not silent. */
  | { type: "verifyStep"; line: string }
  | { type: "verified"; passed: boolean; verdict: VerdictReport["verdict"]; failsInARow: number }
  | { type: "finished"; status: Exclude<MarathonStatus, "running">; outcome: string }
  /** The loop stopped without reaching an outcome (the user stopped it): still
   *  "running" on the session, so it can be resumed. */
  | { type: "paused"; reason?: "limit" };

const PAUSE_WORDS: Partial<Record<PauseReason, string>> = {
  stepBudget: "step limit reached",
  truncated: "reply was cut off",
  overloaded: "provider was busy",
};

/** One line for a progress event, the same wording everywhere. */
export function describeMarathonEvent(e: MarathonEvent): string {
  switch (e.type) {
    case "started":
      return "Marathon started";
    case "resumed":
      return `Marathon resumed at turn ${e.turnsSpent + 1}`;
    case "turn":
      return e.phase === "plan" ? "Understanding the goal (questions open)" : `Working, turn ${e.n}`;
    case "planned":
      return "Questions closed, running on its own";
    case "continuing":
      return `Continuing (${PAUSE_WORDS[e.reason] ?? "paused"})`;
    case "waiting":
      return "Waiting on a background command";
    case "verifying":
      return "Checking the goal is really done";
    case "verifyStep":
      return `Checking: ${e.line}`;
    case "verified":
      return e.passed ? "Verified" : `Not done yet (${e.failsInARow} of ${MAX_MARATHON_VERIFY_FAILS} checks)`;
    case "finished":
      return e.status === "done"
        ? "Goal verified done"
        : e.status === "blocked"
          ? `Needs you: ${e.outcome}`
          : e.status === "stuck"
            ? `Stopped, stuck: ${e.outcome}`
            : `Stopped, over budget: ${e.outcome}`;
    case "paused":
      return e.reason === "limit" ? "Paused: your usage limit is reached" : "Paused";
  }
}

// ---------------------------------------------------------------------------
// The orchestrator. Thin on purpose: it composes the pure state machine above
// with ordinary `respond()` turns on the session — the same session, same
// mode, same approval channel a person typing into it would use. Injectable
// deps (defaulted to the real ones) so the whole loop is testable without a
// live model: see marathon.test.ts.
// ---------------------------------------------------------------------------

export interface MarathonDeps {
  respond: typeof respond;
  verify: typeof verifyGoal;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: MarathonDeps = {
  respond,
  verify: verifyGoal,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface MarathonOptions {
  /** Optional cost/time ceiling for the WHOLE goal — independent of any per-turn,
   *  env-configured ceiling `respond()` already enforces (reused via `costTimeLimit`
   *  in `decide`, not duplicated). Absent means no cost/time cap for the goal itself;
   *  stuck-detection and the verify-fail counter remain as backstops regardless. */
  limits?: TaskLimits;
  onEvent?: RespondOptions["onEvent"];
  onActivity?: RespondOptions["onActivity"];
  /** A long run compacts along the way; a front end draws it exactly as it does inside
   *  an ordinary turn, so these are forwarded to every turn. */
  onCompaction?: RespondOptions["onCompaction"];
  onCompactionStart?: RespondOptions["onCompactionStart"];
  onCompactionEnd?: RespondOptions["onCompactionEnd"];
  /** Progress of the run itself (turns, waiting, verifying, the outcome). */
  onMarathon?: (event: MarathonEvent) => void;
  /** Messages typed while a turn is running, delivered into it at the next step
   *  boundary — forwarded so a running Marathon can be steered like any turn. */
  steer?: RespondOptions["steer"];
  signal?: AbortSignal;
  /** Forwarded to every turn, same as an ordinary respond() caller would — so a
   *  crash mid-goal loses at most the in-flight step, not the whole run. */
  persist?: () => Promise<unknown> | void;
  /** Wait before retrying after a `backgroundPoll` pause. Default 5s. */
  backgroundPollWaitMs?: number;
  /** Images attached to the goal, sent with the goal message exactly as they would be
   *  with any first message of a session. Only the opening turn carries them. */
  goalImages?: ImageRef[];
}

/** The tools a run leans on are deferred (their schemas are not advertised until the
 *  model searches for them). A Marathon needs them from the first request. */
const MARATHON_TOOLS = ["todo_write"];

/** Pauses that end a run even from its opening turn: nothing about the goal is worth
 *  carrying on past them. Every other way the opening turn can end just means "planned". */
const HARD_STOPS: ReadonlySet<PauseReason> = new Set(["refused", "repeatedFailure", "overflow", "costTimeLimit"]);

/** What the model is told when a stopped run is carried on: pick up, do not start over. */
const RESUME_NOTE = "Carry on from where you stopped. Take the next task on your list that is not finished yet. Do not redo work that is already done, and do not stop to ask whether to continue.";

/** What the model is told when the opening turn hands over to the run. */
const BEGIN_WORK = "Questions are closed. Begin the work now, following your plan, and keep going until the goal is done.";

/**
 * Run (or resume) a goal to one of its stop conditions.
 *
 * Reentrant by construction: if `session.marathon` already exists and is still
 * "running" (e.g. the process restarted mid-goal), this picks up exactly where it
 * left off — same counters, same goal — rather than starting over. If it already
 * left "running" (a prior run finished, blocked, got stuck, or ran out of budget),
 * this returns that state immediately and does nothing. A NEW goal goes through
 * `startMarathon`, which replaces whatever is there.
 */
export async function runMarathon(
  session: Session,
  goal: string,
  options: MarathonOptions = {},
  deps: MarathonDeps = defaultDeps,
): Promise<MarathonState> {
  try {
    return await runLoop(session, goal, options, deps);
  } finally {
    // Whichever way the run ended (outcome, stop, error), a normal chat afterwards can ask again.
    session.toolContext.noQuestions = false;
  }
}

async function runLoop(
  session: Session,
  goal: string,
  options: MarathonOptions,
  deps: MarathonDeps,
): Promise<MarathonState> {
  const resumed = session.marathon !== undefined;
  const state = session.marathon ?? initMarathon(goal);
  session.marathon = state;
  const emit = options.onMarathon;
  if (state.status === "running") {
    for (const tool of MARATHON_TOOLS) session.toolContext.activatedTools?.add(tool);
    emit?.(
      resumed && state.turnsSpent > 0
        ? { type: "resumed", goal: state.goal, turnsSpent: state.turnsSpent }
        : { type: "started", goal: state.goal },
    );
  }

  const usages: Usage[] = [];
  // Feedback from a non-passing verification, queued for the NEXT turn rather than
  // pushed immediately — the turn that just ran already recorded its own pause
  // message; this is what the model reads when it's asked to continue.
  let pendingFeedback: string | null = null;
  if (state.status === "running") {
    if (state.turnsSpent === 0 && state.goalSent) {
      // Stopped while it was still understanding the goal. Questions are closed for a resumed run,
      // so the plan is finished by working, not by asking again.
      state.turnsSpent = 1;
      pendingFeedback = BEGIN_WORK;
    } else if (state.turnsSpent > 0) {
      pendingFeedback = RESUME_NOTE;
    }
  }

  while (state.status === "running") {
    if (options.signal?.aborted) break; // a real stop, not a Marathon decision — leave "running" so a later call can resume it

    const message = state.turnsSpent === 0 ? state.goal : pendingFeedback ?? "continue";
    session.transcript.push({
      role: "user",
      content: message,
      ...(state.turnsSpent > 0 ? { synthetic: true } : {}), // the goal itself is the user's own ask; every nudge after it is Marathon's
      ...(state.turnsSpent === 0 && options.goalImages?.length ? { images: options.goalImages } : {}),
    });
    if (state.turnsSpent === 0) state.goalSent = true;
    await options.persist?.(); // the goal, or the nudge, is on disk before the model is asked anything

    pendingFeedback = null;
    // The opening turn is the only one where the model may ask anything: enforced by the
    // tool itself (noQuestions) and by not advertising it, not just by what the model is told.
    const planning = state.turnsSpent === 0;
    session.toolContext.noQuestions = !planning;
    if (planning) session.toolContext.activatedTools?.add("ask_user");
    else session.toolContext.activatedTools?.delete("ask_user");
    emit?.({ type: "turn", n: state.turnsSpent + 1, phase: planning ? "plan" : "work" });

    let pauseReason: PauseReason | null = null;
    await deps.respond(session, {
      signal: options.signal,
      persist: options.persist,
      onActivity: options.onActivity,
      onCompaction: options.onCompaction,
      onCompactionStart: options.onCompactionStart,
      onCompactionEnd: options.onCompactionEnd,
      ...(options.steer ? { steer: options.steer } : {}),
      onEvent: (e) => {
        if (e.type === "usage") usages.push(e);
        else if (e.type === "todos") state.todos = e.items;
        options.onEvent?.(e);
      },
      onPause: (reason) => {
        pauseReason = reason;
      },
    });
    // Esc mid-turn ends respond() with no pause and no finished answer, which the
    // decision below would read as "looks done" and spend a verification on. A stop
    // the user asked for is not an outcome: leave the run resumable and say so.
    if (options.signal?.aborted) {
      await options.persist?.();
      emit?.({ type: "paused" });
      return state;
    }
    // The user's usage limit closed a window: not an outcome and not a fault. The run stays
    // "running" and resumable, exactly as after a stop, and says why it stopped.
    if (pauseReason === "limit") {
      await options.persist?.();
      emit?.({ type: "paused", reason: "limit" });
      return state;
    }
    state.turnsSpent++;

    // The opening turn understood the goal and wrote a plan; nothing has been attempted yet,
    // so there is nothing to verify and nothing a "looks done" signal could mean.
    if (planning && !(pauseReason && HARD_STOPS.has(pauseReason))) {
      emit?.({ type: "planned" });
      pendingFeedback = BEGIN_WORK;
      await options.persist?.();
      continue;
    }

    const stuck = detectStuck(session.transcript.slice(-STUCK_WINDOW));
    const usage = summarizeTask(usages, session.modelConfig.model);
    const budgetExceeded = options.limits ? taskLimitReason(usage, Date.now() - state.startedAt, options.limits) : null;

    const decision = decide({ pauseReason, stuck, budgetExceeded });
    switch (decision.action) {
      case "resume":
        state.resumes++;
        if (pauseReason) emit?.({ type: "continuing", reason: pauseReason });
        break;
      case "wait":
        emit?.({ type: "waiting" });
        await deps.sleep(options.backgroundPollWaitMs ?? DEFAULT_BACKGROUND_POLL_WAIT_MS);
        break;
      case "verify": {
        emit?.({ type: "verifying" });
        const report = await deps.verify(session, state.goal, {
          signal: options.signal,
          onEvent: (e) => {
            if (e.type !== "tool" || e.phase !== "start") return;
            const arg = ["path", "command", "cmd", "pattern", "query", "url"].map((k) => e.args[k]).find((v) => typeof v === "string");
            emit?.({ type: "verifyStep", line: `${e.name}${arg ? ` ${String(arg).slice(0, 80)}` : ""}` });
          },
        });
        if (options.signal?.aborted) {
          await options.persist?.();
          emit?.({ type: "paused" });
          return state;
        }
        state.lastVerification = { at: Date.now(), verdict: report.verdict, note: report.body.slice(0, 2000) };
        if (report.verdict === "pass") {
          state.consecutiveVerifyFails = 0;
          state.status = "done";
          state.outcome = "goal verified done";
        } else {
          state.consecutiveVerifyFails++;
          if (state.consecutiveVerifyFails >= MAX_MARATHON_VERIFY_FAILS) {
            state.status = "blocked";
            state.outcome = `verification did not pass after ${state.consecutiveVerifyFails} attempts (${report.verdict}): ${report.body.slice(0, 500)}`;
          } else {
            pendingFeedback =
              `A verification pass on your work came back "${report.verdict}", not done. What it found:\n\n${report.body}\n\n` +
              `Address this, then continue toward the original goal:\n${state.goal}`;
          }
        }
        emit?.({ type: "verified", passed: report.verdict === "pass", verdict: report.verdict, failsInARow: state.consecutiveVerifyFails });
        break;
      }
      case "stop":
        state.status = decision.status;
        state.outcome = decision.reason;
        break;
    }
    if (state.status !== "running") emit?.({ type: "finished", status: state.status, outcome: state.outcome ?? "" });
    await options.persist?.();
  }

  if (state.status === "running") emit?.({ type: "paused" }); // left the loop on an abort before the next turn
  return state;
}

/**
 * Begin a NEW goal, replacing whatever Marathon the session already holds (a finished
 * one, or one the user is abandoning by starting over). The front ends call this when
 * the user arms Marathon and sends their goal.
 */
export function startMarathon(
  session: Session,
  goal: string,
  options: MarathonOptions = {},
  deps: MarathonDeps = defaultDeps,
): Promise<MarathonState> {
  session.marathon = initMarathon(goal);
  return runMarathon(session, goal, options, deps);
}

/** Carry on a run that stopped while still "running" (stopped by the user, or the
 *  process ended). Nothing to resume returns null, so a caller can say so. */
export function resumeMarathon(
  session: Session,
  options: MarathonOptions = {},
  deps: MarathonDeps = defaultDeps,
): Promise<MarathonState | null> {
  const state = session.marathon;
  if (!state || state.status !== "running") return Promise.resolve(null);
  return runMarathon(session, state.goal, options, deps);
}

/** Drop the session's Marathon: the way to dismiss a finished, blocked or stuck run
 *  (and its checklist) without starting another. */
export function clearMarathon(session: Session): void {
  session.marathon = undefined;
}
