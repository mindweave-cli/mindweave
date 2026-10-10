/**
 * shellNotes.ts — which changes to a background command are worth a line of their own (pure).
 *
 * A line in the conversation is for something the person has to be told. Most of what happens to
 * a background command is already on screen as the agent's own row (`Ran 1 command`: the agent
 * started it, checked it, stopped it), so saying it again was the same thing twice. What nothing
 * else shows: a command that died on its own, and one that has gone quiet or is waiting on a
 * prompt.
 */
import type { ShellEventKind, ShellInfo } from "../tools/backgroundShells.js";

export interface ShellNote {
  text: string;
  error: boolean;
}

/** Shortens a command for a line (the caller's own clipper). */
export function shellNote(sh: ShellInfo, kind: ShellEventKind, clip: (command: string) => string): ShellNote | undefined {
  // Coming up is the agent's row ("Backgrounded as shell #1") saying so already.
  if (kind === "ready" || kind === "opened") return undefined;
  const name = `shell #${sh.id} (${clip(sh.command)})`;
  // Gone quiet, or blocked on a prompt: nothing else on screen would say so until it timed out.
  if (kind === "stalled") {
    const why = sh.stallReason === "prompt" ? "waiting for input?" : "no output for a while, stuck?";
    return { text: `${name} ${why}`, error: true };
  }
  // Stopped on purpose (by you, or by the agent: its row is on screen) is not news.
  if (sh.status === "killed") return undefined;
  // Ended by itself with success: the agent was told and says what it found. Ending badly is news,
  // because nothing else would tell you a dev server had fallen over.
  if (sh.exitCode === 0) return undefined;
  return { text: `${name} finished with exit ${sh.exitCode}`, error: true };
}
