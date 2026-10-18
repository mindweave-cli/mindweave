/**
 * sessionCarry.ts — what outlives a conversation when you start a new one in place.
 *
 * `/clear` builds a brand-new session in the same folder. Most state SHOULD die with the conversation — the transcript, the read
 * ledger, the working set, anything the model was told. Two things must not, and both
 * were being lost silently:
 *
 *  - **Added workspace roots.** Handled in `createSession(cwd, carryRoots)`, because
 *    the roots have to exist before the tool context is built.
 *  - **Undo history.** Clearing a conversation does not un-edit the files. The old
 *    session's checkpoints are the ONLY record of what those files looked like before,
 *    and they live entirely in memory, so dropping them leaves the user with modified
 *    files and no way back — worse off than if they had never cleared.
 *
 * The distinction to hold on to: `/clear` ends a CONVERSATION, not a work session. The
 * folder, its rules, and the state of its files all carry straight on.
 */
import type { ToolContext } from "../tools/types.js";

/**
 * Move the parts of `from` that belong to the folder rather than to the conversation
 * onto `to`, in place.
 *
 * Deliberately NOT carried, each for its own reason:
 *   - `reads` / working set — the new conversation has told the model nothing, so a
 *     ledger claiming files are already in context would make it skip reading them.
 *   - `backgroundShells` — they belong to the old context and nothing in the new one
 *     could reach or stop them; the caller kills them and says how many.
 *   - `todos` — a task list for work the model can no longer see.
 *   - `mcp` / `chassisByRoot` — real child processes, already disposed and rebuilt.
 */
export function carryAcrossFreshSession(from: ToolContext, to: ToolContext): void {
  // The instance itself, not a copy: it holds file bytes keyed by path, and a
  // half-copied undo stack is worse than none.
  if (from.checkpoints) to.checkpoints = from.checkpoints;
}
