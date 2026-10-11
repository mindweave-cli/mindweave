/**
 * childReport.ts — a sub-agent that ran out of steps still reports what it found.
 *
 * A sub-agent that reaches its step budget did not fail: it was in the middle of work. What the engine
 * hands back for that is a pause note ("Paused — reached the step budget… say 'continue'"), written for
 * a person at a prompt. A parent agent cannot say "continue" to a child, so the note told it nothing and
 * every step the child had taken, and everything it had read and run, was thrown away. In one real
 * session a verifier spent thirty steps on eight checks and returned only that note, and the parent had
 * to do the checks again itself.
 *
 * So when a child is paused for its budget, it is given one more turn with its tools switched off and
 * asked to say what it found so far, which parts it did not get to, and to end the way it was told to.
 * What it says is the reply. If it cannot, the last thing it said while it worked is used, and if there
 * is nothing, the parent is told what happened in words meant for a parent.
 */
import type { Session } from "../memory/types.js";
import type { EngineEvent } from "../dynamo/engine.js";

/** What a child is told on its last turn. */
export const WRAP_UP =
  "You have used all of your steps, so you cannot call any more tools. Reply now with what you have found so far, " +
  "in the format you were asked for. Say plainly which parts you did not get to. End with the status line you were told to end with.";

/** What the parent is told when the child could not report at all. */
export const NO_REPORT =
  "The sub-agent reached its step limit and could not report what it had found. Run it again with a narrower task, " +
  "or with a larger max_steps, and ask it to report as it goes.";

/** Whether a reply is the engine's pause note rather than anything the child said (pure). */
export function isPausedReply(reply: string): boolean {
  return /^\s*\(Paused\b/.test(reply);
}

/** The last thing the child said in words while it worked, or "" (pure). */
export function lastSaid(child: Pick<Session, "transcript">): string {
  for (let i = child.transcript.length - 1; i >= 0; i--) {
    const e = child.transcript[i]!;
    if (e.role === "assistant" && e.content.trim() !== "" && !isPausedReply(e.content)) return e.content.trim();
  }
  return "";
}

/**
 * The reply for a child that has finished its run: what it said, or, when it only paused for its budget,
 * what it says on one more turn without tools. `exhausted` is true when the budget is what ended it.
 */
export async function reportOf(
  child: Session,
  reply: string,
  run: (child: Session) => Promise<string>,
): Promise<{ reply: string; exhausted: boolean }> {
  if (!isPausedReply(reply)) return { reply, exhausted: false };
  child.toolContext.noTools = true;
  child.transcript.push({ role: "user", content: WRAP_UP, synthetic: true });
  let wrapped = "";
  try {
    wrapped = await run(child);
  } catch {
    wrapped = "";
  } finally {
    child.toolContext.noTools = false;
  }
  if (wrapped.trim() !== "" && !isPausedReply(wrapped)) return { reply: wrapped, exhausted: true };
  const said = lastSaid(child);
  return { reply: said !== "" ? said : NO_REPORT, exhausted: true };
}

/** Events a caller may want to see while the last turn runs: the same ones as the run itself. */
export type ChildEvents = (e: EngineEvent) => void;
