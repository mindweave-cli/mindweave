/**
 * subagent.ts — spawn_subagent: delegate a bounded task to a scoped child agent.
 *
 * The context-isolation lever, orchestrator-worker style. A wide search or a
 * self-contained chunk of work can cost dozens of tool rounds whose intermediate
 * output would bloat the main agent's context. spawn_subagent runs that work in a
 * CHILD session — its own transcript, its own read ledger, its own step budget — and
 * returns only the child's final, distilled summary. The lead agent gets the answer
 * without the mess, and can spawn SEVERAL read-only workers in ONE message to fan out
 * in parallel (the engine runs concurrency-safe calls together).
 *
 * It reuses the engine's own `respond()` loop on a forked session (via `ctx.forkChild`,
 * injected by the engine), so a sub-agent is a full agent, not a lesser one. Recursion
 * is capped by `subagentDepth` so a sub-agent can't spawn its own sub-agents.
 *
 * A child CANNOT reach the user. It has no approval channel, and nothing the user
 * granted in person — a Sentinel allowance, a folder they let the agent write to, the
 * plan they approved — comes with it. So under Sentinel a child's mutating tools are
 * REFUSED rather than prompted, and it reports back instead. That is the failing
 * direction to pick: the alternative is a question on screen from an agent the user
 * never saw start, or worse, an action taken on a permission they gave for something
 * else. `read_only` restricts a child to searching/reading for safe research tasks —
 * and ONLY a read-only worker is concurrency-safe (an editing worker runs alone, in
 * order, so parallel edits can't race). A process-wide semaphore bounds how many run
 * at once.
 */
import { randomUUID } from "node:crypto";
import { STATUS_INSTRUCTION, renderVerdict, verifySubagentReport } from "./subagentReport.js";
import { VERDICT_INSTRUCTION, VERIFIER_PROMPT, parseVerdict, renderVerdict as renderVerdictLine, type VerdictReport } from "./verifyReport.js";
import { verifierOutcome, workerOutcome } from "./subagentOutcome.js";
import { verifyWithGuards } from "./verifierRun.js";
import { reportOf } from "./childReport.js";
import type { Tool, ToolResult } from "./types.js";
import type { EngineEvent } from "../dynamo/engine.js";
import { fail, failQuietly } from "./results.js";
import { DEFAULT_LIMITS, closeInbox, delegationLine, openInbox, takeInbox, newDelegation, noteSpawn, normalizeScope, refuseSpawn, scopeLocks, type DelegationLimits } from "./delegation.js";

const MAX_SUBAGENT_DEPTH = 1;
/** Default step budget for a worker; the caller can scale it with `max_steps`. */
const SUBAGENT_BUDGET = envInt("MINDWEAVE_SUBAGENT_BUDGET", 20);
/** A verifier runs things, one call at a time, so it needs more than a reader does. */
const VERIFIER_BUDGET = envInt("MINDWEAVE_VERIFIER_BUDGET", 40);
/** Ceiling on `max_steps` so one worker can't run away. */
const MAX_SUBAGENT_STEPS = envInt("MINDWEAVE_SUBAGENT_MAX_STEPS", 60);
/** How many workers may run concurrently, process-wide. */
const SUBAGENT_CONCURRENCY = envInt("MINDWEAVE_SUBAGENT_CONCURRENCY", DEFAULT_LIMITS.concurrent);
/** What one turn may hand to workers in all (see delegation.ts): how many, and how many steps between them. */
const LIMITS: DelegationLimits = {
  concurrent: SUBAGENT_CONCURRENCY,
  perTurn: envInt("MINDWEAVE_SUBAGENT_MAX_PER_TURN", DEFAULT_LIMITS.perTurn),
  stepsPerTurn: envInt("MINDWEAVE_SUBAGENT_TURN_STEPS", DEFAULT_LIMITS.stepsPerTurn),
};

/** The write scope a call asks for, as given (not yet checked). */
const askedScope = (args: Record<string, unknown>): string[] =>
  Array.isArray(args.write_scope) ? args.write_scope.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];

/**
 * A bounded gate so a wide fan-out queues instead of launching a swarm of agents at
 * once. Hand-off release (the freed slot goes straight to the next waiter) keeps the
 * live count at or below the limit even under interleaved arrivals.
 */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot over; active is unchanged, so we never exceed limit
    else this.active--;
  }
}

const gate = new Semaphore(SUBAGENT_CONCURRENCY);

export const spawnSubagent: Tool = {
  name: "spawn_subagent",
  /** Deferred: fan-out is a decision made at planning time rather than a step in the edit
   *  loop, and at ~750 tokens it is the most expensive schema outside the core four. The
   *  index line names it, so the option is visible where the choice is made. */
  deferred: true,
  readOnly: false,
  // A read-only worker changes nothing and is safe to fan out in parallel; an editing
  // worker must run alone (serial lane) so concurrent edits can't race. This is what
  // lets the model emit several read-only spawn_subagent calls in one message and have
  // them run concurrently.
  // A verifier runs commands (a build, the app) and its files are checked before and after, so it
  // runs alone even if it was also marked read-only: two at once would see each other's output.
  isConcurrencySafe: (args) => args.verify !== true && (args.read_only === true || (askedScope(args).length > 0 && args.read_only !== true)),
  // Three limits were enforced in code and absent from the text: a child cannot spawn
  // its own child, parallel workers are capped, and running out of steps is a clean
  // PAUSE rather than a failure. That last one changes what the model should do about
  // it — re-spawn with a bigger budget, not abandon the approach or retry identically.
  // The briefing advice was also making one point three times, which dilutes it.
  description:
    "Delegate a focused, self-contained subtask to a child agent with its own context, " +
    "then get back just its result. This is a heavy tool, used rarely: only for a job " +
    "that is genuinely large (a wide search or inventory whose steps would bury your " +
    "context, e.g. \"find and list every call site of authFetch\" across a big codebase), " +
    "or when the user asks for one.\n" +
    "DO NOT use it to read a file or a few files, to find one definition, to make or check " +
    "a single change, or to run the tests or the build: do those yourself, they are " +
    "faster and cheaper. The child does NOT see this conversation and cannot ask the " +
    "user anything, so the task must stand alone: the objective, its boundaries (what " +
    "NOT to touch), and via output_format the exact shape of the result you want. " +
    "Set read_only:true for research and inventory that must not change files.\n" +
    "PARALLEL: emit several calls in ONE message ONLY when the work has that many INDEPENDENT parts, and give each worker a `slice`: " +
    "the part it owns. Two workers may not own the same slice, and a task nearly the same as one already given is refused. Use as many " +
    "workers as there are independent parts and no more: one part means doing it yourself or starting one worker. " +
    `Up to ${SUBAGENT_CONCURRENCY} run at once; beyond that they queue. A turn may start ${LIMITS.perTurn} workers and spend ${LIMITS.stepsPerTurn} ` +
    "steps between them, and each result tells you what is left.\n" +
    "EDITING IN PARALLEL: give each editing worker a `write_scope` (the files or folders it may change). Scopes of workers running " +
    "together may not overlap, so none can write what another writes, and a worker can edit only inside its own. It has no shell: " +
    "build and test yourself when they are back. An editing worker WITHOUT a scope runs alone. Sub-agents cost far more tokens than " +
    "doing the work inline, so delegate only what is large and independent: several areas to read, or several separate pieces to build.\n" +
    `LIMITS: a child gets ${SUBAGENT_BUDGET} tool rounds by default (raise with ` +
    "max_steps; a verifier gets more). If it runs out it is given one last turn, with no " +
    "tools, to report what it found so far, and the result says that the limit was hit. " +
    "That is not a failure: the fix is a bigger max_steps or a narrower task, not the same " +
    "call again. A child cannot spawn its own children, so plan one level of " +
    "delegation and do the rest yourself.\n" +
    "BRIEF IT WELL: write to the child as you would to a competent colleague who just " +
    "walked in and cannot see any of this. Do the thinking yourself and hand over " +
    "specifics (file paths, line numbers, exactly what to change) rather than \"based " +
    "on your findings, fix the bug\". Terse command-style prompts produce shallow work.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task"],
    properties: {
      task: {
        type: "string",
        description:
          "A complete, standalone objective for the child, including any context and scope boundaries it needs " +
          "(it cannot see your conversation).",
      },
      read_only: {
        type: "boolean",
        description:
          "When true, the child may only read/search — no edits or commands — AND it runs in parallel with other " +
          "read-only workers spawned in the same message. Default false (runs alone). Use true for research/inventory.",
      },
      slice: {
        type: "string",
        description:
          "Required for a worker that runs beside others (read_only, or one with a write_scope): a short name for the part of the work it " +
          "owns, such as \"auth routes\". Two workers may not own the same slice.",
      },
      write_scope: {
        type: "array",
        items: { type: "string" },
        description:
          "For a worker that EDITS while others work: the files or folders (relative to the project) it may change, and nothing else. " +
          "Scopes of workers running together may not overlap. A worker with a scope can read and search, and edit inside its scope, " +
          "but has no shell: build and test yourself once they are back. Without a scope an editing worker runs alone.",
      },
      output_format: {
        type: "string",
        description:
          "The exact shape the result should come back in (e.g. \"a bullet list of `file:line — what's there`\"). " +
          "Strongly recommended — it keeps the report tight and directly usable.",
      },
      max_steps: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SUBAGENT_STEPS,
        description: `Tool-round budget for the child (default ${SUBAGENT_BUDGET}). Scale it up for deeper tasks, down for quick lookups.`,
      },
      verify: {
        type: "boolean",
        description:
          "Spawn an adversarial VERIFIER of work that has already been done, instead of a worker. It cannot edit or " +
          "write files (implied — do not also pass read_only), but it CAN run commands and drive the app, because " +
          "checking means running. It is told to try to BREAK the change rather than confirm it, and it must show the " +
          "command and output behind every check it claims. It answers `VERDICT: pass|fail|partial`. The verdict is " +
          "judged against what it really did: a check whose command never ran does not count, a pass with no command " +
          "output is downgraded to partial, and a pass is also downgraded if any project file changed while it ran. " +
          "Give it the ORIGINAL request, the files that changed, and what the approach was — it cannot see this conversation.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) return failQuietly("`task` is required — describe the subtask for the child agent.");

    const depth = ctx.subagentDepth ?? 0;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return fail("a sub-agent cannot spawn another sub-agent — do this part of the work directly.");
    }
    if (!ctx.forkChild) {
      return fail("sub-agents aren't available in this context.");
    }

    const outputFormat = typeof args.output_format === "string" ? args.output_format.trim() : "";
    // The status line is asked for on EVERY child, not only formatted ones: it is the
    // child's half of the verification contract (see subagentReport.ts), and a child
    // with no output_format is if anything the one whose outcome is least obvious.
    // A VERIFIER answers a different contract: a verdict about the CODE rather than a
    // status about its own run, and it carries its role in the system prompt rather than
    // in the task — see verifyReport.ts for why that distinction is load-bearing.
    const verifying = args.verify === true;
    const framedTask = [
      task,
      outputFormat ? `Report your result in EXACTLY this format:\n${outputFormat}` : "",
      verifying ? VERDICT_INSTRUCTION : STATUS_INSTRUCTION,
    ]
      .filter(Boolean)
      .join("\n\n");
    const budget = clampSteps(args.max_steps) ?? (verifying ? VERIFIER_BUDGET : SUBAGENT_BUDGET);
    // Verification is read-only whether or not the caller remembered to say so. A verifier
    // that can edit is a verifier that can make the thing it is judging pass.
    const readOnly = verifying || args.read_only === true;

    // A worker that edits beside others owns named files. The names are checked before anything starts.
    const asked = askedScope(args);
    if (asked.length > 0 && (readOnly || verifying)) {
      return failQuietly("Not started: `write_scope` and `read_only`/`verify` contradict each other. A worker either only reads, or edits the files it is given.");
    }
    const scopes: string[] = [];
    for (const raw of asked) {
      const n = normalizeScope(raw, ctx.cwd);
      if (!n.ok) return failQuietly(`Not started: write_scope ${n.reason}.`);
      if (!scopes.includes(n.scope)) scopes.push(n.scope);
    }
    const scoped = scopes.length > 0;
    const slice = typeof args.slice === "string" ? args.slice.trim() : "";

    // What this turn has handed out so far. The ceilings, the duplicate check and the slices are the point of this block: a model asked
    // to be thorough will start ten workers for what one could do, so it is refused here, in code, with what to do instead.
    const ledger = (ctx.delegation ??= newDelegation());
    const refused = refuseSpawn(ledger, LIMITS, { task, slice, parallel: (readOnly || scoped) && !verifying });
    if (refused) return failQuietly(refused);

    // A short id for THIS worker. Every event it emits carries it, so the UI keeps each
    // worker's nested rail distinct even when several fan out in parallel.
    const agentId = randomUUID().slice(0, 8);
    if (scoped) {
      // Taken now, before any await, so workers started in one message take their scopes in the order they were written.
      const got = scopeLocks.acquire(agentId, slice || task.slice(0, 40), scopes);
      if (!got.ok) {
        return failQuietly(
          `Not started: ${got.scope} overlaps ${got.heldScope}, which the worker "${got.heldBy}" is editing right now. Two workers must never write the same file. Give this one different files, or start it after that one is back.`,
        );
      }
    }
    noteSpawn(ledger, { task, slice, parallel: (readOnly || scoped) && !verifying });
    // The person may write to this worker while it runs (from its view in the CLI); what they write is read between its steps.
    openInbox(agentId);

    const child = ctx.forkChild(
      scoped ? `${framedTask}\n\nYour write scope: ${scopes.join(", ")}. You may change only these; you have no shell. Report what you changed and what is left.` : framedTask,
      { readOnly: readOnly || scoped, ...(scoped ? { writeScope: scopes } : {}), ...(verifying ? { agentPrompt: VERIFIER_PROMPT, verifier: true } : {}) },
    );
    // From here on the worker holds its scope and counts against the turn: both are settled in the `finally` below, however it ends.
    try {
    // Dynamic import: the static registry ← engine edge would otherwise cycle. By the
    // time execute() runs, both modules are fully loaded, so this is safe.
    const { respond } = await import("../dynamo/engine.js");

    const taskLabel = task.replace(/\s+/g, " ").trim().slice(0, 100);
    ctx.emitEvent?.({ type: "subagent", phase: "start", id: agentId, task: taskLabel, readOnly, ...(scoped ? { scope: scopes } : {}), ...(slice ? { slice } : {}), taskFull: task.replace(/\s+/g, " ").trim().slice(0, 600) });

    let reply = "";
    let verified: VerdictReport | undefined;
    // Run the child. `watch` sees every event first, so a verifier's own commands are known.
    let exhausted = false;
    const runOnce = (steps: number, watch?: (e: EngineEvent) => void): Promise<string> =>
      // Bounded: a wide fan-out queues here rather than launching every worker at once.
      gate.run(() =>
        respond(child, {
          signal: ctx.abortSignal,
          maxSteps: steps,
          // Between its steps the worker reads what the person has written to it, as the main agent reads what is typed to it.
          steer: async () => takeInbox(agentId).map((content) => ({ content })),
          // Surface the child's activity, not its chatter: its usage counts toward the
          // meter, and each of its tool calls is forwarded UP tagged with this worker's
          // id so the UI nests them in the worker's rail (its prose/reasoning stays
          // muted — only the final distilled report crosses back, as the tool result).
          onEvent: (e: EngineEvent) => {
            watch?.(e);
            if (e.type === "usage") ctx.reportUsage?.(e);
            else if (e.type === "tool") ctx.emitEvent?.({ ...e, agent: agentId });
          },
        }),
      );
    // A child that runs out of steps is given one more turn, with no tools, to say what it found (childReport.ts).
    const runChild = async (watch?: (e: EngineEvent) => void): Promise<string> => {
      let first = await runOnce(budget, watch);
      // A message that arrived while the worker was writing its answer is the next request, not a steer: it gets its own round, a few
      // at most, so a person who keeps writing cannot keep one worker going for ever.
      for (let round = 0; round < 3; round++) {
        const late = takeInbox(agentId);
        if (late.length === 0) break;
        for (const content of late) child.transcript.push({ role: "user", content });
        first = await runOnce(budget, watch);
      }
      const done = await reportOf(child, first, () => runOnce(2, watch));
      exhausted = done.exhausted;
      return done.reply;
    };
    try {
      if (verifying) {
        // A verifier's verdict is judged against what it DID: the commands it really ran, and whether
        // the project's files are the same afterwards. See verifierRun.ts.
        verified = await verifyWithGuards({ cwd: ctx.cwd, checkpoints: ctx.checkpoints, shells: ctx.backgroundShells, run: (watch) => runChild(watch) });
      } else {
        reply = await runChild();
      }
    } catch (error) {
      ctx.emitEvent?.({ type: "subagent", phase: "end", id: agentId, summary: "failed", error: true, headline: "Failed", verdict: "fail" });
      return fail(`the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const steps = child.transcript.filter((e) => e.role === "assistant").length;
    const scope = readOnly ? " · read-only" : "";
    const stepLabel = `${steps} step${steps === 1 ? "" : "s"}${scope}`;

    // The gate: a child's report is a claim, not a result, until the run behind it has
    // been checked. Nothing is withheld — the parent decides whether a partial answer
    // is still useful — but it is told what not to assume, above the report rather
    // than after it.
    if (verifying) {
      // The verifier's report is judged on its EVIDENCE, not on its confidence: a pass
      // carrying no command output is downgraded before the parent ever reads the word.
      const report = verified ?? parseVerdict(reply);
      const line = renderVerdictLine(report);
      ctx.emitEvent?.({
        type: "subagent",
        phase: "end",
        id: agentId,
        summary: `${stepLabel} · ${line}`,
        error: report.verdict === "fail",
        ...verifierOutcome(report.verdict, report.evidence, exhausted, report.ran ?? 0),
        steps,
      });
      const header = [
        report.concerns.length > 0 || exhausted
          ? `Treat with care: ${[...(exhausted ? [`it ran out of its ${budget} steps and was asked for what it had found so far, so some checks may not have been made`] : []), ...report.concerns].join("; ")}.`
          : "",
        `VERDICT: ${report.verdict} (${report.evidence} check${report.evidence === 1 ? "" : "s"} with evidence)`,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        output: `${header}\n\n${report.body}`,
        summary: `verify · ${stepLabel} · ${line}`,
      };
    }

    const verdict = verifySubagentReport(reply, { steps, budget, outputFormat });
    const flag = verdict.trustworthy ? "" : ` · ${verdict.status === "unstated" ? "unverified" : verdict.status}`;
    ctx.emitEvent?.({
      type: "subagent",
      phase: "end",
      id: agentId,
      summary: `${stepLabel}${flag}`,
      error: verdict.status === "failed",
      ...workerOutcome({ status: verdict.status, trustworthy: verdict.trustworthy, exhausted: exhausted || steps >= budget }),
      steps,
    });
    const touched = filesTouched(child);
    return {
      output: [renderVerdict(verdict), touched.length > 0 ? `Files changed: ${touched.join(", ")}` : "", delegationLine(ledger, LIMITS)].filter(Boolean).join("\n\n"),
      summary: `subagent · ${stepLabel}${flag}`,
    };
    } finally {
      // The steps it took are the turn's, and the files it held are free again, whether it finished, failed or was stopped.
      ledger.steps += child.transcript.filter((e) => e.role === "assistant").length;
      scopeLocks.release(agentId);
      closeInbox(agentId);
    }
  },
};

/** The files a worker changed, from the edit calls in its own conversation (pure). */
function filesTouched(child: { transcript: ReadonlyArray<{ role: string; toolCalls?: ReadonlyArray<{ name: string; arguments: string }> }> }): string[] {
  const seen = new Set<string>();
  for (const e of child.transcript) {
    if (e.role !== "assistant") continue;
    for (const call of e.toolCalls ?? []) {
      if (call.name !== "edit" && call.name !== "write_file" && call.name !== "replace_symbol_body") continue;
      try {
        const p = (JSON.parse(call.arguments) as { path?: unknown }).path;
        if (typeof p === "string" && p) seen.add(p.replace(/\\/g, "/"));
      } catch {
        /* a call whose arguments did not parse changed nothing */
      }
    }
  }
  return [...seen];
}


/** A clamped positive step budget from the model's `max_steps`, or undefined. */
export function clampSteps(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(MAX_SUBAGENT_STEPS, n);
}

/** A positive integer from an env var, or `fallback`. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
