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
  // The session notes cover "the first N entries", an index into the transcript that is
  // about to change. Dropping the oldest rounds on an overflow slid every entry forward and
  // left N pointing at entries the notes never saw, so a later compaction from the notes
  // would have kept the wrong half. Re-measure it against what is left: the covered entries
  // that survived, counted from the front. Callers that build a transcript whose front is
  // something new (a summary, the notes themselves) set the boundary themselves afterwards.
  if (session.sessionMemoryEntries !== undefined) {
    const covered = new Set(session.transcript.slice(0, session.sessionMemoryEntries));
    let n = 0;
    while (n < next.length && covered.has(next[n]!)) n++;
    session.sessionMemoryEntries = n;
  }
  session.transcript = next;
}
