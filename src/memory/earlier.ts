/**
 * earlier.ts — what a compaction takes out of the conversation, kept for the screen.
 *
 * A compaction replaces the oldest part of the transcript with a summary, which is the
 * point: the model stops paying for it. But the transcript was also the only record the
 * chat is redrawn from, so reopening a compacted session (a switch, a restart, /continue)
 * showed nothing above the summary, as if the work before it had never happened.
 *
 * The entries a compaction removes go here instead of nowhere. They are never sent to
 * the model and never counted as context; they exist only so the conversation can be
 * drawn the way it happened. On disk they are appended to their own file as they leave
 * (see store.ts), never rewritten.
 */
import type { Entry, Session } from "./types.js";

/**
 * Put `next` in place of the session's transcript, keeping every entry it drops as
 * `earlier`. An entry that stays is the SAME object in `next` (compaction keeps its tail
 * by slicing), so anything not found there by identity is what left.
 */
export function replaceTranscript(session: Session, next: Entry[]): void {
  const stays = new Set(next);
  const gone = session.transcript.filter((e) => !stays.has(e));
  if (gone.length > 0) {
    session.earlier = [...(session.earlier ?? []), ...gone];
    session.earlierUnsaved = [...(session.earlierUnsaved ?? []), ...gone];
  }
  session.transcript = next;
}
