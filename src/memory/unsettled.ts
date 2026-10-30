/**
 * unsettled.ts — a reply the engine's gates set aside and never replaced (pure apart from editing the list it is given).
 *
 * Kept apart from the engine so a session being OPENED can use it too: sessions saved before the engine settled these on its
 * own still hold the reply in the middle of the work, with the gate's instruction after it.
 */
import type { Entry } from "./types.js";

/**
 * A turn ended (an error, Esc) while a reply the gates had set aside was still the only one the model gave (impure).
 *
 * The verify and reply gates drop a draft from the screen, ask the model to go again, and remove the draft from the saved
 * conversation once the second reply lands. When the turn ends before that, the draft stayed where it was, in the middle of the
 * work, with the gate's instruction after it: never shown while the turn ran, then drawn when the session was opened again, with
 * the commands that followed split around it. What is on screen while the turn runs and what is saved have to be the same.
 *
 * So the draft is taken out of the middle and becomes the turn's last reply: it is shown (a `text` event) and saved at the end,
 * after the work that followed it, and the instruction that asked for the rewrite is removed. `at` are the draft positions the
 * gates recorded; the latest one is the reply, any other is dropped with its instruction. Returns the reply shown, or null.
 */
export function settleUnansweredDraft(session: { transcript: Entry[] }, at: Array<number | null>, onEvent?: (e: { type: "text"; delta: string }) => void): string | null {
  const t = session.transcript;
  const marks = at.filter((i): i is number => i !== null && i >= 0 && i + 1 < t.length).sort((a, b) => b - a);
  const pairs = marks.filter((i) => t[i]!.role === "assistant" && t[i + 1]!.role === "user" && (t[i + 1] as { synthetic?: true }).synthetic === true);
  if (pairs.length === 0) return null;
  // The latest draft is the reply; every pair comes out, highest index first so the earlier ones do not shift.
  let reply: string | null = null;
  for (const i of pairs) {
    const draft = t[i]!;
    if (reply === null && typeof draft.content === "string" && draft.content.trim() !== "") reply = draft.content;
    t.splice(i, 2);
  }
  if (reply === null) return null;
  const last = t[t.length - 1];
  if (last && last.role === "assistant" && !last.toolCalls?.length && typeof last.content === "string") {
    // The turn was cut off (the "(interrupted)" marker): one assistant entry, not two in a row.
    last.content = last.content === "(interrupted)" ? `${reply}\n\n(interrupted)` : `${reply}\n\n${last.content}`;
  } else {
    t.push({ role: "assistant", content: reply });
  }
  onEvent?.({ type: "text", delta: reply });
  return reply;
}


/**
 * The positions of replies set aside by a gate that were never replaced, in a saved conversation (pure).
 *
 * A gate's instruction is a synthetic user entry directly after the reply it rejected: the verify gate ("You edited files this
 * turn but never ran a check…") and the reply gate ("That reply used…" / "That reply ran to…"). When the model went on to give a
 * real reply, the engine removed both, so one still there with no later reply is one the turn never got past.
 */
export function findUnsettledDrafts(entries: readonly Entry[]): number[] {
  const found: number[] = [];
  for (let i = 0; i + 1 < entries.length; i++) {
    const e = entries[i]!;
    const next = entries[i + 1]! as { role: string; content?: string; synthetic?: boolean };
    if (e.role !== "assistant" || (e.toolCalls?.length ?? 0) > 0 || !e.content.trim()) continue;
    if (next.role !== "user" || next.synthetic !== true || typeof next.content !== "string") continue;
    if (!/^(You edited files this turn but never ran a check\.|That reply (used|ran to) )/.test(next.content)) continue;
    found.push(i);
  }
  // Only a turn that ended without a later real reply: any assistant text after the last one means the turn did conclude.
  const last = found[found.length - 1];
  if (last === undefined) return [];
  for (let j = last + 2; j < entries.length; j++) {
    const later = entries[j]!;
    if (later.role === "assistant" && (later.toolCalls?.length ?? 0) === 0 && later.content.trim()) return [];
  }
  return found;
}
