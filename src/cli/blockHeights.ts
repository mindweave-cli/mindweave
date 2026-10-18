/**
 * blockHeights.ts — bounding the table of measured block heights.
 *
 * The heights themselves live in a ref inside App; this is the one rule about them
 * worth testing on its own, because getting it wrong is invisible in both directions.
 *
 * The table used to be a WeakMap, which needed no bounding at all: a block dropped past
 * the scrollback cap became unreachable and took its height with it. It is a Map now,
 * keyed by block id, because a resize has to walk every entry to rescale it and a
 * WeakMap cannot be walked. That buys the rescale and inherits a leak: a long session
 * appends blocks forever and nothing would ever remove their heights.
 *
 * Ids are handed out by the reducer in ascending order and never reused, so "older than
 * the oldest block still on screen" is simply a smaller id, and pruning is a threshold
 * rather than a set difference. Kept generous, because the cost of dropping a height
 * that is still wanted is far higher than the cost of keeping one that is not: the block
 * has to be laid out in full again to get it back.
 */

import { SCROLLBACK_BLOCKS } from "./virtualWindow.js";
import type { Block } from "./transcript.js";

/** How many heights to keep: the whole scrollback and a margin, so pruning can never reach a block
 *  that is still being rendered.
 *
 *  This was a flat 600, sized when the scrollback was 150 blocks and left behind when the scrollback
 *  grew to 10,000. The measured prefix stops at the first block with no height, so once a session passed
 *  600 blocks the OLDEST height was pruned, the prefix ended at block 0, and every block was laid out in
 *  full on every frame: a long session got slower and slower, and stayed slow after reopening it. */
export const MAX_TRACKED_HEIGHTS = SCROLLBACK_BLOCKS + 1000;

/** Prune when the table grows past the cap, oldest ids first (in place). */
export function pruneHeights(table: Map<number, unknown>, cap = MAX_TRACKED_HEIGHTS): void {
  if (table.size <= cap) return;
  // Ascending, so the ids removed are the oldest blocks — the ones already dropped past
  // the scrollback cap and therefore never rendered again.
  const ids = [...table.keys()].sort((a, b) => a - b);
  for (let i = 0; i < ids.length - cap; i++) table.delete(ids[i]!);
}

/** A recorded height, and whether it is a measurement or an estimate. */
export interface HeightEntry {
  height: number;
  /** The exact block object the height was taken from. */
  block: unknown;
  /** True when a width change RESCALED this rather than it being measured. */
  scaled?: boolean;
}

/**
 * Whether a block that is about to be laid out still owes a real measurement (pure).
 *
 * Two ways it can. The obvious one is a block that changed — the reducer hands back a
 * new object, so the height recorded against the old one describes different content.
 *
 * The one that was missed for longer is a SCALED entry. A width change multiplies every
 * recorded height by the ratio of the widths, which keeps the scroll arithmetic roughly
 * right without laying the whole scrollback out again. But the entry it leaves behind
 * still points at the same block object, so a check for "did the block change" says no
 * and the estimate is never paid off. It then sizes a spacer in the virtual window
 * forever, and since a paragraph that wrapped to one row does not become 1.4 rows at a
 * narrower width but two, blocks land a row or two from where they belong — text that
 * will not settle, worst where the terminal is narrowest.
 *
 * The entry stays USABLE either way; this only decides whether it is worth re-measuring
 * when the block happens to be rendered. That keeps the cost bounded by what is on
 * screen rather than by the length of the session.
 */
export function needsMeasure(entry: HeightEntry | undefined, block: unknown): boolean {
  if (entry === undefined) return true;
  if (entry.block !== block) return true;
  return entry.scaled === true;
}

/**
 * How many of the newest blocks are laid out in full when a long conversation is opened, to learn their
 * heights. They are the ones in view and the ones just above, so they are measured for real; the older
 * ones take an estimate (see `seedHeights`).
 */
export const FULL_TAIL_BLOCKS = 300;

/** Rows a piece of text takes at `columns`, wrapping long lines (a blank line is a row). */
function textRows(text: string | undefined, columns: number): number {
  if (!text) return 0;
  const room = Math.max(10, columns - 4);
  let rows = 0;
  for (const line of text.split("\n")) rows += Math.max(1, Math.ceil(line.length / room));
  return rows;
}

/** The most rows a block's detail is allowed to be guessed at: a long output is shown cut short. */
const DETAIL_GUESS_CAP = 12;

/**
 * A rough height, in rows, for a block that has not been laid out (pure).
 *
 * Only used for blocks far above the window, whose real height is measured the first time they come near
 * it, so it needs to be sensible and nothing more: a wrong guess moves the scroll extent a little until
 * the block is measured, and cannot change what is drawn in view. Open rows and expanded output are
 * counted because they are what makes a block tall.
 */
export function estimateHeight(block: Block, columns: number): number {
  let rows = 1;
  switch (block.kind) {
    case "user":
    case "assistant":
    case "error":
    case "completion":
    case "note":
    case "context":
      rows = textRows(block.text, columns);
      break;
    case "notice":
      rows = textRows(block.title, columns) + textRows(block.body, columns);
      break;
    case "help":
      rows = 1 + textRows(block.text, columns);
      break;
    case "tool":
      rows = 1 + (block.expanded && block.full ? textRows(block.full, columns) : Math.min(textRows(block.detail, columns), DETAIL_GUESS_CAP));
      break;
    case "work":
      rows = 1;
      if (block.open) {
        for (const it of block.items) rows += 1 + (it.open ? Math.min(textRows(it.full ?? it.detail, columns), DETAIL_GUESS_CAP) : 0);
      }
      break;
    case "edits":
      if (block.items.length < 2) {
        rows = 0;
        for (const it of block.items) rows += 2 + (it.open && it.full ? textRows(it.full, columns) : Math.min(textRows(it.detail, columns), DETAIL_GUESS_CAP));
        rows -= 1;
      } else {
        rows = 1;
        for (const it of block.items) if (block.open || it.open) rows += 1 + (it.open ? Math.min(textRows(it.full ?? it.detail, columns), DETAIL_GUESS_CAP) : 0);
      }
      break;
    case "subagent":
      rows = 0;
      for (const ag of block.agents) rows += 3 + (ag.open ? 4 + ag.items.length : 0);
      break;
    case "compaction":
      rows = 6;
      break;
  }
  // The blank row that separates one block from the next.
  return Math.max(1, rows) + 1;
}

/**
 * Give every finished block from `from` up to the newest `FULL_TAIL_BLOCKS` an ESTIMATED height (in place).
 *
 * A conversation that is opened again has no heights, and without these the only way to learn them is to
 * lay every block out in full: about a millisecond each, so a very long session sat for half a minute
 * with nothing on screen. An estimate is marked `scaled`, the same flag a window resize uses, which keeps
 * it usable as a spacer but makes the block count as unmeasured: the first time it is rendered it is laid
 * out and the estimate is replaced by a fact. So the cost is bounded by what is near the window and not by
 * the length of the conversation, and a block is never left with a guess once it has been looked at.
 *
 * Only blocks that are done: an open one changes with every token and is always among the newest.
 * Returns how many were given an estimate.
 */
export function seedHeights(table: Map<number, HeightEntry>, blocks: readonly Block[], from: number, columns: number): number {
  let seeded = 0;
  const end = blocks.length - FULL_TAIL_BLOCKS;
  for (let i = Math.max(0, from); i < end; i++) {
    const block = blocks[i]!;
    if (!block.done) continue;
    const entry = table.get(block.id);
    if (entry !== undefined && entry.block === block) continue;
    table.set(block.id, { height: estimateHeight(block, columns), block, scaled: true });
    seeded++;
  }
  return seeded;
}
