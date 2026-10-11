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

const MAX_SUBAGENT_DEPTH = 1;
/** Default step budget for a worker; the caller can scale it with `max_steps`. */
const SUBAGENT_BUDGET = envInt("MINDWEAVE_SUBAGENT_BUDGET", 20);
/** A verifier runs things, one call at a time, so it needs more than a reader does. */
const VERIFIER_BUDGET = envInt("MINDWEAVE_VERIFIER_BUDGET", 40);
/** Ceiling on `max_steps` so one worker can't run away. */
const MAX_SUBAGENT_STEPS = envInt("MINDWEAVE_SUBAGENT_MAX_STEPS", 60);
/** How many workers may run concurrently, process-wide. */
const SUBAGENT_CONCURRENCY = envInt("MINDWEAVE_SUBAGENT_CONCURRENCY", 5);

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
  isConcurrencySafe: (args) => args.read_only === true && args.verify !== true,
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
    "PARALLEL: emit several read-only calls in ONE message to fan out over independent " +
    `areas, giving each a distinct slice so they do not duplicate work. Up to ` +
    `${SUBAGENT_CONCURRENCY} run at once; beyond that they queue, so more workers stop ` +
    "buying speed. A non-read-only child runs alone. Sub-agents cost far more tokens " +
    "than doing the work inline, and most editing is sequential, so delegate for " +
    "independent READ and discovery rather than to parallelise edits.\n" +
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

    const child = ctx.forkChild(framedTask, { readOnly, ...(verifying ? { agentPrompt: VERIFIER_PROMPT, verifier: true } : {}) });
    // Dynamic import: the static registry ← engine edge would otherwise cycle. By the
    // time execute() runs, both modules are fully loaded, so this is safe.
    const { respond } = await import("../dynamo/engine.js");

    // A short id for THIS worker. Every event it emits carries it, so the UI keeps each
    // worker's nested rail distinct even when several fan out in parallel.
    const agentId = randomUUID().slice(0, 8);
    const taskLabel = task.replace(/\s+/g, " ").trim().slice(0, 100);
    ctx.emitEvent?.({ type: "subagent", phase: "start", id: agentId, task: taskLabel, readOnly, taskFull: task.replace(/\s+/g, " ").trim().slice(0, 600) });

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
      const first = await runOnce(budget, watch);
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
    return {
      output: renderVerdict(verdict),
      summary: `subagent · ${stepLabel}${flag}`,
    };
  },
};


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
