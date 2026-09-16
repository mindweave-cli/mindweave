/**
 * scrollPill.ts — the chip that says you are not at the bottom.
 *
 * Scrolling back in the full-screen shell used to leave no trace of itself. The
 * transcript moved and nothing else did: no marker, no way back other than scrolling
 * the whole distance again by hand. That is fine for one screen and quietly awful for
 * fifty, and it is worst during a turn — the reply lands below the fold, the screen
 * stays exactly as it was, and the app looks like it has stopped.
 *
 * So a chip rides the last row of the viewport whenever the view is scrolled back. It
 * says one of two things:
 *
 *   - **Catch up** — you are reading history and nothing new has arrived.
 *   - **Catch up — N new** — the model has answered since you scrolled away.
 *
 * Both name the key, because a chip that reports a state without offering the way out
 * of it is only half an answer.
 *
 * ## Why this is a module and not four lines in the view
 *
 * Every clause below is a rule with a reason, and each one is a thing that can be got
 * wrong invisibly: showing the chip over a transcript that does not actually scroll,
 * advertising a key that is currently inert, or painting a 27-column chip into a
 * 20-column terminal. Pure input, pure output, so all of that is tested rather than
 * eyeballed on one terminal at one width.
 */

/** Everything the chip's text depends on. */
export interface PillInput {
  /**
   * Lines actually scrolled back — `chatLayout`'s clamped `scrolled`, NOT the raw
   * counter.
   *
   * The raw counter keeps climbing while the wheel turns even when there is nothing
   * left to scroll to, so a short conversation in a tall window reports "scrolled" the
   * moment the wheel is touched. The clamped number is the honest one: it is zero
   * whenever the whole transcript is already on screen.
   */
  scrolled: number;
  /** Replies that have landed since the scroll began. */
  newReplies: number;
  /**
   * True while a picker, the key manager or an approval owns the keyboard.
   *
   * The chip hides then, because the scroll keys are switched off for the same reason —
   * so leaving it up would name a chord that currently does nothing.
   */
  overlayOpen: boolean;
  /** Terminal columns. */
  width: number;
}

/**
 * The chip, ready to paint, or null for "show nothing".
 *
 * The returned string INCLUDES the single space at each end. The padding is what makes
 * it read as a chip rather than as a word dropped into the transcript, so it belongs
 * with the text it pads — and returning the exact painted string means the width
 * guard below is measuring the thing that actually lands on the row.
 */
export function scrollPill(input: PillInput): string | null {
  if (input.scrolled <= 0 || input.overlayOpen) return null;

  const label =
    input.newReplies > 0
      ? `Catch up — ${input.newReplies} new`
      : "Catch up";

  // The chord first, since it is the more useful half on a wide terminal.
  const full = ` ${label} (ctrl+End) ↓ `;
  if (full.length + 2 <= input.width) return full;
  // Narrow: the state is still worth saying even when the chord no longer fits. The
  // arrow stays — it is what makes the chip legible as "there is more below".
  const bare = ` ${label} ↓ `;
  if (bare.length + 2 <= input.width) return bare;
  // Narrower than the shortest honest form. A chip clipped mid-word is worse than none:
  // it reads as corruption, which is a bug report about the wrong thing.
  return null;
}

/**
 * Replies that arrived after `mark` (pure).
 *
 * Counts REPLIES, not blocks. A turn that reads six files and edits two appends nine
 * blocks, and "9 new" for one answer is a number that means nothing to the person
 * reading it — they are waiting for the reply, and the tool rows are how it got there.
 *
 * Walks from the newest and stops at the mark. Block ids are handed out in order, so
 * that break is exact, and the scan costs what has happened since you scrolled away
 * rather than what has happened all session.
 */
export function countNewReplies(blocks: readonly { id: number; kind: string }[], mark: number | null): number {
  if (mark === null) return 0;
  let n = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.id <= mark) break;
    if (block.kind === "assistant") n++;
  }
  return n;
}

/** Where the chip sits on screen, in zero-based cell coordinates. */
export interface PillBounds {
  row: number;
  /** First column the chip covers. */
  left: number;
  /** Last column the chip covers, inclusive. */
  right: number;
}

/**
 * The cells the chip occupies (pure).
 *
 * Ink centres it with `justifyContent`, which floors: a chip of `n` columns in a `width`
 * terminal starts at `floor((width - n) / 2)`. Computed rather than measured because the
 * chip has no children to measure and the arithmetic is the layout's own — and because a
 * click has to be answered from a pointer handler that runs between frames, where a
 * measurement would be a frame out of date.
 */
export function pillBounds(pill: string, width: number, row: number): PillBounds {
  const left = Math.max(0, Math.floor((width - pill.length) / 2));
  return { row, left, right: left + pill.length - 1 };
}

/**
 * Whether a pointer landed on the chip (pure).
 *
 * The whole chip, including the padding space at each end — that space is what makes it
 * read as a button, so it is part of the button. Exactly one row: the chip is one row
 * tall, and accepting the rows around it would swallow clicks meant for the transcript.
 */
export function hitsPill(bounds: PillBounds, x: number, y: number): boolean {
  return y === bounds.row && x >= bounds.left && x <= bounds.right;
}
