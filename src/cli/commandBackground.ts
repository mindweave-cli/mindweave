/**
 * commandBackground.ts — the two decisions behind ctrl+X, kept out of the screen code so
 * they can be tested without drawing one.
 *
 * ctrl+X moves the commands the turn is waiting on to the background. What the screen
 * needs to know is (1) when to offer it, and (2) what a press did.
 */
import type { ForegroundCommands } from "../tools/foregroundCommands.js";

/** How long a command runs before the working line offers to move it. The same two
 *  seconds as the progress tail: one that ends sooner never needed the offer. */
export const COMMAND_OFFER_AFTER_MS = 2000;

/** Should the working line offer ctrl+X now (pure)? `since` is when the oldest command the
 *  turn is waiting on started, null when none is running. Never while a question is open:
 *  the clock stands still then and the offer would be for a command nobody is waiting on. */
export function offerBackground(since: number | null, now: number, waiting: boolean): boolean {
  return !waiting && since !== null && now - since >= COMMAND_OFFER_AFTER_MS;
}

/** What a press of ctrl+X did. "none" is a stray press and needs no comment; "stuck" means
 *  something was running and could not be moved, which is the only case worth saying. */
export type PressOutcome = "moved" | "none" | "stuck";

export function pressBackground(fg: ForegroundCommands | undefined): PressOutcome {
  const running = fg?.running().length ?? 0;
  if (!fg || running === 0) return "none";
  return fg.promoteAll("user") > 0 ? "moved" : "stuck";
}
