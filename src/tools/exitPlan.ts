/**
 * exitPlan.ts — hand a finished plan to the user, and start work if they approve.
 *
 * Planning without this is only half a feature. The agent would work out what to do,
 * present it, and then stop and wait to be told to do the thing it had just described
 * — so approving cost three actions (read it, change mode, say "go") when approving
 * already means "start". Worse, after the mode switch the plan had to be recovered
 * from scrollback, so what got built drifted from what was agreed.
 *
 * Two things make this a TOOL rather than the client noticing the model went quiet:
 *
 *  1. **The plan gets shown whole.** Prose written between tool calls is narration,
 *     and the display cuts it to two sentences (one per turn) on purpose. A plan is
 *     the opposite of narration: it is the thing being read. Arriving as tool data
 *     puts it in a channel that trimming never touches.
 *  2. **The model says when it is done.** Pausing to think mid-research is not a
 *     finished plan, and no heuristic over an idle turn can tell those apart.
 *
 * Approving ENDS the planning session and leaves the user in the mode they picked at
 * the prompt. It used to lift planning for a single turn and force it back afterwards,
 * which meant work that ran past one turn returned with the editing tools withheld and
 * the plan no longer in context, needing a second approval for the same agreement.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { savePlanArtifact } from "../dynamo/planArtifact.js";
import { fail, failQuietly } from "./results.js";
import { APPROVAL_DISMISSED, readFreeText } from "./approval.js";

/**
 * What the user chose at the approval prompt. Order is the display order.
 *
 * The "fresh context" pair is the one worth explaining. Planning spends a lot of the
 * window on exploration — files opened to understand the shape of the problem, searches
 * that led nowhere — and none of that is needed to CARRY OUT the plan. Choosing fresh
 * starts the work with the plan as the instruction and nothing else, which is both
 * cheaper and cleaner than implementing underneath a transcript of the investigation.
 * Nothing is lost: the session file is still on disk and the model is told where.
 */
export const PLAN_CHOICES = [
  "Approve — Lightning (auto-accept)",
  "Approve — Lightning, fresh context",
  "Approve — Sentinel (ask each action)",
  "Approve — Sentinel, fresh context",
  "Reject",
] as const;

/** The typed answer offered alongside them, for saying what to change. */
export const PLAN_FEEDBACK = { label: "Change something", placeholder: "say what to change" };

/**
 * The decision, separated from its wording so the engine never matches on prose.
 *
 * `dismiss` is not a quieter `reject`. Rejecting is a verdict on the plan; dismissing is
 * declining to give one, usually because none of the five rows is the thing the reader
 * wants to say. Collapsing the two told the model "the user rejected the plan" on the
 * strength of a keypress that said no such thing — the same fault as reporting a
 * dismissed question as a chosen option, on the longest thing the app ever asks about.
 */
export type PlanVerdict = "lightning" | "sentinel" | "reject" | "revise" | "dismiss";

/** An approval, and whether it asked to start from a clean slate. */
export interface PlanDecision {
  verdict: PlanVerdict;
  fresh: boolean;
  /** What the user typed, when they typed instead of choosing. */
  feedback?: string;
}

/**
 * Read a verdict out of the chosen option (pure).
 *
 * Matched by POSITION-INDEPENDENT content rather than exact string equality: the
 * approval channel can hand back a trimmed or re-cased answer, and an unrecognised
 * reply must never be read as approval. Anything unknown is a refusal, because the
 * failure that matters here is acting when nobody said yes.
 */
export function readVerdict(choice: string): PlanVerdict {
  return readDecision(choice).verdict;
}

/**
 * The full decision behind an answer (pure).
 *
 * A TYPED answer is always a revision request carrying its text — the user telling the
 * agent what to change is the one thing the old four-option prompt could not express,
 * so "Change something" meant "stop and wait for them to say it in a new message",
 * which cost a whole round trip to learn one sentence.
 */
export function readDecision(choice: string): PlanDecision {
  const typed = readFreeText(choice);
  if (typed !== null) return { verdict: "revise", fresh: false, feedback: typed.trim() };
  // Before anything is matched on prose: a dismissal is not one of the answers, and the
  // catch-all at the bottom of this function would otherwise make it a rejection.
  if (choice === APPROVAL_DISMISSED) return { verdict: "dismiss", fresh: false };
  const c = choice.trim().toLowerCase();
  if (c.startsWith("approve")) {
    return { verdict: c.includes("sentinel") ? "sentinel" : "lightning", fresh: c.includes("fresh") };
  }
  if (c.startsWith("change")) return { verdict: "revise", fresh: false };
  return { verdict: "reject", fresh: false };
}

export const exitPlan: Tool = {
  name: "exit_plan",
  // It writes nothing, but it is not offered outside planning: there is nothing to
  // exit from in an ordinary turn.
  readOnly: true,
  // Never alongside other calls: while a plan waits on the user, nothing else
  // may run or appear. The engine finishes the parallel lane first, and everything
  // after this waits for the answer.
  isConcurrencySafe: () => false,
  planOnly: true,
  description:
    "Present your finished plan to the user and ask them to approve it. Call this when " +
    "you have researched enough to say exactly what you would change and why — it is how " +
    "planning ends. " +
    "Put the WHOLE plan in `plan`: the user reads it here and nowhere else, so it must " +
    "stand on its own, in the order you would carry it out, naming the files you would " +
    "touch. Do not summarise it in your reply as well. " +
    "If the user approves, you begin immediately in the same turn, so write the plan as " +
    "the instruction you are about to follow. If they decline, stop and wait.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["plan"],
    properties: {
      plan: {
        type: "string",
        description:
          "The complete plan, in markdown. Steps in the order you would do them, the " +
          "files each one touches, and anything you would need the user to decide.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const plan = typeof args.plan === "string" ? args.plan.trim() : "";
    if (!plan) return failQuietly("`plan` is required — put the whole plan in it.");

    if (!ctx.requestApproval) {
      return fail(
        "Cannot ask for approval from here, so the plan cannot be started. Present the " +
          "plan in your reply instead and let the user decide.",
      );
    }

    // The plan travels as DETAIL, not as the question. It is the longest thing any
    // tool asks about, and putting it in the prompt made the frame taller than the
    // terminal — the screen tore and the app looked hung with no way to answer. As
    // detail it prints into the transcript, which scrolls, and the prompt stays one
    // line. Nothing is summarised: the user still reads the whole plan.
    const choice = await ctx.requestApproval(PLAN_QUESTION, [...PLAN_CHOICES], plan, undefined, PLAN_FEEDBACK);
    const { verdict, fresh, feedback } = readDecision(choice);

    if (verdict === "dismiss") {
      // The same stop Esc performs, for the same reason it is right in ask_user: someone
      // who closes a plan without answering is reaching for the keyboard. Leaving the
      // turn running would have the model respond to a verdict nobody gave.
      ctx.interrupt?.();
      return {
        output:
          "The user closed the plan without answering. That is not a rejection and not " +
          "approval: they have said nothing about the plan yet. Do not start any of it, " +
          "do not revise it, and do not ask again. Wait for what they say next.",
        summary: "plan dismissed",
      };
    }
    if (verdict === "reject") {
      return {
        output:
          "The user rejected the plan. Stop here and do not start any of it. Do not " +
          "propose a new plan until they say what they want changed.",
        summary: "plan rejected",
      };
    }
    if (verdict === "revise") {
      // With their words, this is a working instruction and the model can revise now.
      // Without them it is still a full stop, because guessing at what someone meant by
      // "change something" is how an agent produces a second plan nobody asked for.
      return feedback
        ? {
            output:
              `The user did not approve the plan. They want this changed:

${feedback}

` +
              "Revise the plan accordingly and present it again with exit_plan. Do not " +
              "start any of the work yet.",
            summary: "plan sent back with notes",
          }
        : {
            output:
              "The user wants the plan changed but has not said how yet. Stop and wait for " +
              "them to tell you. Do not guess at a revision or start any part of the plan.",
            summary: "plan sent back",
          };
    }

    // Approved. The plan is now the agreed scope of the work, so it becomes a
    // durable artifact: written to .mindweave/plan.md (user-visible, user-editable,
    // survives compaction BY CONSTRUCTION because the engine re-renders it from
    // here every request instead of trusting the transcript) and carried on the
    // context for this session. A failure to write must not un-approve the plan —
    // the in-memory copy still governs this session; only persistence is lost.
    ctx.activePlan = plan;
    ctx.activePlanApprovedAt = new Date().toISOString();
    try {
      await savePlanArtifact(ctx.roots?.[0] ?? ctx.cwd, plan, verdict === "sentinel" ? "sentinel" : "lightning");
    } catch {
      // Read-only filesystem or similar: session-local plan still applies.
    }
    // Approving ENDS the planning session, and the mode the user picked at the prompt
    // is the mode they are now in. It used to be lifted for one turn and then forced
    // back to planning, which had two costs: work that did not finish in a single turn
    // came back with the editing tools withheld AND the plan no longer in context, so
    // it needed approving again; and a user who had been in Sentinel before planning
    // was silently returned to a different mode from the one they chose here.
    ctx.planMode = false;
    // Asked for, not done here. Replacing the conversation from inside a tool would
    // strand the call that is still running: the provider requires every tool_call to
    // be answered, so the engine performs it once this result has been recorded, and
    // drops the call and its answer together.
    if (fresh) ctx.planFreshStart = plan;
    ctx.guarded = verdict === "sentinel";
    // A fresh Sentinel pass starts vigilant: an "allow all" from some earlier point in
    // the session must not silently cover work the user has only just agreed to.
    if (ctx.guarded) ctx.guardAllowed = undefined;
    ctx.onModeChange?.();

    return {
      output:
        `The user approved the plan${verdict === "sentinel" ? " and asked to confirm each action" : ""}. ` +
        `Start now, in this turn, and follow the plan you just presented. ` +
        `Begin by putting its steps on your task list if there is more than one. ` +
        (fresh
          ? "The conversation from planning has been cleared, so work from the plan itself. " +
            "It is repeated in full above. "
          : "") +
        (verdict === "sentinel"
          ? "Each change is confirmed with them before it happens, so work in small clear steps. "
          : "") +
        `Do not restate the plan — they have read it.`,
      summary: verdict === "sentinel" ? "plan approved (Sentinel)" : "plan approved (Lightning)",
    };
  },
};

/** The prompt itself — one line, because it renders in the height-bounded footer.
 *  The plan is passed alongside it as detail and printed into the transcript. */
export const PLAN_QUESTION = "Start on this?";

