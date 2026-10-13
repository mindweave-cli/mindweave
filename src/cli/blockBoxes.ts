/**
 * blockBoxes.ts — where each block of the conversation is on screen right now.
 *
 * A selection that follows the conversation needs to say which block and which row of it a
 * screen row belongs to. Every block the transcript draws sits in a box of its own, and the
 * box registers here while it is drawn. Positions are NOT stored: they change every time the
 * view scrolls or something above grows, so each is measured at the moment it is asked for,
 * which is the only time the answer is certain (the same rule `expandHits` follows).
 *
 * A block scrolled out of the window is not drawn, so it drops out by itself; the rows it
 * had are not on screen either.
 */
import { measureElement, type DOMElement } from "ink";
import { sortSpans, type BlockSpan } from "./selectionGrow.js";

const boxes = new Map<number, DOMElement>();

/**
 * Called from a block's own box, on every render.
 *
 * `null` (the box being let go) is IGNORED, and that is deliberate. React detaches a ref and
 * attaches the next one on every commit, and a frame is written in between: at that moment
 * the registry would be empty and every row on screen would belong to no block. The box
 * itself is the same object from one render to the next while the block is drawn, so the
 * entry stays right; one whose box has really gone is dropped when it is next looked at
 * (`blockSpans`), by it no longer being attached to the tree.
 */
export function registerBlockBox(id: number, node: DOMElement | null): void {
  if (!node) return;
  boxes.set(id, node);
  // Boxes are only forgotten when a selection looks at them, and most sessions never make one:
  // without this the registry would keep every block ever drawn alive (and its whole tree).
  // The window of drawn blocks is far smaller than this, so a pass here is rare and cheap.
  if (boxes.size > PRUNE_ABOVE) for (const [key, box] of boxes) if (!box.parentNode) boxes.delete(key);
}

/** More registered boxes than this and the ones no longer in the tree are dropped. */
const PRUNE_ABOVE = 256;

/** Every drawn block and where it is, ordered from the top of the screen. `frameTop` is where the layout's first row is. */
export function blockSpans(frameTop: number): BlockSpan[] {
  const out: BlockSpan[] = [];
  for (const [id, node] of boxes) {
    if (!node.parentNode) {
      boxes.delete(id);
      continue;
    }
    const m = measureElement(node);
    out.push({ id, top: frameTop + m.y, height: m.height });
  }
  return sortSpans(out);
}

/** How many blocks are registered (for tests). */
export function registeredBlocks(): number {
  return boxes.size;
}
