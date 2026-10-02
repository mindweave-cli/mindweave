/**
 * revealPace.ts — the tempo the transcript reveals at.
 *
 * A turn's events do not arrive evenly. A model may work one step at a time, or
 * decide to fan out and ask for eight things at once; the engine runs the safe ones
 * concurrently, so their rows finish within milliseconds of each other. Without a
 * beat those two behaviours look completely different on screen: a calm sequence,
 * then a stall, then eight rows landing in one paint. The work was fine. The screen
 * was reporting the model's internal batching, which is not something a reader can
 * act on and not something they asked to see.
 *
 * This beat was three seconds once, was removed, and is back deliberately. Both
 * decisions were right about different things, and the distinction is the whole
 * point of this file:
 *
 *   - Removing it was right about TEXT. Words arriving with motion read as a
 *     typewriter, and a tool that is quick should look quick.
 *   - Removing it was wrong about TOOL ROWS. There the burst is not decoration, it
 *     is the model's concurrency leaking into the interface, and the reader loses
 *     the thread of what happened.
 *
 * So the rhythm is uniform and unconditional: every block that appears waits the
 * same beat since the last one, whatever produced it and whatever the queue is
 * doing behind it. A turn that finished a second ago drains at the same pace as one
 * still running — deliberately, because a queue that speeds up once the work is
 * done is the interface getting impatient with itself, which is the thing that
 * reads as animation. Esc still flushes; that is the user overriding the rhythm,
 * which outranks it.
 *
 * What this is NOT: an added sleep. The wait is a MINIMUM since the last reveal, so
 * a model that thought for three seconds between calls pays nothing here. Only a
 * burst — rows that genuinely arrived together — is spaced out. Turns that already
 * had the right rhythm are untouched.
 */

/** Read at import. Accepts 0, which restores the old instant behaviour. */
function pacingFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * The beat, in milliseconds.
 *
 * Two seconds: fast enough that a short turn does not feel withheld, slow enough
 * that eight rows are eight readable events rather than one paint. Overridable with
 * `MINDWEAVE_REVEAL_GAP_MS` because this is a question of feel, and the file has
 * always said so — it is settled by using it, not by a test. Zero restores the
 * previous behaviour exactly.
 */
export const REVEAL_GAP_MS = pacingFromEnv("MINDWEAVE_REVEAL_GAP_MS", 2000);

/** Everything the wait depends on. */
export interface PaceInput {
  /** Esc was pressed: the user has asked to see the rest now. */
  flush: boolean;
}

/**
 * How long to hold before revealing the next block. The beat, every time.
 *
 * It ADDS to whatever the model already spent; it is not a minimum that the
 * model's own thinking can absorb. That is the correction to a wrong assumption
 * this file used to make: subtracting elapsed time meant a model that paused three
 * seconds between calls produced no beat at all, so the calm turns stayed calm and
 * the fast ones — the batches, the ones that needed the beat — got nothing. Worse,
 * it made the rhythm a function of model speed, which is the one thing the reader
 * should never be able to feel. Thinking time is the model's; the beat is the
 * screen's; a reader gets both.
 */
export function revealWait({ flush }: PaceInput): number {
  if (flush) return 0;
  return REVEAL_GAP_MS;
}

/**
 * Whether unsealed narration is waiting, and would actually become a visible block.
 *
 * Streamed text accumulates silently and renders nothing until it seals (whole-block
 * reveal, see transcript.ts), and `toolStart` seals it as part of its own action. So
 * a sentence and the tool row it introduces reach the terminal in the SAME paint,
 * landing together as one clump — the thing the beat exists to prevent, happening in
 * the one place the pacer could not see.
 *
 * Sealing it on its own beat first lets the sentence land alone and be read before
 * the row arrives under it. This holds for EVERY sentence in a turn, not just the first:
 * narration used to be capped at one line per turn, so a second sentence sealed to nothing
 * and was skipped here, and that cap was removed (see sealAssistant). Left in place, this
 * check made the second and later sentences land in the same paint as their tool row.
 */
export function narrationPending(s: { openAsstId: number | null; raw: string; narrated?: boolean }): boolean {
  return s.openAsstId !== null && s.raw.trim().length > 0;
}
