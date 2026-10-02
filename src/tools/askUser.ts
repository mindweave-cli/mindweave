/**
 * askUser.ts — a structured question to the user.
 *
 * Underspecification is one of the top real-world failure modes for coding agents:
 * faced with an ambiguous request, a model guesses and builds the wrong thing.
 * This gives the model an explicit escape hatch — ask a focused question with a
 * few concrete options — instead of guessing. It reuses the same client approval
 * channel the forbidden-lift flow uses (`ctx.requestApproval`), which renders the
 * question + options and returns the chosen one.
 *
 * Model-work boundary: WHETHER to ask is the model's judgment (guided by the
 * prompt: ask when genuinely blocked, don't overuse it). This tool only carries
 * the question to the human and the answer back.
 */
import type { Tool, ToolResult } from "./types.js";
import { APPROVAL_DISMISSED, readFreeText } from "./approval.js";
import { failQuietly } from "./results.js";

const askUserDef: Tool = {
  name: "ask_user",
  /** Deferred: asking is rare by design — on most turns the prompt asks for a judgment
   *  call to be made, not a question put back to the user. */
  deferred: true,
  readOnly: true,
  // Never alongside other calls: while a question waits on the user, nothing else
  // may run or appear. The engine finishes the parallel lane first, and everything
  // after this waits for the answer.
  isConcurrencySafe: () => false,
  // The old text promised "the user's choice is returned to you" with no account of the
  // two ways that does not happen — dismissal, and no channel at all. Both now return a
  // plain instruction to carry on, so the model must know they are possible or it will
  // read either one as a choice.
  description:
    "Ask the user a focused question when the task is genuinely ambiguous and you " +
    "cannot proceed well without their input: which of two real approaches they want, " +
    "a missing requirement, an unclear denial. Give 2-4 concrete options — only the " +
    "first 4 are shown — and their choice comes back to you. The user can also TYPE " +
    "their own answer instead of picking one (offered automatically), so write real, " +
    "distinct options rather than trying to pre-cover every case.\n" +
    "When the options carry a trade-off, end each with a short parenthetical that names " +
    "it — \"(recommended)\", \"(simplest)\", \"(fastest)\", \"(most complete, most work)\" — " +
    "so the user can decide without reverse-engineering the difference. Make each option " +
    "self-contained: it is read on its own line, so it should say what it means without " +
    "leaning on the others.\n" +
    "Use it sparingly. Anything you can settle with a sensible default, or find out by " +
    "reading the project, is not a question; asking about it spends the user's " +
    "attention on work they delegated. Prefer acting when the answer is obvious, and " +
    "prefer one question that decides the direction over several small ones.\n" +
    "You may not get an answer: the user can dismiss the question, and some sessions " +
    "have no way to ask at all. Both come back saying so, and neither is a choice — do " +
    "not treat an option as picked. Carry on with the most reasonable default, say " +
    "which one you assumed, and do any part of the work that does not depend on it.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["question", "options"],
    properties: {
      question: {
        type: "string",
        description: "The specific question to ask. Clear and self-contained.",
      },
      options: {
        type: "array",
        description: "2-4 concrete answer options for the user to choose from.",
        items: { type: "string" },
        minItems: 2,
        maxItems: 4,
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    const options = Array.isArray(args.options)
      ? args.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim())
      : [];
    if (!question) return failQuietly("`question` is required.");
    if (options.length < 2) return failQuietly("provide at least 2 concrete `options`.");

    // A Marathon closes questions after its opening turn: the person delegated the whole
    // run, and a question that waits for them would stall it indefinitely.
    if (ctx.noQuestions) {
      return {
        output:
          "Questions are closed for this run: it is working on its own now, so nobody will " +
          "answer. Choose the most reasonable option yourself, note the assumption where the " +
          "user will see it (your task list or your next reply), and keep going.",
        summary: "ask_user closed — decide and continue",
      };
    }
    // No approval channel (headless run / tests): can't ask — tell the model to
    // proceed on its best judgment rather than stall.
    if (!ctx.requestApproval) {
      return {
        output:
          "Can't ask the user right now (no interactive channel). Proceed with your best " +
          "judgment using a sensible default, and note the assumption in your reply.",
        summary: "ask_user unavailable — proceed with a default",
      };
    }

    // Always offer a typed answer as one more row: the options are the model's best guesses
    // at what the user wants, and forcing a choice among only those is the exact failure this
    // tool exists to avoid — the user picks the nearest wrong one because there is no way to
    // say the real thing. The row is theirs to write a full answer or a note in.
    const choice = await ctx.requestApproval(question, options.slice(0, 4), undefined, undefined, {
      label: "Write my own answer",
      placeholder: "type your answer",
    });
    // Dismissing the question is not an answer, and must never be reported as one.
    // It used to resolve as the second option, so "Postgres or SQLite?" dismissed came
    // back as "The user chose: SQLite" — a decision attributed to someone who declined
    // to make it, which is worse than not having asked.
    if (choice === APPROVAL_DISMISSED) {
      // Dismissing is an INTERRUPTION, not a non-answer to be worked around.
      //
      // This used to tell the model to "proceed with the most reasonable default and say
      // which one you assumed", and the model duly did — announcing a choice a moment
      // after the person had declined to make one, which is the same fault as reporting
      // a dismissal as a selection, one step further along. Someone who presses Esc on a
      // question is reaching for the keyboard because none of the options fit, and the
      // last thing they want is the work continuing on a guess in the meantime.
      //
      // So the turn ends here, by the same route Esc takes. Wording alone could not do
      // it: whatever this said, nothing was stopping the model from carrying on.
      ctx.interrupt?.();
      return {
        output:
          "The user dismissed the question without answering. Treat that as an " +
          "interruption, not as a decision: do not report any option as chosen, do not " +
          "assume a default, and do not continue the work. They are about to say what " +
          "they want instead.",
        summary: `asked: ${clip(question)} → cancelled`,
      };
    }
    // A typed answer is not one of the options — it is the user saying the options missed,
    // so it must be carried back as their own words, not squeezed into "chose".
    const typed = readFreeText(choice);
    if (typed !== null) {
      return {
        output: `The user did not pick an option and wrote their own answer instead: ${typed}`,
        summary: `asked: ${clip(question)} → wrote an answer`,
      };
    }
    return {
      output: `The user chose: ${choice}`,
      summary: `asked: ${clip(question)} → ${clip(choice)}`,
    };
  },
};

/**
 * Never renders a row.
 *
 * The user has just been shown the question in the approval box and answered it — a
 * row afterwards restating "asked: which database? → SQLite" tells them something they
 * did a second ago. The model still gets the full result, which is the half that
 * matters: it needs the answer, the user does not need the receipt.
 *
 * Wrapped at the export rather than flagged at each `return`, so a new return site
 * cannot start rendering again by omission — the same shape `navigational()` uses for
 * the code-intel lookups.
 */
export const askUserTool: Tool = {
  ...askUserDef,
  async execute(args, ctx) {
    return { ...(await askUserDef.execute(args, ctx)), quiet: true };
  },
};

function clip(s: string, max = 40): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

