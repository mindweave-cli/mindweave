/**
 * userCommand.ts — running a command the person typed after `!`.
 *
 * It goes through the SAME shell tool the agent uses, so it behaves as an agent's command does:
 * the same shell, the same output limits, the same checkpoint note that a shell ran, the same move to
 * the background after two minutes (or when the person presses ctrl+X). What it skips is the engine's
 * gate: the person typing it is the approval, so no question is asked, and the agent's own rules about
 * what it may run (and about not reopening an app the user closed) do not apply to them. The tool's own
 * refusal of the plainly catastrophic (wiping a drive) still stands.
 *
 * No turn starts from the running and the model is not called. The command and its output are put into
 * the conversation as one entry (see memory/localCommand.ts), and the agent is woken to carry on from it
 * (by the caller, the same way it is when a command of its own finishes).
 */
import type { Session } from "../memory/types.js";
import { localCommandEntry, type UserEntry } from "../memory/localCommand.js";
import { isInteractiveServerCommand } from "./backgroundShells.js";
import { sessionDetailFull } from "./detail.js";
import { runCommand } from "./runCommand.js";
import type { ToolContext, ToolResult } from "./types.js";

export interface UserCommandOptions {
  /** Stops the command (Esc). */
  signal?: AbortSignal;
  /** The latest few lines of output while it runs, resent whole each time. */
  onProgress?: (text: string) => void;
}

/** Background shells the person started with `!`, by shell manager. Esc stops what the agent started, not these. */
const userShells = new WeakMap<object, Set<number>>();

/** Whether a background shell is one the person started themselves. */
export function isUserShell(shells: object | undefined, id: number): boolean {
  return !!shells && !!userShells.get(shells)?.has(id);
}

/**
 * Run `command` as the person's own and record it in the conversation.
 *
 * Returns what the shell tool answered, for the row to draw, and the entry that was added.
 * The entry goes in AFTER the command ends (or is handed to the background), so a conversation never
 * holds a command that has no result yet. A command stopped with Esc is recorded with whatever it
 * printed, and says so.
 */
export async function runUserCommand(
  session: Session,
  command: string,
  options: UserCommandOptions = {},
): Promise<{ result: ToolResult; entry: UserEntry }> {
  // A copy, so the turn that last ran does not leave its (aborted) signal on this one. The forbidden
  // paths and commands are rules for what the AGENT may do; the person typing a command is not
  // the agent, so they do not apply (and nothing asks the person for leave to lift them).
  const governance = session.toolContext.governance;
  const ctx: ToolContext = {
    ...session.toolContext,
    abortSignal: options.signal,
    userInitiated: true,
    ...(governance ? { governance: { ...governance, forbidden: { patterns: [], commands: [], mcpTools: [], root: governance.forbidden.root } } } : {}),
  };
  // The agent hears about a long-running command of the person's the way it hears about its own: the
  // caller wakes it once when the command is handed to the background (so it can say so), and the shell
  // manager wakes it again when the command finishes (`on_finish`), or, for an app or a dev server
  // (`npm start`, `vite`, `electron .`), when it is up or stops early (`on_failure`). Those never end,
  // so they start in the background at once and the person gets the prompt back.
  // And `hidden: false`: what a person starts, they start to SEE.
  const server = isInteractiveServerCommand(command);
  const result = await runCommand.execute(
    { command, notify: server ? "on_failure" : "on_finish", hidden: false, ...(server ? { run_in_background: true } : {}) },
    ctx,
    {
      id: "user-command",
      progress: (text: string) => options.onProgress?.(text),
    },
  );
  const moved = /^(?:Backgrounded|Running) as shell #(\d+)/.exec(result.summary ?? "");
  const shells = session.toolContext.backgroundShells;
  if (moved && shells) {
    const set = userShells.get(shells) ?? new Set<number>();
    set.add(Number(moved[1]));
    userShells.set(shells, set);
  }
  const entry = localCommandEntry(command, result, Date.now(), sessionDetailFull);
  session.transcript.push(entry);
  return { result, entry };
}
