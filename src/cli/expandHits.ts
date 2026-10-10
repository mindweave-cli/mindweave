/**
 * expandHits.ts — which row a click landed on.
 *
 * A row that can open (see Block `full`) registers its box here while it is on screen.
 * Nothing is recorded about WHERE it is: positions change every time the view scrolls,
 * a row above grows, or the window is resized, so a stored position is wrong a moment
 * after it is written. The box is measured at the instant of the click instead, which
 * is the one time the answer is certain.
 *
 * A row that has scrolled out of the virtual window is unmounted and drops out of the
 * map by itself (its ref is called with null), so a click can never land on a row that
 * is not there.
 */
import { measureElement, type DOMElement } from "ink";

const nodes = new Map<number, DOMElement>();

/**
 * One command inside a commands row is its own place to click, next to the row's header.
 * It is registered under a NEGATIVE number built from the row and the command's place in it,
 * so the registry stays one flat map of numbers and an ordinary row's id is never mistaken
 * for one. `hitBlock` and `hitItem` take it apart again.
 */
const ITEMS_PER_BLOCK = 4096;
export function itemHit(blockId: number, index: number): number {
  return -(blockId * ITEMS_PER_BLOCK + index + 1);
}
/** The block a hit belongs to, whether it landed on the block or on one command in it. */
export function hitBlock(hit: number): number {
  return hit >= 0 ? hit : Math.floor((-hit - 1) / ITEMS_PER_BLOCK);
}
/** Which command in the block a hit landed on, or -1 when it landed on the block itself. */
export function hitItem(hit: number): number {
  return hit >= 0 ? -1 : (-hit - 1) % ITEMS_PER_BLOCK;
}

/** Called from a row's ref. `null` is the row going away. */
export function registerExpandable(id: number, node: DOMElement | null): void {
  if (node) nodes.set(id, node);
  else nodes.delete(id);
}

export interface RowSpan {
  id: number;
  /** First screen row the block covers. */
  top: number;
  height: number;
}

/**
 * The block under a screen row, or null (pure).
 *
 * `view` is the transcript's own area. A block scrolled out of it is still laid out, and
 * its box can sit over the input or the status line; without this check a click on the
 * input would fold something that is not even visible.
 */
export function rowAt(spans: RowSpan[], y: number, view: { top: number; height: number }): number | null {
  if (y < view.top || y >= view.top + view.height) return null;
  for (const s of spans) {
    if (y >= s.top && y < s.top + s.height) return s.id;
  }
  return null;
}

/**
 * The expandable block under a click, measured now.
 *
 * `frameTop` is where the layout's first row sits on the screen: zero for the full-screen
 * shell, which owns every row, and the live region's offset in the inline reading view.
 */
export function expandableAt(
  y: number,
  frameTop: number,
  chat: DOMElement | null,
  measure: (node: DOMElement) => { y: number; height: number } = measureElement,
): number | null {
  if (!chat || nodes.size === 0) return null;
  const c = measure(chat);
  const spans: RowSpan[] = [];
  for (const [id, node] of nodes) {
    const m = measure(node);
    spans.push({ id, top: frameTop + m.y, height: m.height });
  }
  return rowAt(spans, y, { top: frameTop + c.y, height: c.height });
}
