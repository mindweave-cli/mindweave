/**
 * marathonPrompt.ts — the standing context a running Marathon adds to each turn's
 * volatile tail.
 *
 * Kept in its own module, with no imports, because engine.ts renders it and
 * marathon.ts imports engine.ts: putting it in marathon.ts would make the two
 * modules import each other.
 *
 * Mechanical contract only, per the thin-prompt boundary: what phase the run is in,
 * what the two tools it leans on are for, and the one rule that keeps "done" honest.
 * How to break a goal down and how to work on it are the model's judgment and are not
 * scripted here.
 *
 * Two phases, and the boundary between them is enforced in code, not asked for here
 * (see `noQuestions` on the tool context): questions are asked in the opening turn or
 * not at all.
 */

export type MarathonPhase = "plan" | "run";

/** The goal is shown to the model verbatim, but a goal is user text and can be
 *  arbitrarily long or contain the closing tag; clip it and neutralise the tag. */
const MAX_GOAL_CHARS = 4_000;

function goalBlock(goal: string): string {
  const clipped = goal.length > MAX_GOAL_CHARS ? `${goal.slice(0, MAX_GOAL_CHARS)}…` : goal;
  return `<goal>\n${clipped.replace(/<\/goal>/gi, "<\\/goal>")}\n</goal>`;
}

export function marathonBlock(goal: string, phase: MarathonPhase = "run"): string {
  if (phase === "plan") {
    return (
      "A Marathon is starting. After this turn it runs on its own, for as long as it takes, and you " +
      "will NOT be able to ask the user anything. So this opening turn is the only chance to ask: " +
      "read what you need to understand the goal, and if anything is unclear or hinges on a decision only " +
      "the user can make, ask now with ask_user (several questions in a row is fine). " +
      "Then write your plan as a task list with todo_write and reply with a short summary of what you " +
      "will do. Do not change anything yet.\n" +
      goalBlock(goal)
    );
  }
  return (
    "A Marathon is running. You are working toward one goal across as many turns as it takes, on your own. " +
    "Questions are closed: nobody will answer, so where something is ambiguous choose the most reasonable " +
    "option, note the assumption in your task list or your reply, and keep going. " +
    "The run pauses and resumes by itself, so do not stop to ask whether to continue.\n" +
    goalBlock(goal) +
    "\nKeep the task list from your plan up to date with todo_write: one task in_progress at a time, and mark " +
    "each completed the moment it is really done. " +
    "Do not declare the goal finished on your own word: when you believe it is done, say so plainly, " +
    "and it will be checked independently."
  );
}
