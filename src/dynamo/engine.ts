/**
 * dynamo — the engine.
 *
 * Takes a live session and produces Mindweave's next reply, running tools along the
 * way. The loop is intentionally tiny: ask the model → if it wants tools, run
 * them and feed the results back → repeat → when it answers with no tool call,
 * that's the reply. The model does the reasoning; the loop stays out of the way.
 *
 * The engine owns the TRANSCRIPT (it appends every user/assistant/tool turn to
 * `session.transcript`) and keeps it healthy with the compaction cascade. It is
 * pure of the filesystem: it never reads or writes session files (the CLI
 * persists). The one disk touch is re-reading project files, which goes through
 * the read-only tool exactly like any other tool call — so this whole function
 * can later move to a server unchanged, with tools executing on the client.
 */
import { activeDriver, ensureDriver, manifestForModel } from "../drivers/registry.js";
import type { ChatMessage, ImagePart, ModelRequest, StopReason, StreamResult, Usage, WireToolCall } from "../drivers/types.js";
import { summarizeTask, taskLimitReason, type TaskLimits } from "./pricing.js";
import { addTurn, emptySpend } from "./spend.js";
import { mutationNeedsVerification, isVerification, reScopeCheck, isBackgroundPollStep, stepFailureSignature, repeatFailureStep, repeatFailureNudge, failedActionLabel, firstErrorLine, sameFileEditCounts, overusedSingleEdits, batchEditNudge, narrationFault, narrationNudge, unknownToolError, replyFault, replyRewrite, VERIFY_NUDGE } from "./verify.js";
import { guardOptions, GUARD_REFUSAL, GUARD_REFUSAL_INPUT, guardRefusalWith, guardQuestion, guardDetail, interpretGuardChoice } from "./guard.js";
import { readFreeText } from "../tools/approval.js";
import { findTool, toolSchemas, TOOLS } from "../tools/registry.js";
import { deferredToolsIndex } from "../tools/deferredNative.js";
import { prefixPrint, diffPrefix, cacheCallLine, writeCacheLog } from "./cacheBreak.js";
import { commandShellLabel } from "../tools/runCommand.js";
import { isInteractiveServerCommand, type BackgroundShells } from "../tools/backgroundShells.js";
import { basePrompt } from "./prompt.js";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { relativize, resolvePath, rootLabel, rootsOf } from "../tools/paths.js";
import { renderRules, renderSkillCatalog, reloadGovernance, governanceStamp, rescope } from "../governor/index.js";
import type { Session, Entry, ToolCallRecord } from "../memory/types.js";
import type { ImageRef } from "../memory/images.js";
import { forkSession, reloadProjectMemory } from "../memory/session.js";
import { selectActiveFiles } from "../memory/workingSet.js";
import { directoryNotesFor } from "../memory/projectNotes.js";
import { rippleCheck } from "../tools/editRipple.js";
import { fullReadPaths } from "../memory/presence.js";
import {
  RESTORE_MAX_TOKENS_PER_FILE,
  renderRestored,
  restoreBudgetFor,
  selectForRestore,
} from "../memory/restore.js";
import {
  KEEP_LAST_N,
  KEEP_LAST_N_BOUNDARY,
  SUMMARY_REQUEST,
  summaryRequest,
  SUMMARY_SYSTEM_PROMPT,
  dropOldestRounds,
  estimateEntriesTokens,
  estimateTokens,
  estimateTokensForChars,
  formatTranscriptForSummary,
  isContinuation,
  microcompact,
  spliceSummary,
  usableSummary,
} from "../memory/compaction.js";
import { loadPlanArtifact, completePlanArtifact, renderPlanBlock, planDivergenceStop } from "./planArtifact.js";
import {
  autoCompactThreshold,
  microCompactThreshold,
  cacheLikelyCold,
  clearIsWorthIt,
  measuredOverhead,
  sharpContextWindow,
  type CompactionReport,
} from "./contextWindow.js";
import { renderSessionMemory, shouldUpdateSessionMemory, updateSessionMemory } from "../memory/sessionMemory.js";
import { compactFromSessionMemory } from "../memory/sessionMemoryCompact.js";
import { isContextOverflowError } from "../drivers/contextOverflow.js";
import { detailOf, providerMessage } from "../drivers/providerError.js";
import { transcriptPath } from "../memory/store.js";

/** Stop retrying autocompact after this many consecutive failures in a session, so a
 *  transcript that's irrecoverably over the limit can't hammer the summarizer each turn
 *  (a circuit-breaker for runaway retry loops, which can otherwise pile up thousands of doomed retries). */
const MAX_COMPACT_FAILURES = 3;

// The static base (identity, output/formatting, tone, tool mechanics, safety,
// task hygiene, and how to use cross-session memory) comes from basePrompt in
// prompt.ts. Here we wrap it with the per-session, per-turn context: the
// governor (rules/forbidden/skills), the project snapshot, MINDWEAVE.md, the memory
// index, the ranked code map, the task list, and the multi-root workspace. The
// line we hold is the thin-prompt boundary: rich on what the harness owns, but
// we still do NOT teach engineering judgment (how to debug, how to write code) —
// that is the model's job.
export function staticSystemPrompt(
  projectContext: string,
  projectMemory: string,
  memoryDir: string,
  memoryIndex: string,
  governance: GovernancePrompt,
  workspace: string,
  priorSessions = 0,
): string {
  let prompt = basePrompt(commandShellLabel());

  if (workspace) {
    prompt += `

This session spans more than one root folder. Each file is addressed as \`label/path\`; search tools cover every root unless you pass a specific \`path\`. The roots are:
<workspace>
${workspace}
</workspace>`;
  }

  // NOTE: the user's standing rules are deliberately NOT rendered here. They live
  // in the volatile tail (volatileContext) instead — rebuilt every turn at the
  // boundary where attention is strongest, so a long session can't bury them in the
  // middle of a huge cached prefix. Rules are the one governance layer that depends
  // purely on the model reading and obeying (forbidden is enforced mechanically;
  // skills are a reference catalog), so they alone get the salience boost. Keeping
  // them out of the prefix also stops a mid-session `remember_rule` from busting it.
  if (governance.forbidden) {
    prompt += `

You are FORBIDDEN from modifying these paths — never write, edit, or run a command that changes them. The tools also enforce this and will refuse, but do not even try:
<forbidden>
${governance.forbidden}
</forbidden>`;
  }
  if (governance.forbiddenCommands) {
    prompt += `

You are FORBIDDEN from running these commands (or any command that contains one) — run_command will refuse them and only the user can lift that. Do not attempt them or a workaround:
<forbidden_commands>
${governance.forbiddenCommands}
</forbidden_commands>`;
  }
  if (governance.skills) {
    prompt += `

You have project skills available — named procedures you can run. To run one, call use_skill with its name; its full steps are loaded then (you only see the summary here). Use one when its description fits the task:
<available_skills>
${governance.skills}
</available_skills>`;
  }

  if (projectContext) {
    prompt += `

The following describes the project and machine you're working in, captured at the start of this session (a snapshot — use tools for anything current or deeper):
${projectContext}`;
  }
  if (projectMemory) {
    prompt += `

The project provides this context in its MINDWEAVE.md — treat it as background facts about this codebase:
<project_memory>
${projectMemory}
</project_memory>`;
  }
  // Its own past work in this project. The COUNT goes in the prompt (so the model
  // knows the history exists without being told every turn what is in it); the
  // CONTENT is pulled on demand with the `sessions` tool. Injecting the
  // sessions themselves would be ruinous — this way an ordinary turn pays nothing
  // and a question about past work gets a real answer instead of a deflection.
  if (priorSessions > 0) {
    const s = priorSessions === 1 ? "" : "s";
    prompt += `

You have worked in this project before: ${priorSessions} earlier session${s} of yours are saved, and you can read them. When the user refers to earlier work — "last session", "what did we do", "the bug we fixed" — call \`sessions\` to list them, then \`sessions\` again with an id to read the one they mean, and answer from what you find. It is not in your tool list until you load it with find_tools. Do not say you cannot see your past sessions, and do not guess from the project files instead. \`/continue\` is for the user to RESUME a session; it is not a substitute for you looking. Never present another tool's saved conversations as your own.`;
  }

  if (memoryDir) {
    prompt += `

Your cross-session memory for this project lives in \`${memoryDir}\` (read or grep the topic files there for the full text of any entry). Its index:
<memory_index>
${memoryIndex || "(empty — nothing has been saved to memory yet)"}
</memory_index>`;
  }

  // The deferred pool's index. Roughly forty tokens standing in for several hundred of
  // schema, and it earns them: without it a deferred tool is indistinguishable from a
  // missing feature, and the model routes around a capability it actually has.
  const deferred = deferredToolsIndex();
  if (deferred) {
    prompt += `

${deferred}`;
  }

  return prompt;
}

/**
 * The volatile per-turn context, rendered at the TAIL of the request (outside the
 * cacheable prefix): the ranked code map and the live task list. These change
 * across steps/turns, so keeping them out of the system prompt is what lets the
 * system + conversation prefix stay byte-stable and be served from the provider's
 * prompt cache. Returns "" when there's nothing to add.
 */

/**
 * How many of the most recently touched files are checked for folder notes.
 *
 * Bounded because this reads disk every turn. The agent works in a handful of places
 * at a time, and the files below this line are ones it has already moved on from.
 */
const ACTIVE_FILES_FOR_NOTES = 20;

export function volatileContext(
  rules: string,
  planMode: boolean,
  sessionMemory: string,
  approvedPlan = "",
  /** Notes for the folders being worked in right now (see memory/projectNotes.ts). */
  directoryNotes: { path: string; text: string }[] = [],
  /** Where the previous turn left the shell, when this turn started back at the root. */
  cwdResetFrom = "",
): string {
  const parts: string[] = [];
  // Each turn starts at the project root, and a model that `cd`-ed into a subfolder last
  // turn does not know that unless it is told. It was not, and a real session ran
  // `cargo run` from the root expecting the subfolder: "could not find Cargo.toml".
  if (cwdResetFrom) {
    parts.push(
      `Commands run from the project root. The previous turn had moved into ${cwdResetFrom}, but each ` +
        `turn starts back at the root: cd there again, or use paths from the root.`,
    );
  }
  // Standing rules FIRST in the volatile tail. They're rebuilt every turn here (not
  // in the cached prefix), so a long conversation can never bury them — and they sit
  // at the top of the freshest context the model reads before it acts. Binding by
  // design: they override the model's own defaults.
  if (rules) {
    parts.push(
      "The user's standing rules for this project. They are BINDING — follow them exactly, and let them " +
        "override your own defaults and habits. Do not violate them or work around them:\n" +
        `<rules>\n${rules}\n</rules>`,
    );
  }
  // The approved plan is standing knowledge: rendered fresh here every request
  // (never from the transcript), which is what makes it immune to compaction. It
  // binds EXECUTION turns; while planning, the model is deliberately not anchored
  // to the previous agreement — the artifact stays on disk if it wants history.
  if (approvedPlan && !planMode) {
    parts.push(approvedPlan);
  }
  // Plan mode (Architect) lives in the VOLATILE tail, not the cached prefix, so
  // toggling it with shift-tab never invalidates the cached system prompt.
  if (planMode) {
    parts.push(
      "You are in PLAN MODE (Architect). Research the codebase and think the change through; do NOT modify files, " +
        "run commands, or take any action while planning — the editing tools are withheld until the plan is approved. " +
        "Where a decision is genuinely the user's (which approach, which of two designs), ask with ask_user rather " +
        "than choosing for them. " +
        "When you know exactly what you would change, call exit_plan with the WHOLE plan in it. That is how planning " +
        "ends: the user reads the plan there, and approving it starts the work immediately, in the same turn, with " +
        "you following that plan. Do not write the plan out as an ordinary reply and stop — prose between steps is " +
        "shortened before the user sees it, so a plan presented that way reaches them in pieces.",
    );
  }
  // The maintained session state — first in the volatile tail so the model reads
  // "here's where we are" before the map/task list. Survives compaction.
  const memBlock = renderSessionMemory(sessionMemory);
  if (memBlock) parts.push(memBlock);
  // Notes belonging to the FOLDERS currently in play. Volatile on purpose: they change
  // as the agent moves around the repository, and folding them into the cached prefix
  // would rewrite that prefix every time it opened a file in a new directory. Read
  // after the session state and before the work, so the most specific standing facts
  // are the last thing seen.
  if (directoryNotes.length > 0) {
    const notes = directoryNotes
      .map((n) => `<notes for="${n.path}">\n${n.text}\n</notes>`)
      .join("\n");
    parts.push(
      "Notes the project keeps for the folders you are working in. They apply to files in " +
        "those folders and are as binding as the project's own notes:\n" +
        notes,
    );
  }
  // NO ranked code map and NO task list. Both were rebuilt and re-sent on every step,
  // and both already exist somewhere cached:
  //
  //   - the map is what the `relevant` tool returns, on demand, when the model wants it.
  //     Pushing it unasked also meant paying a chassis ranking call per turn for an
  //     answer the model had not asked for and often did not use.
  //   - the task list is the literal body of `todo_write`'s own tool result, which sits
  //     in the append-only conversation where the provider caches it.
  //
  // Re-sending either was buying a second copy of something already in context, at full
  // price, once per step. A capability the model can reach for is not the same cost as a
  // block it is handed continuously.
  // NO working-files block. File contents live in the conversation as tool results,
  // where the append-only shape lets the provider cache them. Re-sending them here cost
  // up to 12K tokens on EVERY model call and could never be cached, because each step
  // appends to the conversation ahead of this block — so no position within the tail
  // could have saved it. See the note in the step loop.
  // REPLY_STYLE is NOT pushed here any more. At 645 tokens it was the largest thing
  // left in the tail and it was re-sent, uncached, on every step of every turn — ten
  // steps meant paying for it ten times to govern ONE final message. It now lives in
  // the system prompt, which is cached, and which is where the equivalent sits in every
  // other agent that does this well.
  //
  // The comment above records that it was moved OUT of the prefix once because it was
  // being ignored by turn three. That is a real observation and this reverses it, so if
  // replies start sprawling again the answer is a short reassertion attached to
  // something already in the conversation — not a 645-token block on every request.
  return parts.join("\n\n");
}


// The governor's three prompt blocks, pre-rendered to strings ("" when empty so
// the block is omitted). Built fresh each turn from the session's governance.
interface GovernancePrompt {
  rules: string;
  forbidden: string;
  forbiddenCommands: string;
  skills: string;
}

function governancePrompt(session: Session): GovernancePrompt {
  const g = session.governance;
  // Which glob-scoped rules have fired is decided when a path is TOUCHED, not here —
  // see governor/scope.ts. This used to rebuild the whole working set on every model
  // call and match every scoped rule against all of it, which is O(paths x rules) per
  // step against a set that only ever grew.
  const fired = session.toolContext.ruleScope?.matched ?? new Set<string>();
  return {
    // A set lookup per rule. Rules render into the VOLATILE tail, which is rebuilt every
    // step regardless, so this is now genuinely the free part it always claimed to be.
    rules: renderRules(g.rules, fired),
    forbidden: g.forbidden.patterns.map((p) => `- ${p}`).join("\n"),
    forbiddenCommands: (g.forbidden.commands ?? []).map((c) => `- ${c}`).join("\n"),
    // The skill catalog renders into the CACHED SYSTEM PROMPT, so it is deliberately
    // NOT filtered by the working set. Filtering it there was a silent cache killer:
    // a glob-scoped skill appears or disappears the moment the model reads a matching
    // file, which changes the system prompt, which invalidates the tools, the system
    // AND the whole conversation — the most expensive invalidation the API has. A turn
    // that read one file could re-bill the entire prefix.
    //
    // Anthropic's own caching guidance names this exact shape: "conditional system
    // sections — every flag combination is a distinct prefix." The glob filter was
    // saving a few lines of catalog and paying for it with a full rebuild.
    //
    // Safe because the catalog is bounded by construction: at most MAX_SKILL_ENTRIES
    // lines, each clipped to MAX_SKILL_LINE_CHARS. Unfiltered is bigger, and stable —
    // and stable is what a cached prefix has to be.
    skills: renderSkillCatalog(g.skills),
  };
}

// The tiny, budgeted ranked map injected each turn (the "auto-map" half of the
// relevance feed). Personalized to the files recently read. A pure in-memory
// chassis query — no I/O, no model call — so the engine stays filesystem-pure.

/** A positive integer from the environment, or the fallback. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** A boolean env flag. Default ON unless explicitly set to 0/false/off/no. */
function envFlag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

/** A non-negative number from the environment, or the fallback. */
function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Per-task cost/time ceilings. OFF (0) by default — opt-in via env, so there are
 *  no surprise pauses; a runaway is one env var away from being capped. */
function taskLimits(): TaskLimits {
  return {
    maxUsd: envNum("MINDWEAVE_MAX_TASK_USD", 0),
    maxSeconds: envNum("MINDWEAVE_MAX_TASK_SECONDS", 0),
  };
}

/**
 * How many tool rounds one turn may take, or undefined for no ceiling (pure).
 *
 * A ceiling is for a loop NOBODY IS WATCHING. That is the whole rule, and it is what
 * decides who gets one:
 *
 *  - A **sub-agent** always gets one. It runs unattended by definition: there is no
 *    prompt to interrupt, no screen showing its steps, and nothing between a worker
 *    that has misread its task and an unbounded bill. `subagent.ts` passes its budget
 *    explicitly, so a worker is capped whatever this returns.
 *  - The **interactive turn** does not, by default. Someone is sitting in front of it
 *    watching every tool row appear, and Esc stops the turn at the next boundary. A
 *    counter is a worse circuit breaker than the person already holding one.
 *
 * The previous default capped the interactive loop at fifty rounds, and what that
 * actually stopped was work: a task across a dozen files spends fifty rounds without
 * anything going wrong, and it ended mid-flight with a pause the user then had to
 * step over. A guard that fires on ordinary work is not a guard, it is a limit.
 *
 * `MINDWEAVE_STEP_BUDGET` puts a ceiling back for anyone who wants one — an unattended
 * run, a script, a machine that must not be able to spend past a point. Unset, the
 * turn ends when the model is finished or the user stops it.
 */
export function resolveStepLimit(maxSteps: number | undefined, envValue: string | undefined): number | undefined {
  if (maxSteps !== undefined) return maxSteps;
  const n = Number(envValue);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
// Verification gate: when the model edits files then tries to finish without
// running any check, nudge it once to verify. On by default; MINDWEAVE_VERIFY_GATE=0
// disables it. See verify.ts for the (pure, tested) fact detectors.
const VERIFY_GATE = envFlag("MINDWEAVE_VERIFY_GATE", true);
// Background-poll allowance: how many still-running background-shell polls the model
// may make in one turn before the loop stops it. A finished shell notifies the model
// automatically, so polling is redundant; one poll is allowed (a legitimate "grab the
// current tail" when the user asks), the wait-loop after that is stopped deterministically.
const BG_POLL_ALLOWANCE = envInt("MINDWEAVE_BG_POLL_LIMIT", 1);
// How many times in a row the model may fire a step that fails the SAME way before we
// stop it. 3 is the threshold: repeated identical failures past that are a stuck loop,
// not progress. Env-overridable for tuning.
const REPEAT_FAIL_LIMIT = envInt("MINDWEAVE_REPEAT_FAIL_LIMIT", 3);

/**
 * A live event from a turn, for the streaming UI. The model's reasoning and answer
 * arrive as `reasoning`/`text` deltas; each tool the model runs bookends with a
 * `tool` start (name + parsed args, before it runs) and end (summary, after) keyed
 * by the call `id`; `usage` reports the turn's token count once the answer lands.
 * Out-of-band notices (compaction) still go through `onActivity`, not here.
 */
export type EngineEvent =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  /** The draft reply was rejected by the reply gate — discard whatever text has been
   *  buffered for this turn's reply, because a rewrite is about to stream in its place.
   *  Nothing has been rendered yet (text reveals whole, on seal), so this is invisible. */
  | { type: "replyReset" }
  // `agent` (a sub-agent id) tags a tool event that came from a spawned worker, so the
  // UI can nest it under that worker's row instead of the main stream. Absent on the
  // lead agent's own calls.
  | { type: "tool"; phase: "start"; id: string; name: string; args: Record<string, unknown>; agent?: string }
  /** Output from a call that has NOT finished. Carries the latest tail, not an increment:
   *  the receiver replaces what it is showing, so a dropped update costs nothing. */
  | { type: "tool"; phase: "progress"; id: string; text: string; agent?: string }
  | {
      type: "tool";
      phase: "end";
      id: string;
      name: string;
      summary: string;
      error: boolean;
      detail?: string;
      /** See ToolResult.detailKind — whether `detail` is a real +/- diff (colour it)
       *  or ordinary text (do not). Absent means text. */
      detailKind?: "diff" | "text" | "shell";
      agent?: string;
      /** Display-only: a failure the model resolves itself, so the UI drops the row
       *  rather than painting an error the user can do nothing about. See ToolResult.quiet. */
      quiet?: boolean;
      /** See ToolResult.displayKind/displayName — a result-driven override of the
       *  row's category/name (a governance decision, not an ordinary outcome). */
      displayKind?: import("../cli/toolDisplay.js").ToolKind;
      displayName?: string;
    }
  // A spawned sub-agent's lifecycle: `start` when it's dispatched (with its task +
  // read-only flag), `end` when it reports back. Between them, its own tool events
  // arrive tagged with this `id`, so the UI can render a live nested rail per worker.
  | { type: "subagent"; phase: "start"; id: string; task: string; readOnly: boolean }
  | { type: "subagent"; phase: "end"; id: string; summary: string; error: boolean }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheWriteTokens?: number };

export interface RespondOptions {
  /** Called once per tool run (and on compaction) with a short line for the live
   *  UI. `opts.error` marks a failed tool so the UI can flag it; `opts.context`
   *  marks a context-housekeeping line (compaction) so the UI sets it apart. */
  onActivity?: (line: string, opts?: { error?: boolean; context?: boolean }) => void;
  /**
   * A compaction pass finished, with what it cost and recovered.
   *
   * Separate from `onActivity` because it is numbers, not a line of text — the client
   * draws its own bars from them, and a pre-formatted string would force the engine to
   * know about terminal width. Automatic and manual compactions both report here, so a
   * user who never typed /compact still learns their conversation was summarized.
   */
  onCompaction?: (report: CompactionReport) => void;
  /**
   * What the user asked a MANUAL compaction to concentrate on (`/compact <text>`).
   * Additive only — it ranks detail inside the nine sections, it never narrows them.
   * Absent for automatic compactions, which nobody asked for and so nobody steered.
   */
  compactFocus?: string;
  /** Called for every live event of the turn (deltas, tool lifecycle, usage). The
   *  streaming UI renders from these; omit it for a non-interactive caller. */
  onEvent?: (event: EngineEvent) => void;
  /** Aborts the in-flight model call, kills a running command, and stops the loop at
   *  the next boundary (the user pressing Esc). run_command listens to the same signal. */
  signal?: AbortSignal;
  /** Persist the session NOW — called after every transcript step (assistant message,
   *  tool results, final reply) so a hard crash / PC shutdown loses at most the current
   *  in-flight step, not the whole turn. Best-effort; awaited so the write lands before
   *  the next model call. Omit for callers that don't persist (e.g. sub-agents). */
  persist?: () => Promise<unknown> | void;
  /** Cap on tool rounds for THIS run. There is no default one: an unattended caller
   *  (a sub-agent) sets its own, and an interactive turn runs until it is finished or
   *  the user stops it. See `resolveStepLimit`. */
  maxSteps?: number;
  /**
   * Messages the user typed while this turn was running, asked for at each step
   * boundary and delivered into the SAME turn.
   *
   * Without it a message typed during a long task waits for the whole task to end and
   * then starts a new one, so a correction arrives after the thing it was correcting was
   * finished. With it the turn changes course.
   *
   * A pull, not a push, and asked for at one specific moment: after a round's tool
   * results are recorded and before the next model call. Anywhere else is wrong — a
   * message landing between a tool call and its result leaves the conversation malformed,
   * which every provider rejects.
   *
   * Async because the caller resolves attachments (dropped paths, pastes, images) against
   * the working directory before answering, and awaiting that here is what stops a
   * half-resolved message being appended. Omitted by unattended callers: a sub-agent has
   * no user typing at it, and `subagent.ts` leaves this unset so a prompt meant for the
   * main turn can never leak into a worker's context.
   */
  steer?: () => Promise<SteeredMessage[]>;
}

/** A message that arrived mid-turn, resolved and ready to append. */
export interface SteeredMessage {
  /** What to send: attachments already expanded, the same as a normal submit. */
  content: string;
  /** Images attached to it, if the running model can see them. */
  images?: ImageRef[];
}

/**
 * How a mid-turn message is put to the model (pure).
 *
 * The framing is the whole reason this exists. A bare user message appearing after a
 * round of tool results is ambiguous: it reads as if it had always been the request, so
 * the model either restarts on it or, having already been told to do something else,
 * ignores it. Saying when it arrived resolves both, and the second sentence is what
 * makes it a steer rather than an interruption — the work in flight is not thrown away.
 *
 * Applied when the request is BUILT, never stored. The transcript keeps what the person
 * typed; see `steered` in `memory/types.ts`.
 */
export function steeredMessage(text: string): string {
  return (
    `The user sent this while you were working:\n\n${text}\n\n` +
    `If it changes what you should be doing, change course now. Otherwise finish the ` +
    `current step, then answer it before you stop.`
  );
}

/**
 * How a message sent straight after an interrupt is put to the model (pure).
 *
 * A different fact from a steer, and it has to read differently. The work was STOPPED —
 * the model is not deciding whether to change course, that decision was made for it by
 * the person who pressed the key. Telling it to "finish the current step" here would be
 * telling it to resume the thing it was just stopped from doing.
 */
export function interruptedMessage(text: string): string {
  return (
    `The user stopped you and sent this:\n\n${text}\n\n` +
    `The work you were doing was cut off on purpose. Take it from here rather than ` +
    `picking up where you left off, unless this asks you to.`
  );
}

/** The wire form of a message that did not simply arrive in its turn (pure). */
export function arrivalNote(arrival: "steered" | "interrupting", text: string): string {
  return arrival === "steered" ? steeredMessage(text) : interruptedMessage(text);
}

/** True if an error is an AbortError (the model call was cancelled). */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Shape a thrown tool fault into a result the model can act on (pure).
 *
 * The MESSAGE only, never the stack. A stack is noise to the model, and it names
 * absolute paths that would then live in the user's transcript and be re-sent to the
 * provider on every later turn.
 *
 * It says whose fault it is on purpose. Told only that something failed, a model
 * reliably assumes it called the tool wrongly and retries the identical call; naming
 * the tool as the faulty party is what turns a loop into a change of approach.
 */
export function toolFailureResult(name: string, error: unknown): { output: string; summary: string; isError: true } {
  const why = error instanceof Error && error.message ? error.message : String(error);
  return {
    output:
      `The ${name} tool failed unexpectedly: ${why}\n` +
      `This is a fault in the tool, not in your request. Try a different approach, or tell the user what is not working.`,
    summary: `${name} failed`,
    isError: true,
  };
}

/** Record and return a clean interrupted reply (well-formed transcript). */
function interrupted(session: Session): string {
  const msg = "(interrupted)";
  session.transcript.push({ role: "assistant", content: msg });
  return msg;
}

/** Map our stored tool calls to the provider's wire shape. */
function toWire(calls: ToolCallRecord[]): WireToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: c.arguments },
    // Carried through untouched. Core has no idea what is in here; a driver that needs
    // it splices it back onto the wire call, and one that does not ignores it. Gemini
    // rejects a follow-up whose call lost its `thought_signature`, so dropping this
    // makes tool use fail outright rather than merely degrade.
    ...(c.meta ? { meta: c.meta } : {}),
  }));
}

/** The labeled root list for the prompt — "" for an ordinary single-root session. */
function workspaceText(session: Session): string {
  const roots = session.toolContext.roots ?? [];
  if (roots.length <= 1) return "";
  return roots.map((r) => `- ${rootLabel(roots, r)}  →  ${r}`).join("\n");
}

/**
 * Build the provider-agnostic request from a session. The split is deliberate and
 * is what makes prompt caching work on every model (see ModelRequest):
 *   - `system`   — the STABLE system prompt (identity, tools guidance, governance,
 *                  project facts). Same bytes every step → cached prefix.
 *   - `messages` — the conversation, append-only, plus any one-shot background-shell
 *                  notes for this turn (transient — never stored, so they can't
 *                  re-inject).
 *   - `context`  — the VOLATILE per-turn map + task list, rendered at the tail so it
 *                  never invalidates the cached prefix.
 */
/**
 * Read the bytes for every image still live in the transcript, keyed by path.
 *
 * Bytes are loaded HERE, once per turn, rather than stored in the transcript or read
 * by each driver. That keeps the session file small, keeps drivers off the filesystem
 * (they format, they don't fetch), and means the caps and validation live in one place.
 * A file that has since been deleted or become unreadable is simply absent from the
 * map; `buildRequest` turns that into a line the model can read, never a crash.
 */
/** Can the model currently selected actually look at a picture? A manifest FACT, asked
 *  in one place — the same rule the screenshot path already follows. */
function modelSeesImages(session: Session): boolean {
  return manifestForModel(session.modelConfig.model).acceptsImages?.(session.modelConfig.model) ?? false;
}

async function loadImagePayloads(session: Session): Promise<Map<string, string>> {
  // Nothing to load for a model that cannot look at one. This is the /provider switch
  // case: a picture attached while a vision model was running stays in the transcript,
  // and without this it was re-encoded and re-sent on every request to a text-only model
  // that will not read it — measured, and it goes out as an `image_url` part that a
  // text-only endpoint is entitled to reject outright.
  if (!modelSeesImages(session)) return new Map();
  const paths = new Set<string>();
  for (const e of session.transcript) {
    if (e.role === "user" && e.images) for (const img of e.images) paths.add(img.path);
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...paths].map(async (p) => {
      try {
        out.set(p, (await fsp.readFile(p)).toString("base64"));
      } catch {
        // Gone or unreadable — deliberately left out of the map.
      }
    }),
  );
  return out;
}

function buildRequest(
  session: Session,
  tools: ReturnType<typeof toolSchemas>,
  imagePayloads: Map<string, string> = new Map(),
  /** Notes for the folders in play, resolved by the caller (it has to read disk). */
  directoryNotes: { path: string; text: string }[] = [],
): ModelRequest {
  const canSeeImages = modelSeesImages(session);
  const messages: ChatMessage[] = [];
  for (const e of session.transcript) {
    if (e.role === "user" || e.role === "summary") {
      // Attached images ride with the message, but only while their payload is still
      // live: microcompaction drops the refs once the turn is old, and a file deleted
      // since it was attached simply isn't in the payload map. Either way the model is
      // TOLD rather than quietly handed a message that claims an image it cannot see.
      const refs = e.role === "user" ? e.images : undefined;
      // A message that arrived mid-turn is framed HERE rather than being stored framed,
      // so the transcript keeps what the person typed and only the wire carries the
      // explanation. Deterministic from the entry, so the cached prefix is unaffected.
      const said = e.role === "user" && e.arrival ? arrivalNote(e.arrival, e.content) : e.content;
      if (refs && refs.length > 0) {
        const images: ImagePart[] = [];
        const missing: string[] = [];
        const unseen: string[] = [];
        for (const ref of refs) {
          // Told, never silently dropped. A message that mentions a screenshot and
          // carries nothing reads to the model as a picture it failed to notice; the
          // reason it cannot see it is the one thing that makes the message sensible.
          if (!canSeeImages) {
            unseen.push(basename(ref.path));
            continue;
          }
          const data = imagePayloads.get(ref.path);
          if (data) images.push({ path: ref.path, mediaType: ref.mediaType, data });
          else missing.push(basename(ref.path));
        }
        const notes = [
          ...(unseen.length > 0
            ? [`${unseen.join(", ")} was attached, but the model now running cannot see images`]
            : []),
          ...(missing.length > 0 ? [`${missing.join(", ")} could not be read from disk`] : []),
        ];
        const content = notes.length > 0 ? `${said}

[${notes.join("; ")}]` : said;
        messages.push({ role: "user", content, ...(images.length > 0 ? { images } : {}) });
        continue;
      }
      messages.push({ role: "user", content: said });
    } else if (e.role === "assistant") {
      messages.push({
        role: "assistant",
        content: e.content,
        ...(e.toolCalls && e.toolCalls.length > 0 ? { tool_calls: toWire(e.toolCalls) } : {}),
      });
    } else {
      messages.push({ role: "tool", tool_call_id: e.toolCallId, content: e.content });
    }
  }

  // Compute the governance blocks once: the prefix uses forbidden/skills, the
  // volatile tail uses the rules (moved there for salience — see volatileContext).
  const gov = governancePrompt(session);
  // A child spawned with a ROLE (the verifier is the one that has one) carries it at the
  // END of the system prompt. The end, because everything before it is the prefix every
  // session shares and caches against; appending leaves that untouched.
  const agentPrompt = session.toolContext.agentPrompt;
  const base = staticSystemPrompt(
    session.projectContext,
    session.projectMemory,
    session.memoryDir,
    session.memoryIndex,
    gov,
    workspaceText(session),
    session.priorSessions,
  );
  return {
    system: agentPrompt ? `${base}\n\n${agentPrompt}` : base,
    messages,
    context: volatileContext(
      gov.rules,
      session.toolContext.planMode ?? false,
      session.sessionMemory ?? "",
      session.toolContext.activePlan
        ? renderPlanBlock({
            plan: session.toolContext.activePlan,
            approvedAt: session.toolContext.activePlanApprovedAt ?? "",
            mode: "lightning",
          })
        : "",
      directoryNotes,
      // Only while the turn is still sitting where the reset put it. Once a command moves,
      // the command's own result says where it is now.
      session.toolContext.cwdResetFrom && session.toolContext.cwd === session.cwd
        ? relativize(session.toolContext, session.toolContext.cwdResetFrom)
        : "",
    ),
    tools,
    model: session.modelConfig,
  };
}

/**
 * Collect one-shot notes for background shells that finished since the last turn.
 * Drained ONCE here (the manager marks them reported), so the model is told exactly
 * once — never the re-injecting-forever leak that plagues other agents.
 */
async function backgroundEventNotes(session: Session): Promise<string[]> {
  const mgr = session.toolContext.backgroundShells;
  if (!mgr) return [];
  const events = await mgr.drainEvents();
  return events.map(backgroundEventNote).filter((note): note is string => note !== null);
}

/**
 * The note for one background-shell event, or null when there is nothing to say (pure).
 *
 * An ending the AGENT caused says nothing: `kill_shell` already told it the shell
 * stopped. The note that used to follow declared "this is the user stopping their own
 * app", which blamed the user for the agent's own restart and gave the model a second,
 * contradictory account of the same event.
 */
export function backgroundEventNote({
  info,
  kind,
  tail,
  wake,
}: Awaited<ReturnType<BackgroundShells["drainEvents"]>>[number]): string | null {
  // It came up. This is the only positive event a server ever produces, and it is
  // what lets the model actually deliver the "I'll tell you when it's running" it
  // was told to say. Nothing has gone wrong, so there is nothing to fix.
  if (kind === "ready") {
    return (
      `[Background shell #${info.id} (\`${info.command}\`) is up and running.]\n` +
      `Recent output:\n${tail || "(no output)"}\n\n` +
      `Tell the user in one short line that it's running. Nothing is wrong — do not investigate, ` +
      `do not restart it, and do not change any files because of this. Running only means the ` +
      `process started: do not describe what it shows or say a change is visible unless you ` +
      `have actually looked.`
    );
  }
  // The watchdog thinks this running shell is stuck. It has produced nothing for a
  // while — either blocked on a prompt it will never answer, or silently wedged on a
  // command that should have kept working. The point is to stop it sitting invisible
  // until the timeout, and to hand the model the two moves that resolve it.
  if (kind === "stalled") {
    const why =
      info.stallReason === "prompt"
        ? `It looks like it is waiting for interactive input (its last line reads as a prompt). ` +
          `Kill it with kill_shell #${info.id} and re-run non-interactively — pipe the answer in ` +
          `(e.g. \`echo y | …\`) or add a non-interactive flag like \`-y\`/\`--yes\`.`
        : `It has produced no output for a long time and may be wedged. Read it with shells #${info.id} ` +
          `to judge, then either keep waiting if it is genuinely mid-work, or kill it with ` +
          `kill_shell #${info.id} and look into why it hangs.`;
    return (
      `[Background shell #${info.id} (\`${info.command}\`) appears to be stuck.]\n` +
      `Recent output:\n${tail || "(no output)"}\n\n${why}`
    );
  }
  const status =
    info.status === "killed"
      ? info.stoppedBy === "user"
        ? "was stopped by the user"
        : "was killed"
      : `finished with exit code ${info.exitCode}`;
  // An ending that is NOT worth interrupting for still arrives, so the model knows the
  // thing is down and can answer about it. It is explicitly not a task: this is the
  // path a user closing their own app takes, and treating it as news is what made the
  // agent reopen it.
  if (info.status === "killed" && info.stoppedBy === "agent") return null;
  // Mindweave stopped it itself, because its output ran past the size cap. That is a
  // runaway, not someone closing an app, and the model is the one who can explain it.
  if (info.status === "killed" && info.stoppedBy === "system") {
    return (
      `[Background shell #${info.id} (\`${info.command}\`) was stopped by Mindweave because its output ` +
      `passed the size limit.]\n` +
      `Recent output:\n${tail || "(no output)"}\n\n` +
      `Something in it was writing without end. Tell the user, and look at the output above before ` +
      `running it again.`
    );
  }
  if (!wake) {
    // Only a stop the user made through the app is known to be theirs. An app that exited
    // on its own after coming up was most likely closed by them, which is worth saying as
    // the likely reading rather than as a fact.
    const who =
      info.status === "killed" && info.stoppedBy === "user"
        ? "the user stopping their own app"
        : "most likely the user closing their own app";
    return (
      `[Background shell #${info.id} (\`${info.command}\`) ${status}. It had already started up, so ` +
      `this is ${who}, not a failure.]\n` +
      `This is background information only. Do NOT mention it unless it is relevant, do NOT restart ` +
      `it, and do NOT change any files because of it. If the user later asks about this app, you now ` +
      `know it is stopped.`
    );
  }
  // For a server, only a failure to come up reaches here: a normal stop does not wake.
  const guidance =
    info.notify === "on_failure"
      ? "This is a server or app that never came up, so the user never saw it running. If you started it to check work you are still doing, getting it running is part of that work: find out why it failed and fix it. Otherwise tell them what happened and offer to fix it. Either way, do not restart it again without changing something first."
      : "If it failed, tell the user briefly what went wrong and propose a fix — don't change files unless they agree.";
  return (
    `[Background shell #${info.id} (\`${info.command}\`) ${status}.]\n` +
    `Recent output:\n${tail || "(no output)"}\n\n` +
    guidance
  );
}

/**
 * Produce Mindweave's next reply for the latest user message already on
 * `session.transcript`. Appends the assistant/tool turns it generates and
 * returns the final assistant text.
 */
/**
 * Whether a tool call may run in the PARALLEL lane (pure — unit-tested). A tool's
 * per-args `isConcurrencySafe` wins when present (e.g. a read-only sub-agent is safe
 * to fan out, an editing one is not); otherwise the default is read-only ⇒ safe.
 */
export function callIsConcurrencySafe(
  tool: { readOnly: boolean; isConcurrencySafe?: (args: Record<string, unknown>) => boolean },
  args: Record<string, unknown>,
): boolean {
  return tool.isConcurrencySafe ? tool.isConcurrencySafe(args) : tool.readOnly;
}

/**
 * Re-read the governor if its files changed on disk, or if `force` says to regardless.
 *
 * Two triggers, and they cover different failures. The STAT check catches a person
 * editing a rule in their editor mid-session — the common case, and the one that used
 * to do nothing at all until restart. The FORCED reload runs after a compaction, which
 * is the natural moment for it: the prompt is being rebuilt from scratch anyway, so it
 * is the point to rebuild what the prompt is made of, and it costs one directory read
 * on an operation that just made a model call.
 *
 * Degrade-safe. Governance is a convenience layer over files that may be mid-write, and
 * an unreadable rules directory must not take the turn down with it — on any failure the
 * session simply keeps the governance it already had.
 */
async function refreshGovernance(session: Session, force = false): Promise<void> {
  try {
    const stamp = await governanceStamp(session.toolContext.cwd);
    // Skipping when the stamp is unchanged is what keeps our OWN writes from causing a
    // reload storm: a governor tool writes the file and mirrors the change into the live
    // object, so the next turn sees a new stamp, reloads once, and reads back exactly
    // what it already had. Cheap and idempotent, but only once.
    if (!force && stamp === session.governanceStamp) return;
    const fresh = await reloadGovernance(session.toolContext.cwd, session.governance);
    session.governance = fresh;
    session.toolContext.governance = fresh;
    session.governanceStamp = stamp;
    // A rule that did not exist when a path was touched never got its chance to fire,
    // so the remembered paths are re-judged against the new list. Additive — a rule
    // already fired stays fired, and one deleted from disk stops rendering because
    // rendering filters by the live rule list.
    if (session.toolContext.ruleScope) rescope(session.toolContext.ruleScope, fresh.rules);
    // The MCP deny-list is pushed into the manager rather than read from governance, so
    // it has to be re-pushed or a tool the user just forbade stays advertised.
    session.toolContext.mcp?.setForbidden(fresh.forbidden.mcpTools ?? []);
  } catch {
    // Keep what we have. See the note above.
  }
}

/**
 * Run one turn, and put planning back afterwards if an approved plan left it.
 *
 * The restore is in a `finally` rather than at the end of the turn because approval
 * grants ONE turn of doing however that turn ends — a step-budget pause, an error, or
 * Esc all have to come back to planning. Leaving it off would strand the session in a
 * mode it was put into by a tool call rather than by the user, and the next request
 * would run unplanned.
 */
export async function respond(session: Session, options: RespondOptions = {}): Promise<string> {
  const finished = await respondTurn(session, options);
  // An approved plan ends when the turn that was carrying it out ends of its own
  // accord — which covers both ways the agreement can finish. Either every step is
  // done, or the model hit something the plan did not survive and stopped to say so,
  // exactly as the plan contract tells it to. In both cases the agreement is spent,
  // and leaving it active is what made a plan approved once bind every later session.
  //
  // An INTERRUPTED turn is the one case that keeps it: the work was cut off rather
  // than concluded, so the next turn should pick it up where it stopped.
  await settlePlanIfFinished(session, options);
  return finished;
}

/**
 * The one message a freshly-cleared session starts from.
 *
 * The plan is repeated in full because it is now the ONLY instruction: the discussion
 * that produced it is gone. The session file is named alongside it so nothing is
 * actually lost — a model that needs an exact snippet or an error string from the
 * planning phase can go and read it, which is cheaper than having carried the whole
 * investigation forward on every request just in case.
 */
function implementFromScratch(priorPath: string, plan: string): string {
  const path = priorPath;
  const where = path
    ? `

If you need something exact from the planning that produced this — a snippet, an ` +
      `error message, a path — the full conversation is at: ${path}`
    : "";
  return `Implement the following plan:

${plan}${where}`;
}

/**
 * Mark an approved plan complete once its work turn has ended.
 *
 * Nothing used to do this. `completePlanArtifact` existed, worked and was tested, and
 * had no caller outside its own test — so `.mindweave/plan.md` stayed active forever,
 * every later session loaded it, and its binding block was injected into every request
 * of unrelated work months later. The suite stayed green because the test proved the
 * function worked, never that anything called it.
 *
 * Degrade-safe: a plan that cannot be marked done is left alone rather than dropped
 * from memory, because the in-memory copy is what governs the current work.
 */
async function settlePlanIfFinished(session: Session, options: RespondOptions): Promise<void> {
  if (!session.toolContext.activePlan) return;
  if (session.toolContext.planMode) return; // still planning: nothing is being carried out
  if (options.signal?.aborted) return; // cut off, not concluded — the next turn continues it
  session.toolContext.activePlan = "";
  session.toolContext.activePlanApprovedAt = undefined;
  try {
    await completePlanArtifact(session.toolContext.roots?.[0] ?? session.cwd);
  } catch {
    // The file stays active; the session no longer injects it either way.
  }
}

async function respondTurn(session: Session, options: RespondOptions = {}): Promise<string> {
  // Make sure the provider serving the selected model is loaded before anything
  // in this turn reaches for it. Cached after the first call, so this is free on
  // every subsequent turn, and it keeps `activeDriver()` safe to call synchronously
  // from here down (including from inside a tool).
  await ensureDriver(session.modelConfig.model);

  // Pick up a governance file the USER edited by hand since the last turn. One stat
  // pass over a few small directories, taken here because a turn is the only moment
  // governance is consulted — so it is fresh exactly where it is used, with no watcher
  // to own, poll or tear down. See refreshGovernance.
  await refreshGovernance(session);

  // Resume an approved plan from disk, once per session (undefined = unchecked).
  // A plan approved last session is still the agreed scope this session — that is
  // the point of it being an artifact — and the user deleting the file (or its
  // status flipping) is a complete off switch, honored here by loading nothing.
  if (session.toolContext.activePlan === undefined) {
    const artifact = await loadPlanArtifact(session.cwd).catch(() => null);
    session.toolContext.activePlan = artifact?.plan ?? "";
    session.toolContext.activePlanApprovedAt = artifact?.approvedAt;
  }
  const planMode = session.toolContext.planMode ?? false;
  // Built-in tools plus whatever the connected MCP servers offer. An MCP tool is
  // dispatched, displayed and gated by exactly the same machinery as a built-in — the
  // merge here and the lookup fallback below are the entire integration.
  let readOnlyTurn = planMode || session.toolContext.readOnlyTools === true;
  // ONE frozen view of the MCP catalog for the whole turn, used for BOTH the advertised
  // list and dispatch. Reading live state twice let a server die (or announce a changed
  // tool list) between the two, so the model could be refused a tool we had just told it
  // it had. It also pins the exact `tools` bytes across the turn's steps, which is what
  // keeps the provider's cached prefix intact while the tool loop runs.
  let mcpTurn = session.toolContext.mcp?.snapshot(readOnlyTurn);
  // Recomputed PER STEP, not once per turn: a large catalog is held behind
  // `find_mcp_tools`, and a tool the model just searched for has to be callable on the
  // very next step or the search was a lie. When nothing is deferred (the common case)
  // this returns identical bytes every step, so the cached prefix is untouched.
  // Rebuilt per step rather than once per turn, because an approved plan LIFTS plan
  // mode mid-turn and the model has to receive the tools it was just granted. When
  // nothing changes this returns identical bytes every step, so the provider's cached
  // prefix is untouched — the same argument that already applies to deferred MCP tools.
  const stepTools = () => {
    const ro = (session.toolContext.planMode ?? false) || session.toolContext.readOnlyTools === true;
    if (ro !== readOnlyTurn) {
      // The MCP catalog is re-snapshotted too, or approving a plan would grant the
      // built-in editing tools while leaving every MCP action hidden until next turn.
      readOnlyTurn = ro;
      mcpTurn = session.toolContext.mcp?.snapshot(ro);
    }
    return [
      ...toolSchemas({
        planMode: session.toolContext.planMode ?? false,
        readOnlyOnly: session.toolContext.readOnlyTools,
        // Lets `relevantWhen` tools (use_skill) check the live session, so a tool with
        // nothing to act on is not advertised and a skill created mid-session brings
        // it back next turn.
        ctx: session.toolContext,
      }),
      ...(mcpTurn?.exposedSchemas() ?? []),
    ];
  };
  const lookup = (name: string) => findTool(name) ?? mcpTurn?.asTool(name);
  const stepLimit = resolveStepLimit(options.maxSteps, process.env["MINDWEAVE_STEP_BUDGET"]);
  // Sinks the spawn_subagent tool reuses (it only ever gets the ToolContext, not the
  // Session): fork a scoped child, forward the child's usage to this turn's meter,
  // and share this turn's abort signal so Esc stops a sub-agent too.
  session.toolContext.forkChild = (task, opts) => forkSession(session, task, opts);
  session.toolContext.reportUsage = (u) => options.onEvent?.({ type: "usage", ...u });
  // The raw event sink, so spawn_subagent can surface a child's nested activity
  // (its lifecycle + tagged tool calls) up this same stream instead of running dark.
  session.toolContext.emitEvent = options.onEvent;
  session.toolContext.abortSignal = options.signal;
  // So a tool can answer "which model are you running" instead of guessing.
  session.toolContext.modelConfig = session.modelConfig;

  // WORKING-DIRECTORY RESET. Each turn starts at the project root — the working
  // directory is already set to the correct project directory automatically. Within a
  // turn cd still persists (so a multi-step command sequence works), but it never
  // carries a stale `cd` into the next
  // turn — the bug where `cd src-tauri` run in two turns became `…/src-tauri/src-tauri`.
  // The primary root (session.cwd) is fixed; only toolContext.cwd moves.
  const leftIn = session.toolContext.cwd;
  session.toolContext.cwdResetFrom = leftIn && leftIn !== session.cwd ? leftIn : undefined;
  session.toolContext.cwd = session.cwd;

  // TASK-BOUNDARY SWEEP. If the previous turn finished a task (a todo list completed)
  // and this new message opens a DIFFERENT one (not a "continue"), close the finished
  // task out now — sweep its tool results and status recaps down hard — so a weaker
  // model can't drift back to already-done work. This is the fix for "the model went
  // back to a task from 6 turns ago." Cheap (no model call); the live working set keeps
  // current file content regardless.
  if (session.taskJustCompleted && !isContinuation(lastUserText(session))) {
    const swept = microcompact(session.transcript, KEEP_LAST_N_BOUNDARY);
    if (swept.cleared > 0 || swept.recapsCleared > 0) {
      session.transcript = swept.entries;
      // Silent by design — closing out a finished task is background housekeeping, not
      // something the user should watch scroll by.
    }
  }
  session.taskJustCompleted = false;

  // SESSION MEMORY. At a natural break (turn start), if the transcript has grown enough
  // since the last refresh, update the maintained "state of this session" notes. They
  // live outside the transcript, so compaction never erodes them — which is what lets a
  // session run indefinitely without slowly losing the thread. One cheap call, gated so
  // it fires rarely; degrade-safe.
  await sweepSessionMemory(session, options);


  // Per-task guards: cost and time ceilings, both opt-in, like the step ceiling above
  // them. Every call's usage is summed so a ceiling reflects the whole task.
  const limits = taskLimits();
  const startedAt = Date.now();
  const usages: Usage[] = [];
  // When each of those calls returned. Recorded as it happens: stamping them when the
  // turn is saved gave every call in a turn the same time, so the call log could not say
  // how a long turn's time was spent (one real session: 145 calls, 4 distinct times).
  const usageTimes: number[] = [];

  // Verification-gate bookkeeping for this turn: did the model change any file,
  // did it ever run a check, and have we already nudged once (one-shot).
  let mutatedThisTurn = false;
  let verifiedThisTurn = false;
  let verifyNudged = false;
  // Re-scope guard: once the model completes a WHOLE todo list, spinning up a
  // fresh one and pressing on within the same turn is self-assigned scope the user
  // never asked for (the "did the task three times" runaway). This flips true when
  // a todo list is fully completed; a new pending list afterward triggers a pause.
  let completedAList = false;
  // Background-poll guard: consecutive steps that did nothing but poll a still-running
  // background shell. Once past the allowance, stop the wait-loop (the model won't
  // stop on the prose nudge alone). Any step that does real work resets it to 0.
  let bgPollStreak = 0;
  // Repeat-failure breaker: consecutive steps that failed the SAME way (identical error
  // signature). A model can grind the same broken command for dozens of steps; once the
  // streak crosses REPEAT_FAIL_LIMIT we interrupt with the fact that it is repeating
  // itself, and only stop the turn if it does it again afterwards. `repeatFailNudged`
  // resets whenever the failure changes, so each distinct loop gets one interrupt.
  // Overflow recovery fires at most once per turn — see the overflow branch below.
  let overflowRecovered = false;
  let repeatFailStreak = 0;
  let repeatFailNudged = false;
  // Single edits per file across the whole turn, and whether the batching reminder has
  // already fired. One reminder per turn: it is a nudge, not a rule to enforce twice.
  const singleEditsByFile = new Map<string, number>();
  let batchEditNudged = false;
  // Narration budget: one nudge per turn, and the turn's earlier prose to compare against.
  let narrationNudged = false;
  const narratedBefore: string[] = [];
  // Judged next to the prose, pushed after the tool results — see the gate below.
  let pendingNarrationFault: ReturnType<typeof narrationFault> = null;
  let lastFailSig: string | null = null;
  let lastFailOutput = "";
  // Reply gate: ONE rewrite per turn. `overlongReplyAt` is where the rejected draft sits
  // in the transcript, so it and its instruction can be spliced back out once the
  // rewrite lands — history should hold what the user actually saw, not the draft.
  let replyRegated = false;
  let overlongReplyAt: number | null = null;
  /** Where a reply given BEFORE the work was checked sits, so it can be removed once the
   *  model concludes again with the check behind it. A turn may only end once. */
  let prematureReplyAt: number | null = null;

  // Seal whatever files this turn edits into one restorable checkpoint (/undo),
  // no matter how the turn ends (finish, pause, interrupt, throw). Labeled with
  // the request that drove it. No-op when nothing was edited.
  const turnLabel = lastUserText(session);
  // Fold this turn's cost into the session total on the way out, however the turn ends.
  // In the `finally` rather than the success path on purpose: an interrupted or failed
  // turn still spent the tokens it spent, and a spend figure that quietly omits the
  // expensive turn you cancelled is worse than none. Undefined when nothing was billed.
  const recordSpend = () => {
    const summary = summarizeTask(usages, session.modelConfig.model);
    if (summary) session.spend = addTurn(session.spend ?? emptySpend(), summary);
    // Keep the PER-CALL split, not just the turn's totals.
    //
    // Because "where did those tokens go?" is the question that keeps getting asked, and
    // a session total cannot answer it. A turn that billed 36K is six calls or one, and
    // a provider that cached 40% did so evenly across every call or completely on three
    // of them — those are different problems with different fixes, and the totals look
    // identical for all of them. Six numbers per call, capped, so a long session cannot
    // grow the meta file without bound.
    session.callLog = [...(session.callLog ?? []), ...usages.map((u, i) => toCallRecord(u, session.modelConfig.model, usageTimes[i]))].slice(-CALL_LOG_LIMIT);
  };
  try {
    const reply = await runTurn();
    // END-OF-TURN sweep. The turn-start check above works one turn behind: it can only
    // see what happened before this turn ran, so a session whose LAST turn did the real
    // work ended with notes that never mentioned it (or none at all). Sweeping here is
    // the "write a note before the session can end" fix, without needing a process-exit
    // hook — a turn boundary is the only moment we reliably get. The token gate means
    // this and the turn-start check can never both fire for the same growth.
    //
    // Deliberately NOT in the `finally`: that path also runs on abort and on throw, and
    // a user pressing Esc should not be charged for a background model call.
    if (!options.signal?.aborted) await sweepSessionMemory(session, options);
    return reply;
  } finally {
    recordSpend();
    const before = session.toolContext.checkpoints?.list().length ?? 0;
    session.toolContext.checkpoints?.seal(turnLabel);
    // Say that a restore point exists. It was made silently, so `/undo` was a feature
    // you had to already know about — and the moment to learn it is the moment there is
    // something to undo, not after you have lost it.
  }

  // The turn's model↔tool loop. Kept as a closure so the try/finally above owns
  // every exit path; it reads the flags/usages declared in the enclosing scope.
  async function runTurn(): Promise<string> {
  // No ceiling means no ceiling: the loop's exits are then its own returns — the model
  // finishing, a stop reason, the repeated-failure breaker, a cost or time ceiling if one
  // is set, and the abort check on the line below. See `resolveStepLimit`.
  for (let step = 0; stepLimit === undefined || step < stepLimit; step++) {
    if (options.signal?.aborted) return interrupted(session);
    // Stop before another (billable) call if a cost/time ceiling is hit — pause
    // losslessly, exactly like the step budget, so the user can raise it and resume.
    const limitReason = taskLimitReason(summarizeTask(usages, session.modelConfig.model), Date.now() - startedAt, limits);
    if (limitReason) return pauseTask(session, options, `hit the ${limitReason}`);
    await maybeCompact(session, options);

    // NO working-set block is built or sent. It used to be: the current contents of
    // every active file, rebuilt each step and injected at the tail — up to 12K tokens
    // re-sent, uncached, on EVERY model call. Nothing about where it sat in the request
    // could fix that, because content is appended to the conversation before it on every
    // step, so prefix caching can never reach it. An eight-step turn paid for it eight
    // times; a forty-step task would pay forty.
    //
    // File contents reach the model the same way every other observation does: as a tool
    // result in the conversation, once, where the append-only shape means the provider
    // caches it and it is never re-billed. Freshness after an edit is a RE-READ problem
    // (read_file returns full content whenever mtime/size moved) rather than a reason to
    // re-send everything continuously.
    //
    // `workingSetFull` / `workingSetSpans` are deliberately left UNSET. Every consumer
    // reads them with `?.`, so they all degrade to "the model has not been shown this",
    // which is now the truth. Leaving them populated would make read_file tell the model
    // a file is already on screen when nothing put it there.
    // The other half of "what can the model still see": full reads still sitting in the
    // transcript. Derived here, AFTER any compaction above, so it can never disagree
    // with the bytes this step is about to send. This is what makes a stored presence
    // bit — and the ledger surgery that used to keep one honest — unnecessary.
    session.toolContext.transcriptFull = fullReadPaths(session.transcript, (p) => {
      try {
        return resolvePath(session.toolContext, p);
      } catch {
        return undefined;
      }
    });

    let result: StreamResult;
    // The transcript half of what we are about to send, measured the same way the
    // compaction bars measure it — so the provider's reported total minus this is the
    // real size of everything else in the prompt.
    const sentTranscriptTokens = estimateEntriesTokens(session.transcript);
    // Every root, not just the primary: a file in a folder added with /include should
    // pick up that folder's notes the same way one in the main project does. Deduped by
    // path, because roots can nest.
    const active = selectActiveFiles(session.toolContext.reads, ACTIVE_FILES_FOR_NOTES).map((a) => a.path);
    const seenNotes = new Set<string>();
    const dirNotes: { path: string; text: string }[] = [];
    for (const root of rootsOf(session.toolContext)) {
      for (const note of await directoryNotesFor(root, active)) {
        if (seenNotes.has(note.path)) continue;
        seenNotes.add(note.path);
        dirNotes.push(note);
      }
    }
    // BACKGROUND EVENTS ARE DRAINED HERE, once per step, and become real transcript
    // entries rather than a list re-attached to every request.
    //
    // The bug this replaces: the drain happened ONCE before this loop and the resulting
    // array was passed to `buildRequest` on every step, so a single "shell #1 exited
    // 101" was appended as a fresh user message dozens of times in one turn. The model
    // answered it every time — correctly, since each time it looked like news — and a
    // real session spent 19 of 37 steps re-explaining one finished command.
    //
    // Draining per step also fixes a second thing quietly: a shell that finishes DURING a
    // turn is now reported at the next step instead of waiting for the turn to end.
    //
    // Pushing into the transcript (rather than attaching to one request) is what makes
    // delivery exactly-once at the consumer as well as the producer: once it is an entry,
    // it is part of the conversation like any other, carried forward without being
    // re-sent. `drainEvents` is already one-shot, so every later step gets an empty list
    // unless something genuinely new happened. Same shape as the ripple note below.
    for (const note of await backgroundEventNotes(session)) {
      session.transcript.push({ role: "user", content: note, synthetic: true });
      await options.persist?.();
    }

    const request = buildRequest(
      session,
      stepTools(),
      await loadImagePayloads(session),
      dirNotes,
    );
    // Did the cacheable prefix survive since the last call? A break re-bills the system
    // prompt and every tool schema at full price, silently — nothing fails, the reply is
    // normal, and the only evidence is the bill. Reported so an UNEXPLAINED one is
    // visible while it is happening, instead of being reconstructed from a session file
    // after the user has paid for it. See dynamo/cacheBreak.ts.
    const print = prefixPrint(session.modelConfig.model, request.system, request.tools ?? [], request.messages);
    const broke = session.prefixPrint ? diffPrefix(session.prefixPrint, print) : null;
    session.prefixPrint = print;
    // Read BEFORE the stamp below, so it is the gap since the previous call rather
    // than zero. A long gap with nothing changed is the provider's cache expiring,
    // which no amount of prefix work would have prevented.
    const sinceLastCall = session.lastCallAt ? Date.now() - session.lastCallAt : null;

    // Shed the oldest whole rounds and retry, ONCE per turn. Shared by both ways a
    // provider can refuse an over-long conversation, because the remedy is identical
    // and having two copies of it is how they drift apart.
    //
    // Whole rounds, because a round is the only split the wire format guarantees is
    // safe: every tool result is resolved before the next assistant turn, so a group
    // starting at an assistant carries its own results. Cutting by entry count can
    // sever a call from its result and turn a request that was merely too long into
    // one that is malformed.
    const shedAndRetry = async (): Promise<boolean> => {
      if (overflowRecovered) return false;
      const shed = dropOldestRounds(session.transcript);
      if (!shed) return false;
      overflowRecovered = true;
      session.transcript = shed;
      await options.persist?.();
      options.onActivity?.("conversation was too long — dropped the oldest turns and retried", {
        context: true,
      });
      return true;
    };

    try {
      // Stamped BEFORE the call, not after: what matters for the cache is when the
      // request was sent, and a long-running turn would otherwise make the gap look
      // shorter than it was.
      session.lastCallAt = Date.now();
      result = await streamModel(request, options);
    } catch (error) {
      if (isAbort(error)) return interrupted(session);
      // The other half of overflow, and the half that used to be fatal. Two of the
      // thirteen providers report an over-long conversation as a finish reason on a
      // successful response, which the branch below already recovers. Every other one
      // REJECTS the request, and a rejection arrives here as a thrown error that
      // `providerError.ts` rightly treats as our bug and surfaces loudly. For length
      // specifically it is not our bug and it is recoverable, so it gets the same
      // remedy rather than ending the turn. See drivers/contextOverflow.ts.
      if (isContextOverflowError(error) && (await shedAndRetry())) continue;
      throw error;
    }
    const { content, toolCalls } = result;
    // Every model call's usage counts toward the task total — a task (one turn)
    // may span several calls across tool rounds, and the UI sums them.
    emitUsage(result, options);
    if (result.usage) {
      usages.push(result.usage);
      usageTimes.push(Date.now());
      writeCacheLog(
        cacheCallLine({
          call: usages.length,
          gapMs: sinceLastCall,
          broke,
          promptTokens: result.usage.promptTokens,
          cacheHitTokens: result.usage.cacheHitTokens,
          model: session.modelConfig.model,
        }),
      );
      // Measure, don't guess. The provider just told us exactly how big the prompt was;
      // subtracting the transcript we measured on the way out leaves the fixed overhead
      // the bars were blind to. Recomputed every call, so it tracks a growing tool
      // catalog or working set instead of being a constant someone chose once.
      if (result.usage.promptTokens > 0) {
        session.contextOverhead = {
          tokens: measuredOverhead(result.usage.promptTokens, sentTranscriptTokens),
          model: session.modelConfig.model,
        };
      }
    }

    // The provider can end a turn for reasons that are NOT "finished answering".
    // Without checking, a reply cut off at the output ceiling looks identical to a
    // complete one and the loop carries on with half an answer.
    if (result.stop && result.stop !== "end") {
      // Overflow is RECOVERABLE, and used not to be. The provider said the conversation
      // no longer fits; the turn then ended and the user was told to compact by hand,
      // mid-task, having already paid for the refused call. Shedding the oldest rounds
      // makes it a hiccup instead of a stop. Once per turn: if it is still too long
      // afterwards, retrying again is a loop and autocompact is the right instrument.
      if (result.stop === "overflow" && (await shedAndRetry())) continue;
      const note = stopReasonNote(result.stop);
      if (content.trim()) session.transcript.push({ role: "assistant", content });
      await options.persist?.();
      return pauseTask(session, options, note);
    }

    // No tool calls → the model is done. Record the reply.
    if (toolCalls.length === 0) {
      session.transcript.push({ role: "assistant", content });
      await options.persist?.(); // durable: the reply is on disk before we return
      // Verification gate: it edited files but never checked them. Nudge once and
      // let it continue — a fact-based reminder, not a decision about the code.
      // Live, not the value captured at the top: an approved plan lifts plan mode
      // mid-turn, and the work that follows has to be verified like any other.
      if (VERIFY_GATE && !session.toolContext.planMode && mutatedThisTurn && !verifiedThisTurn && !verifyNudged) {
        verifyNudged = true;
        prematureReplyAt = session.transcript.length - 1; // the reply pushed just above
        session.transcript.push({ role: "user", content: VERIFY_NUDGE, synthetic: true });
        // The reply that was about to be shown was written before the work was checked,
        // and the model is about to conclude a second time once it has checked. Drop the
        // first, or the user reads both — two closing statements with nothing between
        // them, since the nudge is synthetic and a clean check reports nothing.
        //
        // The reply gate below does exactly this for a draft it rejects. The same applies
        // here for the same reason: a turn ends once, so it may only say so once.
        options.onEvent?.({ type: "replyReset" });
        continue;
      }

      // Reply gate. The prompt has asked for this budget in three wordings and a model
      // mid-flow still answers a finished job with a page, so here it is enforced rather
      // than requested: the draft is rejected, the model rewrites it, and the rewrite is
      // what the user sees. ONE retry — a gate that can fire twice is a loop.
      if (!replyRegated) {
        const fault = replyFault(content, mutatedThisTurn);
        if (fault) {
          replyRegated = true;
          overlongReplyAt = session.transcript.length - 1; // the draft pushed just above
          session.transcript.push({ role: "user", content: replyRewrite(fault), synthetic: true });
          // The draft has been streaming into the UI's buffer, unrendered. Drop it, or
          // the rewrite would append to it and the user would read both.
          options.onEvent?.({ type: "replyReset" });
          continue;
        }
      }
      // The real reply landed. Drop whichever earlier draft was superseded, and the
      // synthetic instruction that asked for this one, so what is saved — and resumed,
      // and compacted — is the answer that was actually given.
      //
      // Highest index first: splicing the earlier one would shift the later one.
      for (const at of [overlongReplyAt, prematureReplyAt].filter((i): i is number => i !== null).sort((a, b) => b - a)) {
        session.transcript.splice(at, 2);
      }
      if (overlongReplyAt !== null || prematureReplyAt !== null) {
        overlongReplyAt = null;
        prematureReplyAt = null;
        await options.persist?.();
      }
      return content;
    }

    // Record the assistant's tool request so the conversation stays well-formed.
    const records: ToolCallRecord[] = toolCalls.map((call) => ({
      ...(call.meta ? { meta: call.meta } : {}),
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
    session.transcript.push({ role: "assistant", content, toolCalls: records });
    // Durable BEFORE running the tools: if the machine dies mid-tool, the resume path
    // sees these dangling tool_calls and reconciles them (reconcileInterruptedTools).
    await options.persist?.();

    // Narration gate, part one: JUDGE here, where this message's prose and the turn's
    // earlier prose are both in hand. Do NOT push anything yet — an assistant message
    // carrying tool_calls must be followed immediately by a tool message per call, and
    // slipping a nudge in between makes the request invalid (DeepSeek 400: "must be
    // followed by tool messages responding to each tool_call_id"). The nudge is queued
    // and pushed after the results land, which is where the other nudges already fire.
    if (!narrationNudged && content.trim()) {
      pendingNarrationFault = narrationFault(content, narratedBefore);
      narratedBefore.push(content);
    }

    // Announce every tool the model chose, in its order, BEFORE running any —
    // the UI's reveal queue paces them and a slow tool (test/run) can show a live
    // "running" state until its end event lands.
    for (const call of toolCalls) {
      options.onEvent?.({ type: "tool", phase: "start", id: call.id, name: call.name, args: parseArgs(call.arguments) });
    }

    // Concurrency-safe calls run in PARALLEL; the rest run one at a time, in order
    // (parallel edits to one file race, and an edit must see the last write). A call
    // is concurrency-safe when the tool says so for THESE args (isConcurrencySafe) —
    // e.g. a read-only sub-agent, which lets the model fan out research — otherwise
    // the default is: read-only ⇒ safe, mutating ⇒ serial.
    const concurrencySafe = (call: (typeof toolCalls)[number]): boolean => {
      const tool = lookup(call.name);
      return tool ? callIsConcurrencySafe(tool, parseArgs(call.arguments)) : false;
    };
    const parallelCalls = toolCalls.filter(concurrencySafe);
    const serialCalls = toolCalls.filter((call) => !concurrencySafe(call));

    const runCall = async (call: (typeof toolCalls)[number]) => {
      // Esc: once the turn is aborted, no further tool may START. The step loop only
      // re-checks BETWEEN steps, so without this gate the rest of a batch still runs
      // after the interrupt — and a `run_in_background` command in that batch would
      // outlive the turn entirely, leaving a process the user thought they cancelled.
      // Placed here, at the single execution choke point, so it covers both the
      // parallel and serial lanes and every tool uniformly.
      if (options.signal?.aborted) {
        return {
          call,
          output: "Not run: the turn was interrupted before this tool started.",
          summary: "interrupted",
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      const tool = lookup(call.name);
      if (!tool) {
        // A name the model invented. The row renders as "Unknown tool(index_results)"
        // (see toolDisplay), and the model gets the near misses so it can correct on
        // the next step instead of guessing again at a bare "unknown tool".
        // Built-ins only: an MCP tool is always `mcp__server__tool`, which is never a
        // near miss for a plain name, so including them would only add noise.
        return { call, output: unknownToolError(call.name, TOOLS.map((t) => t.name)), summary: `unknown tool '${call.name}'`, isError: true, detail: undefined as string | undefined, fullContentOf: undefined as string | undefined };
      }
      // The mirror of the rule below, for tools that exist BECAUSE planning is
      // happening. `planOnly` is only a schema FILTER, so nothing stopped a model from
      // calling one outside plan mode — and exit_plan is read-only, so neither refusal
      // below caught it either. Approving from there set the session up to return to
      // planning at the end of the turn, putting the user in a mode they never chose.
      //
      // It is a real call to make, not a hypothetical: the tool list the model is
      // holding was built at the start of the step, so the step right after approval
      // still has exit_plan in it.
      if (tool.planOnly && !session.toolContext.planMode) {
        return {
          call,
          output:
            `Refused: '${call.name}' is only for ending a planning session, and you are not in plan mode. ` +
            `If your plan was already approved, carry on with the work instead.`,
          summary: `blocked outside plan mode`,
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      // Belt-and-suspenders for plan mode: the schema filter already hides mutating
      // tools, but if the model calls one anyway, refuse it instead of running it.
      // Live, not the captured value. Reading the stale one here would refuse the
      // editing tools the user had just approved, for the rest of the turn.
      if (session.toolContext.planMode && !tool.readOnly) {
        return {
          call,
          output: `Refused: '${call.name}' changes files or state, but you're in plan mode. Present your plan instead; the user will approve and switch out of plan mode to carry it out.`,
          summary: `blocked in plan mode`,
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      // A read-only sub-agent: same schema-hiding + refusal, without the plan framing.
      if (session.toolContext.readOnlyTools && !tool.readOnly) {
        return {
          call,
          output: `Refused: '${call.name}' changes files or state, but this sub-agent is read-only. Report your findings instead.`,
          summary: `blocked (read-only sub-agent)`,
          isError: true,
          detail: undefined as string | undefined,
        };
      }
      // Sentinel mode: confirm every mutating action with the human first. Gated
      // here (the single execution choke point) so it covers every mutating tool
      // uniformly — including subagent edits. Fails safe: no approval channel, or an
      // unclear answer, refuses rather than runs.
      const ctx = session.toolContext;
      if (!tool.readOnly && ctx.guarded && !ctx.guardAllowed?.has(call.name)) {
        const args = parseArgs(call.arguments);
        // The question is one line; WHAT is about to happen rides as detail, which the
        // CLI prints into the transcript. A gate the user cannot read is a gate they
        // learn to wave through.
        const choice = ctx.requestApproval
          ? await ctx.requestApproval(
              guardQuestion(),
              guardOptions(call.name),
              guardDetail(call.name, args),
              "Permission Request",
              GUARD_REFUSAL_INPUT,
            )
          : undefined;
        const decision = interpretGuardChoice(choice, call.name);
        if (decision === "refuse") {
          // A refusal that carries the user's own direction is worth far more than a
          // bare no: it turns a dead end into the next instruction, without costing a
          // round trip to ask what they meant.
          const said = choice ? readFreeText(choice) : null;
          return {
            call,
            output: said ? guardRefusalWith(said) : GUARD_REFUSAL,
            summary: `declined ${call.name}`,
            isError: true,
            detail: undefined as string | undefined,
          };
        }
        // Scoped to this KIND of action, never to everything. See guardOptions.
        if (decision === "allow-kind") {
          ctx.guardAllowed = new Set([...(ctx.guardAllowed ?? []), call.name]);
        }
      }
      // A tool must never be able to unwind the turn by throwing, and this is the only
      // place that can guarantee it.
      //
      // The cost of the gap was out of all proportion to its likelihood. By the time a
      // tool runs, the assistant entry carrying `tool_calls` has been pushed AND
      // persisted, so a rejection escaping here ends the turn with tool calls that have
      // no results. That is not merely a lost turn: the provider requires every
      // tool_call_id to be answered, so EVERY later request in that live session is
      // malformed. The transcript is repaired on load (reconcileInterruptedTools), which
      // means the damage lasts exactly until the user restarts — the worst shape for a
      // fault, because the fix is invisible and the session looks broken.
      //
      // Probed before writing this: all 28 tools were called with five wrong argument
      // types, with no arguments, and with ten Windows path shapes that make `fs` throw
      // (reserved device names, invalid characters, a null byte, an over-long name).
      // Zero threw — every one returned an error result. So this catches nothing today
      // and is deliberately defence in depth: it removes a single point of failure
      // rather than fixing an observed bug, and the next tool added inherits it.
      let result;
      try {
        // A per-call channel, so a tool that runs for minutes can say what it is doing.
        // Scoped to THIS call rather than hung on the shared context, which every tool in
        // the turn holds the same instance of — with two commands in flight there would be
        // no way to tell whose output was whose.
        result = await tool.execute(parseArgs(call.arguments), session.toolContext, {
          progress: (text) => options.onEvent?.({ type: "tool", phase: "progress", id: call.id, text }),
        });
      } catch (error) {
        // An abort is the user, not a fault: let it travel so the loop's own handling
        // reports an interruption instead of a broken tool.
        if (isAbort(error)) throw error;
        return { call, ...toolFailureResult(call.name, error), detail: undefined as string | undefined };
      }
      return {
        call,
        output: result.output,
        summary: result.summary,
        isError: result.isError,
        detail: result.detail,
        detailKind: result.detailKind,
        quiet: result.quiet,
        fullContentOf: result.fullContentOf,
        images: result.images,
        displayKind: result.displayKind,
        displayName: result.displayName,
        awaitsModel: result.awaitsModel,
      };
    };

    // Emit each tool's END the instant IT finishes — not batched after the whole
    // turn — so the UI can resolve that row promptly (and show it already-expanded
    // rather than a header that pops its output in later). Transcript order is still
    // the model's call order (the sort below); only the UI events go out eagerly.
    const runAndEmit = async (call: (typeof toolCalls)[number]) => {
      const r = await runCall(call);
      options.onEvent?.({
        type: "tool",
        phase: "end",
        id: r.call.id,
        name: r.call.name,
        summary: r.summary ?? r.call.name,
        error: r.isError ?? false,
        detail: r.detail,
        ...(r.detailKind ? { detailKind: r.detailKind } : {}),
        ...(r.quiet ? { quiet: true } : {}),
        ...(r.displayKind ? { displayKind: r.displayKind } : {}),
        ...(r.displayName ? { displayName: r.displayName } : {}),
      });
      return r;
    };
    const results = await Promise.all(parallelCalls.map(runAndEmit));
    for (const call of serialCalls) {
      results.push(await runAndEmit(call));
    }
    // Hand results back in the model's original call order (start events were emitted
    // in that order too), no matter which lane each call ran in.
    const callOrder = new Map(toolCalls.map((c, i) => [c.id, i]));
    results.sort((a, b) => (callOrder.get(a.call.id) ?? 0) - (callOrder.get(b.call.id) ?? 0));

    // Track the verification-gate facts: a successful edit/write to a file with a
    // runtime surface counts as a mutation that needs checking — a docs-only edit
    // (MINDWEAVE.md, a README) does NOT, so the gate never fires on it. A diagnostics/
    // build/test check counts ONLY when it PASSED. A failing check (non-zero exit /
    // isError) is not verification — it means work remains, so the gate must stay
    // unsatisfied and nudge again rather than let a red build finish.
    for (const r of results) {
      if (!r.isError && mutationNeedsVerification(r.call.name, parseArgs(r.call.arguments))) mutatedThisTurn = true;
      if (!r.isError && isVerification(r.call.name, parseArgs(r.call.arguments))) verifiedThisTurn = true;
      // A write to MINDWEAVE.md means the frozen copy in the cached system prompt is
      // behind the file. Noted, NOT acted on: re-reading it here would rewrite the
      // system prompt string and throw away the whole cached prefix mid-turn. The
      // model just wrote the content so it already has it; the prefix catches up at
      // the next compaction, where the cache is being discarded anyway.
      if (!r.isError && touchesProjectMemory(r.call.name, parseArgs(r.call.arguments))) {
        session.projectMemoryStale = true;
      }
    }

    for (const result of results) {
      // The end event already went out eagerly (runAndEmit) the moment this tool
      // finished; here we only record it into the transcript, in call order.
      session.transcript.push({
        role: "tool",
        toolCallId: result.call.id,
        content: result.output,
        // Display fields, stored so a resumed session replays the exact same row
        // (summary line + diff/detail). Ignored when building the wire request.
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        // HOW to read `detail`, without which it is only text. A resumed session was
        // storing the diff and losing the fact that it WAS a diff, so every edit came
        // back as dim plain lines — the +/- markers still there, the green and red gone,
        // and shell output without its rail. The row is not the same row without this.
        ...(result.detailKind ? { detailKind: result.detailKind } : {}),
        ...(result.quiet ? { quiet: true } : {}),
        ...(result.displayName ? { displayName: result.displayName } : {}),
        ...(result.displayKind ? { displayKind: result.displayKind } : {}),
        ...(result.isError ? { isError: true } : {}),
        // Presence, as recorded by the tool that knows: this result IS the whole
        // content of that file. Not display — the presence derivation reads it.
        ...(result.fullContentOf ? { fullContentOf: result.fullContentOf } : {}),
      });
    }
    await options.persist?.(); // durable: tool results recorded, transcript well-formed

    // A plan approved with a FRESH CONTEXT. Everything the planning turn accumulated —
    // the files opened to understand the problem, the searches that went nowhere — has
    // done its job, and none of it is needed to carry the plan out.
    //
    // Done HERE, and nowhere else, because this is the one point where the assistant
    // message carrying the exit_plan call and its result can be dropped TOGETHER. A
    // provider requires every tool_call to be answered; cutting the conversation a step
    // earlier or later leaves one without the other and every later request in the
    // session is malformed.
    if (session.toolContext.planFreshStart) {
      const plan = session.toolContext.planFreshStart;
      session.toolContext.planFreshStart = undefined;
      const before = estimateEntriesTokens(session.transcript);
      // The planning conversation is KEPT, under the id it was written with, and the
      // work continues as a new session.
      //
      // A session file is rewritten whole on every persist, so without this the very
      // next save would overwrite the planning transcript with the one message that
      // replaced it — and the pointer in that message would name a file holding nothing
      // but the pointer. The id has to move at exactly this moment, which is why the old
      // path is captured BEFORE the change.
      const priorPath = transcriptPath(session.cwd, session.id);
      session.id = randomUUID();
      session.toolContext.sessionId = session.id;
      session.transcript = [{ role: "user", content: implementFromScratch(priorPath, plan) }];
      // The ledger describes what is on screen, and nothing is any more. Left alone it
      // would tell the model it already holds files that are no longer in front of it —
      // the same lie a compaction used to leave behind.
      session.toolContext.reads.clear();
      // The notes describe a conversation that no longer exists, so they go with it and
      // start again from nothing. REBASED as well as cleared: "should I update the
      // notes" asks how far the transcript has grown SINCE the last update, and leaving
      // that measured against the old long conversation means the difference stays
      // negative and the notes never update again until the new work exceeds the old
      // one. A compaction rebases here for exactly the same reason; it keeps its notes
      // because a summary still describes the work, and this does not.
      session.sessionMemory = "";
      session.sessionMemoryEntries = 0;
      session.sessionMemoryTokens = estimateEntriesTokens(session.transcript);
      session.sessionMemoryInit = false;
      await options.persist?.();
      // Reported through the same channel a compaction uses, because to the user it is
      // the same event: the conversation just got much shorter and they should be told
      // by how much rather than watching it happen silently.
      options.onCompaction?.({
        before,
        after: estimateEntriesTokens(session.transcript),
        window: sharpContextWindow(session.modelConfig.model),
      });
    }

    // Images a tool produced (screenshot) reach the model HERE, as a following user
    // message, rather than inside the tool result. Two reasons, both hard:
    //
    //  1. Wire compatibility. An image inside a tool-result message is fine on
    //     Anthropic and rejected by OpenAI-compatible providers, which is most of
    //     the driver folders. A user message with images is the one shape every
    //     provider already takes — the same path a user's `@file` attachment uses,
    //     so it inherits payload loading, eviction, and token accounting for free.
    //  2. Ordering. Nothing may sit between an assistant's tool_calls and their
    //     results, so this runs after the loop above, where the other queued pushes
    //     already land (a nudge slipped in mid-run once broke every tool-calling
    //     turn on DeepSeek).
    //
    // Whether the picture is SENT or merely named is core's call, made once from a
    // fact the manifest states — a tool never asks which provider is running.
    const shots = results.flatMap((r) => r.images ?? []);
    if (shots.length > 0) {
      const canSee = manifestForModel(session.modelConfig.model).acceptsImages?.(session.modelConfig.model) ?? false;
      const names = shots.map((i) => basename(i.path)).join(", ");
      session.transcript.push({
        role: "user",
        content: canSee
          ? // Not "just captured": view_image opens files that already existed (the user's own
            // screenshots), and saying they were captured tells the model it took them.
            `Here ${shots.length === 1 ? "is the image" : "are the images"} from the tool call above (${names}).`
          : `${names} is ready, but this model cannot see images, so you are ` +
            `being told about it rather than shown it. Describe what you expected to verify ` +
            `and ask the user what they see, or switch to a model with vision using /model.`,
        synthetic: true,
        ...(canSee ? { images: shots } : {}),
      });
      await options.persist?.();
    }

    // Automatic post-edit check. Runs itself rather than relying on the model to call
    // `diagnostics`, because a tool description asking a model to remember is exactly
    // the kind of rule that gets ignored under load — the mechanical version is the one
    // that holds. It also checks the edited files' reverse DEPENDENTS, which is the
    // failure the per-file tool structurally cannot see: a renamed symbol or changed
    // signature breaks the CALLER, in a file nobody thought to check.
    //
    // Recorded as a synthetic user message, the same shape the screenshot block above
    // uses, so it lands after the tool results rather than between a tool_calls message
    // and its results — the ordering that broke every tool-calling turn on DeepSeek once.
    // Silent when it finds nothing: no server, a slow server and an unreadable path all
    // look like "no diagnostics", so an all-clear here would be a claim we cannot make.
    const ripple = await rippleCheck(
      session.toolContext,
      results.map((r) => ({ name: r.call.name, args: parseArgs(r.call.arguments), isError: r.isError })),
      (p) => {
        try {
          return resolvePath(session.toolContext, p);
        } catch {
          return undefined;
        }
      },
    );
    if (ripple) {
      session.transcript.push({ role: "user", content: ripple, synthetic: true });
      await options.persist?.();
    }

    // Re-scope guard. A todo_write that clears the list ("all tasks completed")
    // marks a natural stopping point: the requested work is done. If the model
    // then opens a NEW list of pending work in the same turn, it's taking on scope
    // the user didn't ask for — pause losslessly here and hand the wheel back,
    // rather than letting it rebuild the same thing over and over (a weaker model
    // won't self-stop the way a stronger one does; this is the deterministic
    // backstop for that). The decision is a pure fn (verify.ts) so it's unit-tested.
    const reScope = reScopeCheck(
      completedAList,
      results.map((r) => ({ name: r.call.name, summary: r.summary })),
      session.toolContext.todos,
    );
    completedAList = reScope.completed;
    // Remember, for the NEXT turn's boundary sweep, that a task just finished here.
    session.taskJustCompleted = reScope.completed;
    if (reScope.pause) return pauseReScope(session, options);

    // Background-poll guard. A still-running shell's completion is pushed to the model
    // automatically, so polling it in a loop is pure waste and reads as spam ("still
    // compiling… let me check again", over and over). Allow a single informative poll,
    // then stop the wait-loop here — deterministically, because a weaker model doesn't
    // stop on the prose nudge in the tool result. Nothing is lost: when the shell
    // finishes, backgroundEventNotes wakes the model to report it.
    if (isBackgroundPollStep(results.map((r) => ({ name: r.call.name, summary: r.summary })))) {
      bgPollStreak++;
      if (bgPollStreak > BG_POLL_ALLOWANCE) return pauseForBackgroundPoll(session, options);
    } else {
      bgPollStreak = 0;
    }

    // Repeat-failure breaker. If this step failed exactly the way the last one(s) did —
    // same tools, same error — the model is stuck grinding a broken command instead of
    // changing course. Keyed on the error MESSAGE, so a run of near-identical commands
    // that all fail the same way still trips it.
    //
    // The first trip does NOT end the turn. Nothing in the conversation tells the model
    // it is repeating itself, so ending there would kill it for something it could not
    // see. Instead we inject that fact (with the shell's real cwd, the usual culprit)
    // and let it diagnose. Repeat it after being told and the turn stops for real.
    const failSig = stepFailureSignature(
      results.map((r) => ({ name: r.call.name, output: r.output, isError: !!r.isError })),
    );
    if (failSig) {
      if (failSig === lastFailSig) {
        repeatFailStreak++;
      } else {
        // A different failure is a different loop: it gets its own interrupt.
        repeatFailStreak = 1;
        repeatFailNudged = false;
      }
      lastFailSig = failSig;
      const failed = results.find((r) => r.isError);
      lastFailOutput = failed?.output ?? "";
      const action = repeatFailureStep(repeatFailStreak, REPEAT_FAIL_LIMIT, repeatFailNudged);
      if (action === "stop") return pauseForRepeatedFailure(session, options, lastFailOutput);
      if (action === "nudge") {
        repeatFailNudged = true;
        const failedLabel = failed
          ? failedActionLabel(failed.call.name, parseArgs(failed.call.arguments))
          : "the same step";
        // A repeat failure DURING an approved plan is the mechanical divergence
        // signal: the agreed step is not working. The interrupt then orders a stop
        // and a return to planning, never a sideways improvisation — that is the
        // plan contract, enforced at the one point the engine can detect it.
        const inApprovedWork =
          !!session.toolContext.activePlan && !(session.toolContext.planMode ?? false);
        session.transcript.push({
          role: "user",
          content: inApprovedWork
            ? planDivergenceStop(failedLabel)
            : repeatFailureNudge({
                attempts: repeatFailStreak,
                action: failedLabel,
                error: firstErrorLine(lastFailOutput),
                // Only when `cd` has actually moved us — otherwise it's noise.
                cwd: session.toolContext.cwd !== session.cwd ? session.toolContext.cwd : undefined,
              }),
          synthetic: true,
        });
        await options.persist?.();
      }
    } else {
      repeatFailStreak = 0;
      lastFailSig = null;
      repeatFailNudged = false;
    }

    // Batching gate: it keeps editing ONE file a single change at a time, where one
    // edit call belonged. Mechanical rather than a line in the tool description,
    // because the same task with the same descriptions routes correctly on one run and
    // not the next — prose biases a choice, it cannot make it hold, and this has to hold
    // on every provider. Nudge once and let the turn continue; nothing is blocked, since
    // the edits themselves are perfectly valid.
    // Narration gate, part two: the results are in, so the transcript is valid again
    // and the queued nudge can land. One per turn; nothing is blocked and nothing the
    // user already read is rewritten behind them.
    if (!narrationNudged && pendingNarrationFault) {
      narrationNudged = true;
      session.transcript.push({ role: "user", content: narrationNudge(pendingNarrationFault), synthetic: true });
      pendingNarrationFault = null;
      await options.persist?.();
    }

    if (!batchEditNudged) {
      for (const [path, n] of sameFileEditCounts(
        results.map((r) => ({ name: r.call.name, args: parseArgs(r.call.arguments) })),
      )) {
        singleEditsByFile.set(path, (singleEditsByFile.get(path) ?? 0) + n);
      }
      const overused = overusedSingleEdits(singleEditsByFile);
      if (overused) {
        batchEditNudged = true;
        session.transcript.push({
          role: "user",
          content: batchEditNudge(overused, singleEditsByFile.get(overused) ?? 0),
          synthetic: true,
        });
        await options.persist?.();
      }
    }

    // ── The user typed while this was running ────────────────────────────────
    //
    // LAST in the round, and that placement is the design. The tool results are all
    // recorded, so the conversation is well-formed and a user message may follow it —
    // one arriving between a call and its result is malformed and every provider
    // rejects it. Being last also puts the person's words closest to the next call,
    // which is where a change of course has to be read.
    //
    // Only reached on a round that ran tools. A round where the model answered instead
    // returns above, and the turn is over: what is queued then is not a steer, it is the
    // next request, and the caller sends it as one.
    if (options.steer) {
      let arrived: SteeredMessage[] = [];
      try {
        arrived = await options.steer();
      } catch {
        // Resolving an attachment can fail (a dropped file deleted since it was typed).
        // The turn is not the place to die for it: the message stays queued and the
        // caller sends it at the end, where it can report the fault to the user.
        arrived = [];
      }
      for (const message of arrived) {
        session.transcript.push({
          role: "user",
          content: message.content,
          arrival: "steered",
          ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
        });
      }
      if (arrived.length > 0) await options.persist?.();
    }
  }

  // A ceiling was set and has been reached without the model finishing. Reached only in
  // that case: with no ceiling the loop condition never ends it.
  //
  // Don't spend another call forcing a (misleading) wrap-up the way a tools-off final
  // turn would — that reads as "done" when it isn't. Pause cleanly instead: the
  // transcript, task list, and working set are all intact, so telling Mindweave to
  // continue resumes exactly here with nothing lost, and the user stays in control of
  // the spend.
  return pauseTask(session, options, `reached the step budget of ${stepLimit} tool steps in one turn`);
  }
}

/** The most recent user request in the transcript, clipped — labels a checkpoint. */
function lastUserText(session: Session): string {
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const e = session.transcript[i]!;
    if (e.role === "user") {
      const oneLine = e.content.replace(/\s+/g, " ").trim();
      return oneLine.length > 60 ? oneLine.slice(0, 57) + "…" : oneLine;
    }
  }
  return "(edits)";
}

/**
 * End the turn with a message, recording it AND putting it on the wire.
 *
 * The emit is the point. A normal reply reaches the screen as `text` events while
 * the model streams it; a pause message is composed here, after streaming, so it
 * has no such path of its own. Without this the transcript and the next model turn
 * both get the explanation while the user gets a turn that just ends, blank — which
 * is exactly how a tripped guard came to look like a crash.
 *
 * respond()'s return value is deliberately not what the UI renders: sub-agents call
 * respond() directly and use the return as their report, with no UI attached at all.
 */
function endTurnWith(session: Session, options: RespondOptions, msg: string): string {
  session.transcript.push({ role: "assistant", content: msg });
  options.onEvent?.({ type: "text", delta: msg });
  return msg;
}

/** Lossless hand-back when the model finishes its task list and then starts a new
 *  one in the same turn (the re-scope guard) — a natural checkpoint to let the user
 *  steer instead of the model taking on scope it wasn't asked for. */
function pauseReScope(session: Session, options: RespondOptions): string {
  return endTurnWith(
    session,
    options,
    "(I've finished the task list for what you asked. I have ideas for taking it " +
      "further, but I've stopped here so you can steer — rather than piling on new scope " +
      'on my own. Tell me which direction you want, or say "keep going" to continue.)',
  );
}

/** Lossless stop when the model is stuck polling a still-running background shell.
 *  The shell's completion is pushed to the model automatically, so there's nothing
 *  to do but wait — end the turn cleanly instead of looping "still running" checks.
 *  Deliberately worded as a status line to the user, not a "paused" apology. */
function pauseForBackgroundPoll(session: Session, options: RespondOptions): string {
  return endTurnWith(
    session,
    options,
    "It's still running in the background. I'll stop checking and let you know as soon " +
      "as it finishes — no need to keep watching.",
  );
}

/** Lossless stop when the model repeats the same failing step even AFTER being told it is
 *  looping (the breaker's second tier). By this point it has had the error, the repeat
 *  count, and its real working directory, and it still hasn't moved — so hand the wheel
 *  to the user rather than spend more steps on it. */
function pauseForRepeatedFailure(session: Session, options: RespondOptions, errorOutput: string): string {
  return endTurnWith(
    session,
    options,
    `I've hit the same failure several times in a row and I'm not making progress, so I've ` +
      `stopped rather than retry the same thing again. The error was:\n\n${firstErrorLine(errorOutput)}\n\n` +
      `Tell me how you'd like to proceed, or I can try a different approach.`,
  );
}

/** Record and return a clean, lossless pause reply (well-formed transcript) when a
 *  guard trips — step budget or a cost/time ceiling. Saying "continue" resumes. */
function pauseTask(session: Session, options: RespondOptions, reason: string): string {
  return endTurnWith(
    session,
    options,
    `(Paused — ${reason}. The task isn't finished, but nothing is lost: your progress, ` +
      `edits, and task list are saved. Say "continue" to pick up exactly where I left off.)`,
  );
}

/**
 * Plain-language reason a turn ended early, for the pause message. Kept here (not
 * in a driver) because it's user-facing copy: every provider maps its own
 * vocabulary onto the shared StopReason, and the wording is the same either way.
 */
export function stopReasonNote(stop: Exclude<StopReason, "end">): string {
  switch (stop) {
    case "truncated":
      return "the model hit its output limit mid-answer, so the reply above is incomplete";
    case "refused":
      return "the provider's safety filter declined this request";
    case "overflow":
      return "the conversation no longer fits the model's context window";
    case "overloaded":
      return "the provider's infrastructure cut the request off before it finished, so the reply above is incomplete";
  }
}

/** One streaming model call: forwards the model's reasoning/answer deltas to the
 *  UI as engine events, and returns the assembled turn (content + tool calls +
 *  usage) for the loop to record. */
function streamModel(request: ModelRequest, options: RespondOptions): Promise<StreamResult> {
  return activeDriver().streamTurn(request, {
    signal: options.signal,
    onEvent: (e) => {
      if (e.type === "reasoning") options.onEvent?.({ type: "reasoning", delta: e.delta });
      else if (e.type === "text") options.onEvent?.({ type: "text", delta: e.delta });
      // tool_start / tool_args deltas are not forwarded: the engine emits richer
      // tool events (with parsed args + result summary) around execution instead.
    },
  });
}

/**
 * How many calls of per-call usage a session keeps. Enough to cover any turn anyone
 * would investigate, bounded so the meta file cannot grow with session length.
 */
const CALL_LOG_LIMIT = 200;

/** One call's usage, flattened for the session file. Exported so the recording is
 *  testable on its own — persisting a hand-built record proves nothing about what the
 *  engine actually writes. */
export function toCallRecord(u: Usage, model: string, at: number = Date.now()): import("../memory/types.js").CallUsage {
  return {
    at,
    prompt: u.promptTokens,
    hit: u.cacheHitTokens,
    miss: u.cacheMissTokens,
    out: u.completionTokens,
    model,
  };
}

/** Report a turn's token usage to the UI, if the provider returned it. */
function emitUsage(result: StreamResult, options: RespondOptions): void {
  if (result.usage) {
    options.onEvent?.({ type: "usage", ...result.usage });
  }
}

/**
 * Run the compaction cascade if the transcript has grown enough: microcompact
 * (lossless) first, then autocompact (a summary) if still over the higher bar.
 */
/**
 * Refresh the maintained "state of this session" notes if the transcript has grown
 * enough since the last refresh. They live outside the transcript, so compaction never
 * erodes them — which is what lets a session run indefinitely without losing the thread,
 * and what a later `read_session` reads to answer "what did we do last time".
 *
 * Called at BOTH turn start (so this turn's context carries current notes) and turn end
 * (so the last turn of a session is never missing from them). One cheap call, token-gated
 * so it fires rarely and never twice for the same growth. Silent by design: this is
 * background machinery, not something the user watches. Degrade-safe — a failed update
 * keeps the last good notes.
 */
async function sweepSessionMemory(session: Session, options: RespondOptions): Promise<void> {
  // Not for a sub-agent. The notes exist so the MAIN conversation survives being
  // summarised; a child's transcript is thrown away whole the moment it reports back, so
  // there is nothing for them to carry. Writing them costs a real model call on the
  // user's key with the child's whole recent transcript as input — measured: a 20-step
  // research worker reaches the threshold at ~9.8K tokens, and a five-way fan-out paid
  // that five times, for notes nothing ever read. The child does not even persist them.
  if ((session.toolContext.subagentDepth ?? 0) > 0) return;
  const grown = shouldUpdateSessionMemory(
    estimateEntriesTokens(session.transcript),
    session.sessionMemoryTokens ?? 0,
    session.sessionMemoryInit ?? false,
  );
  if (!grown) return;
  await updateSessionMemory(session);
  await options.persist?.(); // durable: the notes sidecar is written by the persister
}

/**
 * How much of the context window is in use, in tokens.
 *
 * ONE definition, because two would be worse than none: the compaction thresholds fire
 * on this number and the bars shown to the user are drawn from it, so if the estimate
 * is off, the display is wrong in exactly the way the decision was — rather than
 * disagreeing with the machinery it is supposed to explain.
 *
 * Everything outside the transcript counts too, because this is about how full the
 * CONTEXT is, not how long the transcript is. Once a call has reported usage we know
 * that overhead exactly (system prompt + every tool schema + working set + relevance
 * map + todos + governor); until then, fall back to the one piece we could always
 * estimate. MCP schemas are inside the measured figure, so they are only added in the
 * fallback — counting both would double them.
 *
 * A measurement taken on a DIFFERENT model does not transfer: switching provider
 * changes the tool-schema serialisation and the prompt shape. Falling back is the safe
 * direction — it under-counts for one call, which fires the bars early rather than
 * late, and the next call re-measures.
 */
export function contextUsed(session: Session): number {
  const measured = session.contextOverhead;
  const overhead =
    measured && measured.model === session.modelConfig.model
      ? measured.tokens
      : (session.toolContext.mcp?.estimatedTokens() ?? 0);
  return estimateEntriesTokens(session.transcript) + overhead;
}

async function maybeCompact(session: Session, options: RespondOptions): Promise<void> {
  const model = session.modelConfig.model;
  // Model-anchored bars (env still overrides), so the thresholds are right per model
  // instead of a fixed number — and a longer/stronger model automatically gets more room.
  const microBar = envInt("MINDWEAVE_MICROCOMPACT_TOKENS", microCompactThreshold(model));
  const autoBar = envInt("MINDWEAVE_AUTOCOMPACT_TOKENS", autoCompactThreshold(model));

  // MCP tool schemas are sent on every turn but live OUTSIDE the transcript, so the bars
  // could not see them: a 30K-token catalog meant the model was 30K deeper into its real
  // context than this arithmetic believed, and every threshold fired that much too late.
  // Counting it here restores the meaning of the bars — they are about how full the
  // context is, not how long the transcript is.
  // Everything outside the transcript counts too, because the bars are about how full
  // the CONTEXT is, not how long the transcript is. Once a call has reported usage we
  // know that overhead exactly (system prompt + every tool schema + the working set
  // block + relevance map + todos + governor); until then, fall back to the one piece
  // we could always estimate. MCP schemas are inside the measured figure, so they are
  // only added in the fallback — counting both would double them.
  //
  // A measurement taken on a DIFFERENT model does not transfer: switching provider
  // changes the tool-schema serialisation and the prompt shape. Falling back is the
  // safe direction — it under-counts for one call, which fires the bars early rather
  // than late, and the next call re-measures.
  const used = () => contextUsed(session);

  // Two reasons to microcompact, not one. The bar is about context PRESSURE; the cold
  // check is about the cache being gone, which removes the only argument for waiting.
  // See `cacheLikelyCold` — on a warm cache this rewrite costs a 1.25x prefix rebuild,
  // and once the entry has expired it costs nothing at all.
  const cold = cacheLikelyCold(session.lastCallAt ?? 0, Date.now(), used(), microBar);
  if (used() >= microBar || cold) {
    // Assigned unconditionally, on purpose. Gating this on a hand-picked subset of the
    // counters meant a pass that only cleared edit INPUTS or only evicted IMAGES did the
    // work and then threw the result away, and every new kind of clearing had to
    // remember to add itself here or be silently discarded. `microcompact` already
    // returns a copy when it changed nothing, so taking the result always is both
    // correct and the shape that cannot rot.
    // NO superseded set is passed any more. It used to name the files <working_files>
    // was carrying whole, whose transcript copies were then redundant and safe to clear
    // even inside the protected recent window. With that block gone the transcript is
    // the ONLY place those contents exist, so clearing them would delete the model's
    // single copy while nothing put it back — the exact context-that-lies failure
    // removing the block was meant to end.
    // PROPOSED, not applied. Clearing a tool body rewrites the transcript, and the
    // transcript is the cached half of the request — so a clear that reclaims a little
    // is not a small win, it is a loss: the remaining prefix gets rewritten at 1.25x
    // instead of read at 0.1x, and the break-even can run past a hundred steps. The
    // arithmetic lives in `clearIsWorthIt`; here we simply measure what this particular
    // clear would reclaim and let it decide.
    const proposed = microcompact(session.transcript).entries;
    const before = estimateEntriesTokens(session.transcript);
    const after = estimateEntriesTokens(proposed);
    if (clearIsWorthIt({ before, after, cold, autoBar })) {
      session.transcript = proposed;
      // Silent by design — trimming stale context is background machinery.
    }
  }

  if (used() < autoBar) return;

  // Circuit-breaker: once autocompact has failed MAX_COMPACT_FAILURES times this
  // session, stop trying (the transcript is likely irrecoverable) rather than burning
  // a doomed summarizer call every turn.
  if ((session.compactFailures ?? 0) >= MAX_COMPACT_FAILURES) {
    // Giving up SILENTLY was the real defect here. The breaker stopped the runaway
    // retries it was built for and then left the session running unmanaged, past the
    // bar, with nothing on screen to say so — so the user's next clue was a provider
    // error they had no way to connect to compaction. Told once, not per step.
    if (!session.compactGaveUpTold) {
      session.compactGaveUpTold = true;
      options.onActivity?.(
        `compaction failed ${MAX_COMPACT_FAILURES} times and has stopped retrying — ` +
          `context will keep growing. /compact to try again, or start a new session.`,
        { context: true },
      );
    }
    return;
  }

  await autocompact(session, options);
}

/**
 * Force a full summarizing compaction now (the `/compact` command), regardless
 * of size. Safe on a short transcript — it just summarizes what's there.
 */
export async function compactNow(session: Session, options: RespondOptions = {}): Promise<void> {
  // Clear the stale tool bodies BEFORE summarizing. The summarizer is billed on what it
  // is shown, and a transcript full of superseded file dumps costs real money to have
  // condensed into one line of "we read some files". The automatic path already does
  // both in order; the manual one used to jump straight to the expensive half.
  //
  // Unconditional, unlike the automatic pass: `clearIsWorthIt` weighs a clear against
  // the cache rewrite it causes, and a compaction is about to discard that cache
  // anyway, so the argument for holding back does not apply here.
  session.transcript = microcompact(session.transcript).entries;
  await autocompact(session, options);
}

/**
 * Replace the old prefix of the transcript with a summary and keep the last N turns
 * verbatim.
 *
 * Two ways to get that summary, cheapest first. The session notes are tried before the
 * summarizer, because they already ARE a maintained record of the session and cost
 * nothing; only when they are missing, empty or too stale to cover the prefix is a
 * model call spent. See `memory/sessionMemoryCompact.ts`.
 *
 * The summarizer call is sized to fit by construction rather than by luck: the auto bar
 * is the window minus the driver's declared output reserve minus turn headroom, so a
 * transcript that has just crossed it, plus the reserve the reply needs, still sits
 * inside the window. Verified across every model in the registry, not assumed. (This
 * comment previously justified the same thing with "DeepSeek's 1M window" and a 90K
 * trigger, both of which stopped being true when the bars became model-anchored and the
 * driver lineup grew past two.)
 */
async function autocompact(session: Session, options: RespondOptions): Promise<void> {
  if (session.transcript.length === 0) return;
  // Measured BEFORE the summarizer runs, with the same arithmetic the thresholds use,
  // so the bar the user sees is the number the system actually acted on.
  const before = contextUsed(session);

  const fail = (why: string) => {
    // Keep the full transcript rather than lose it, and count the failure so the
    // circuit-breaker can stop retrying a doomed compaction. EVERY rejection counts,
    // not just a thrown error: a summarizer that keeps returning something unusable
    // burns a model call on every step forever, which is the exact runaway the
    // breaker exists to stop.
    session.compactFailures = (session.compactFailures ?? 0) + 1;
    // And SAY so. A compaction that silently does not happen leaves the session
    // running past its bar with no sign anything is wrong; the user cannot ask for
    // /compact, or start a fresh session, over a problem nobody mentioned.
    options.onActivity?.(
      `compaction did not succeed (${why}) — the conversation was kept intact, ` +
        `attempt ${session.compactFailures} of ${MAX_COMPACT_FAILURES}`,
      { context: true },
    );
  };

  // Free first. The notes are a structured, continuously-refreshed record of this
  // session maintained outside the transcript, which is very nearly what the
  // summarizer is about to be paid to produce. When they are current enough to cover
  // the prefix being dropped, spending a model call buys something already owned.
  // Declines rather than approximates: stale or empty notes fall through.
  const fromNotes = compactFromSessionMemory(
    session.transcript,
    session.sessionMemory,
    session.sessionMemoryEntries,
    envInt("MINDWEAVE_AUTOCOMPACT_TOKENS", autoCompactThreshold(session.modelConfig.model)),
    contextUsed(session) - estimateEntriesTokens(session.transcript),
  );
  if (fromNotes) {
    session.transcript = fromNotes.entries;
    // The notes now describe everything before the tail they were spliced in front of.
    session.sessionMemoryEntries = 1;
    session.sessionMemoryTokens = estimateEntriesTokens(session.transcript);
    await finishCompaction(session, options, before);
    return;
  }

  let summary: string;
  try {
    // Summaries don't need reasoning — use the chosen model with thinking off.
    const turn = await activeDriver().toolTurn({
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${formatTranscriptForSummary(session.transcript)}\n\n${summaryRequest(options.compactFocus)}`,
        },
      ],
      model: { ...session.modelConfig, thinking: false },
    });
    // The reply is untrusted: a cut-off or all-scratchpad summary must not be allowed
    // to replace the conversation. See usableSummary.
    // Compaction is not free, and the user did not ask for it. Reporting its usage
    // is what keeps the meter honest: a turn that happened to trip the bar spends
    // a whole extra summarisation call, and leaving that out made the figure short
    // by exactly the work nobody could see.
    if (turn.usage) options.onEvent?.({ type: "usage", ...turn.usage });
    const usable = usableSummary(turn.content, turn.stop);
    if (!usable) return void fail(turn.stop && turn.stop !== "end" ? `the summary came back ${turn.stop}` : "the summary was unusable");
    summary = usable;
  } catch (error) {
    return void fail(providerMessage(detailOf(error)) || "the summarizer call failed");
  }

  // A summary replaces the transcript prefix, so file contents read before it are gone.
  // Nothing re-injects them: the working-set block that used to do so was removed for
  // costing up to 12K per model call. The model re-reads what it still needs, which
  // read_file allows because the summary also clears the presence set the dedup checks.
  session.transcript = spliceSummary(session.transcript, summary, KEEP_LAST_N);
  // The notes no longer describe the transcript they were measured against, and the
  // summary now covers everything before the kept tail.
  session.sessionMemoryEntries = 1;
  session.sessionMemoryTokens = estimateEntriesTokens(session.transcript);
  await finishCompaction(session, options, before);
}

/**
 * The half of a compaction that is the same however the new transcript was produced.
 *
 * Shared by the summarizer path and the session-notes path deliberately: every one of
 * these steps is a consequence of "the transcript was just rewritten", not of how it
 * was rewritten, and the two paths silently disagreeing about which of them ran is a
 * defect that would only show up as an unexplained cache warning or a stale memory
 * file weeks later.
 */
async function finishCompaction(session: Session, options: RespondOptions, before: number): Promise<void> {
  session.compactFailures = 0; // a clean compaction resets the breaker

  await restoreAfterCompaction(session);

  // Re-read the governor unconditionally here. The prompt is being rebuilt from scratch
  // at this point, so it is the natural moment to rebuild what it is made of — and it is
  // the one path that does not depend on the stat check being right about anything.
  await refreshGovernance(session, true);

  // Report it. Compaction is the one context operation worth showing: it REWRITES the
  // conversation, so a user who is not told will later wonder why the model forgot the
  // middle of it. Reported for the automatic pass as well as `/compact`.
  options.onCompaction?.({
    before,
    after: contextUsed(session),
    window: sharpContextWindow(session.modelConfig.model),
  });

  // The prefix we are about to send bears no resemblance to the last one, and that is
  // the POINT rather than a problem. Dropping the stored print means the next step has
  // nothing to diff against and stays quiet, instead of announcing a cache reset the
  // user cannot act on and did not cause. Only an UNEXPLAINED break is worth a line.
  session.prefixPrint = undefined;

  // A compaction rewrites the transcript, so any MINDWEAVE.md edit the model was
  // relying on having written is now summarized away — and the prompt cache is being
  // discarded for this request regardless. Both reasons point the same way: this is
  // the moment to pick the file back up, and it costs nothing extra here.
  await reloadProjectMemory(session).catch(() => {});
}

/**
 * Reconcile the read ledger with the transcript, and put the working files back.
 *
 * Order matters and is the whole design. The ledger is SNAPSHOTTED, then CLEARED, then
 * repopulated only by the files actually restored — so afterwards it describes exactly
 * what the model can see, no more. Clearing is the correctness half and it happens
 * whether or not a single byte is restored: `ctx.reads` survives a compaction that
 * deleted the contents it describes, and a read-before-edit gate consulting a stale
 * ledger tells the model it has a file that is no longer on screen.
 *
 * Restoring is the smoothness half and is allowed to fail quietly. A file that has been
 * deleted, or grown past its share of the budget, simply is not put back; the model
 * reads it again, which is exactly what it would have done anyway.
 */
async function restoreAfterCompaction(session: Session): Promise<void> {
  const ctx = session.toolContext;
  const reads = ctx.reads;
  if (!reads || reads.size === 0) return;

  const snapshot = new Map(reads);
  // Nothing is carried forward for rule scoping any more. A scoped rule records that it
  // FIRED at the moment a matching path was touched, and that name is never removed —
  // so a compaction, which is only about what is on screen, cannot un-apply it. The
  // earlier fix copied every path forward to re-derive the same answer every step.
  // The correctness half. Unconditional, and before anything that can throw.
  reads.clear();

  const budget = restoreBudgetFor(
    envInt("MINDWEAVE_AUTOCOMPACT_TOKENS", autoCompactThreshold(session.modelConfig.model)),
  );
  if (budget <= 0) return;

  // What the kept tail still shows. Re-sending a file the model can already see costs
  // its full length and buys nothing.
  const visible = fullReadPaths(session.transcript, (p) => {
    try {
      return resolvePath(ctx, p);
    } catch {
      return undefined;
    }
  });

  const picked = selectForRestore(snapshot, visible, (path) =>
    // MINDWEAVE.md is reloaded from disk by `reloadProjectMemory` on this same path, so
    // restoring it here would put the same bytes in twice.
    /(^|[\\/])MINDWEAVE\.md$/i.test(path),
  );
  if (picked.length === 0) return;

  const restored: { path: string; content: string }[] = [];
  let spent = 0;
  for (const { path } of picked) {
    if (spent >= budget) break;
    try {
      const stat = await fsp.stat(path);
      // Cheap pre-filter on BYTES before reading: a file far past its share should not
      // be pulled into memory only to be discarded.
      if (estimateTokensForChars(stat.size) > Math.min(RESTORE_MAX_TOKENS_PER_FILE, budget - spent)) continue;
      const content = await fsp.readFile(path, "utf8");
      if (!content.trim()) continue;
      const cost = estimateTokens(content);
      // A file that would bust the remaining budget is skipped rather than truncated:
      // half a file restored under a heading that says "the file you were working in"
      // is the context-that-lies failure this whole path exists to end.
      if (spent + cost > budget) continue;
      restored.push({ path, content });
      spent += cost;
      // The ledger may claim this file again, because the model can now genuinely see
      // it. Recorded from the CURRENT stat, so the freshness gate compares against what
      // was just read rather than what was read before the compaction.
      const record = snapshot.get(path);
      reads.set(path, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        full: true,
        touchedAt: Date.now(),
        ...(record?.focus ? { focus: record.focus } : {}),
      });
    } catch {
      /* a file that cannot be read now is simply not restored */
    }
  }
  if (restored.length === 0) return;

  // Placed immediately after the summary rather than at the end. Both positions render
  // as a user message and the codebase already emits consecutive ones (background
  // events do), but index 1 is the only position that cannot interact with tool
  // pairing in the kept tail no matter what the tail happens to end with.
  session.transcript.splice(1, 0, { role: "user", content: renderRestored(restored), synthetic: true });
}

/**
 * Did this call write the project's MINDWEAVE.md?
 *
 * Matched on the path's basename rather than resolved against the session root: the
 * model may pass it relative, absolute, or through a workspace root, and the cost of a
 * false positive is one extra re-read at the next compaction, while the cost of a false
 * negative is a stale project memory carried into the next session.
 */
export function touchesProjectMemory(name: string, args: Record<string, unknown>): boolean {
  if (name !== "edit" && name !== "write_file" && name !== "replace_symbol_body") return false;
  const path = typeof args.path === "string" ? args.path : "";
  return /(^|[\\/])MINDWEAVE\.md$/i.test(path.trim());
}

/** Parse a tool call's raw JSON arguments; malformed payload → {} so the tool
 *  returns its own clear error rather than crashing the loop. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
