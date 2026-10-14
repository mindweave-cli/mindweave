/**
 * selectionGrow.ts — a selection that keeps growing while the view scrolls.
 *
 * `selection.ts` selects cells of the SCREEN and copies what is on the screen. That is
 * simple and safe, and it has two limits a reader meets at once: scrolling moves the text
 * out from under the highlight (so it was dropped), and a screen is all that can be copied
 * (a long output, or a reply taller than the terminal, took several separate selections).
 *
 * Here the two ends of a selection are positions in the CONVERSATION, not on the screen:
 *
 *      block id  +  a row inside that block  +  a column
 *
 * A block's id never changes, and a row counted from the top of its own block does not move
 * when something ABOVE it grows, shrinks or re-measures (a row opened, a height estimate
 * corrected as old text is scrolled into view) nor when something is appended below. A row
 * counted from the top of the whole transcript has neither property, and an earlier version
 * of this idea that used one could shift the join between two scrolls by a few rows.
 *
 * What gets copied cannot be read back from anything but the screen, because the text of a
 * row only exists once it has been laid out and wrapped. So while a selection is alive,
 * every frame hands the rows it shows to a `RowStore`, keyed the same way. Scrolling past a
 * row is what puts it in the store; copying is assembling the rows between the two ends.
 * A row that was never on screen cannot be copied, and the store knows which those are
 * (`complete`), so the caller can say so rather than hand over a quiet hole.
 *
 * Pure apart from the store and the cell writes of `applyGrowSelection`; nothing here knows
 * about React, Ink or the pointer, which is what lets the rules be tested without a terminal.
 */
import { ATTR, DEFAULT_COLOR, WIDE_CONTINUATION, type Screen } from "./framebuffer/screen.js";

/** A row of the conversation: which block, and how far down inside it (0 is its first row). */
export interface RowKey {
  id: number;
  off: number;
}

/** A place in the conversation: a row, and a column on it. */
export interface Anchored extends RowKey {
  x: number;
}

/** The selection: where the drag began, where it is now, and whether the button is down. */
export interface GrowSel {
  anchor: Anchored;
  focus: Anchored;
  dragging: boolean;
}

/** Where one block sits on the screen right now. Ordered by `top`. */
export interface BlockSpan {
  id: number;
  top: number;
  height: number;
}

/** The screen rows that show the conversation: `top` inclusive, `bottom` exclusive. */
export interface View {
  top: number;
  bottom: number;
}

/** Order two rows of the conversation. Block ids rise along the transcript. */
export function compareKeys(a: RowKey, b: RowKey): number {
  return a.id !== b.id ? a.id - b.id : a.off - b.off;
}

/** The block boxes on screen, ordered by where they start (pure). */
export function sortSpans(spans: BlockSpan[]): BlockSpan[] {
  return [...spans].sort((a, b) => a.top - b.top);
}

/** The conversation row shown on screen row `y`, or null where no block is (pure). */
export function keyAtRow(spans: readonly BlockSpan[], y: number): RowKey | null {
  for (const s of spans) {
    if (y >= s.top && y < s.top + s.height) return { id: s.id, off: y - s.top };
  }
  return null;
}

/** The screen row currently showing a conversation row, or null when it is not on screen (pure). */
export function rowOfKey(spans: readonly BlockSpan[], key: RowKey): number | null {
  const s = spans.find((b) => b.id === key.id);
  if (!s || key.off < 0 || key.off >= s.height) return null;
  return s.top + key.off;
}

/** True when the drag never left the cell it began on, so nothing is selected. */
export function isEmptyGrow(sel: GrowSel): boolean {
  return compareKeys(sel.anchor, sel.focus) === 0 && sel.anchor.x === sel.focus.x;
}

/** The two ends in reading order, whichever way the drag went. */
export function normalizeGrow(sel: GrowSel): { start: Anchored; end: Anchored } {
  const { anchor, focus } = sel;
  const c = compareKeys(anchor, focus);
  const anchorFirst = c < 0 || (c === 0 && anchor.x <= focus.x);
  return anchorFirst ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/** The columns the selection covers on one row, or null when the row is outside it (pure). */
export function coverage(sel: GrowSel, key: RowKey, width: number): { from: number; to: number } | null {
  const { start, end } = normalizeGrow(sel);
  if (compareKeys(key, start) < 0 || compareKeys(key, end) > 0) return null;
  const from = compareKeys(key, start) === 0 ? start.x : 0;
  const to = compareKeys(key, end) === 0 ? end.x + 1 : width;
  return { from: Math.max(0, Math.min(from, width)), to: Math.max(0, Math.min(to, width)) };
}

/**
 * Where the pointer is, as a place in the conversation (pure).
 *
 * Above the view is the start of its first row and below it is the end of its last: a
 * pointer pulled out past an edge to make the view scroll keeps selecting whole lines, the
 * way it does in a document. Null when there is no block there to select (blank space
 * above a conversation that does not fill the screen).
 */
export function focusFromPointer(spans: readonly BlockSpan[], view: View, x: number, y: number, width: number): Anchored | null {
  let row = y;
  let col = x;
  if (y < view.top) {
    row = view.top;
    col = 0;
  } else if (y >= view.bottom) {
    row = view.bottom - 1;
    col = width - 1;
  }
  const key = keyAtRow(spans, row);
  if (!key) return null;
  return { ...key, x: Math.max(0, Math.min(col, width - 1)) };
}

/**
 * How far to scroll for a pointer held at `y` while dragging (pure). Positive scrolls back
 * (up), negative forward (down), zero not at all.
 *
 * Past the edge of the view the pointer asks for it, and the further past, the faster. When
 * the view reaches the top or bottom of the whole screen there is nothing beyond it for the
 * pointer to go to, so the edge row itself asks, gently: otherwise a conversation that fills
 * the screen could never be selected past its first or last row.
 */
export function edgeLines(y: number, view: View, screenRows: number): number {
  const speed = (d: number) => (d <= 1 ? 2 : d <= 3 ? 3 : 6);
  if (y < view.top || (y === view.top && view.top === 0)) return speed(view.top - y);
  if (y >= view.bottom || (y === view.bottom - 1 && view.bottom >= screenRows)) return -speed(y - (view.bottom - 1));
  return 0;
}

/** Write one row's worth of the highlight: the same flat inverse block `selection.ts` draws. */
function tint(screen: Screen, y: number, from: number, to: number): void {
  for (let x = from; x < to; x++) {
    const i = screen.index(x, y);
    screen.fg[i] = DEFAULT_COLOR;
    screen.bg[i] = DEFAULT_COLOR;
    screen.attrs[i] = (screen.attrs[i]! | ATTR.inverse) & ~ATTR.dim;
  }
}

/** Highlight the part of the selection that is on screen, in place, on the frame about to be drawn. */
export function applyGrowSelection(screen: Screen, sel: GrowSel | null, spans: readonly BlockSpan[], view: View): void {
  if (!sel || isEmptyGrow(sel)) return;
  const top = Math.max(0, view.top);
  const bottom = Math.min(screen.height, view.bottom);
  // The two-column strip on the left holds the dot or the ">" and nothing else, so it is never
  // highlighted: not the marker, not the blank cells beside it, and not the same strip on the rows
  // under it or on the empty rows between messages. Only a strip that really is that (a marker and a
  // space, or two blanks) is left out, so text that starts at column 0 stays selectable.
  for (let y = top; y < bottom; y++) {
    const key = keyAtRow(spans, y);
    if (!key) continue;
    const cov = coverage(sel, key, screen.width);
    if (!cov) continue;
    let from = cov.from;
    if (from < 2) {
      const c0 = screen.chars[screen.index(0, y)]!;
      const c1 = screen.chars[screen.index(1, y)]!;
      if (((c0 === 0x25cf || c0 === 0x3e) && c1 === 32) || (blankCell(c0) && blankCell(c1))) from = 2;
    }
    // A stretch with nothing written in it is not highlighted: empty space has nothing to select.
    let written = false;
    for (let x = from; x < cov.to && !written; x++) written = !blankCell(screen.chars[screen.index(x, y)]!);
    if (written) tint(screen, y, from, cov.to);
  }
}

/** The last click on the conversation, and how many in a row it was. */
export interface ClickRecord {
  at: number;
  x: number;
  y: number;
  count: number;
}

/**
 * Which click in a row this one is (pure).
 *
 * A click counts as the next one only when it comes soon enough after the last and lands on the
 * same place (the same row, within a couple of columns). Too late, or somewhere else, and it is a
 * first click again, so a stray second click never selects anything by accident. A fourth click
 * starts over rather than counting on.
 */
export function nextClick(prev: ClickRecord | null, now: number, x: number, y: number, windowMs: number): ClickRecord {
  const again = !!prev && now - prev.at <= windowMs && prev.y === y && Math.abs(prev.x - x) <= 2 && prev.count < 3;
  return { at: now, x, y, count: again ? prev!.count + 1 : 1 };
}

/** Whether a cell holds nothing to select: a space, or a cell that was never written. */
function blankCell(ch: number): boolean {
  return ch === 32 || ch === 0;
}

/**
 * The word under a click, as the columns it covers, both ends included (pure): the unbroken
 * run of characters on the row around column `x`. Null when `x` is on a blank, where there is
 * nothing to select.
 */
export function wordBounds(cells: ArrayLike<number>, x: number): { from: number; to: number } | null {
  if (x < 0 || x >= cells.length || blankCell(cells[x]!)) return null;
  let from = x;
  while (from > 0 && !blankCell(cells[from - 1]!)) from--;
  let to = x;
  while (to < cells.length - 1 && !blankCell(cells[to + 1]!)) to++;
  return { from, to };
}

/**
 * The whole line, as the columns from its first character to its last (pure). Null when the
 * row is blank.
 */
export function lineBounds(cells: ArrayLike<number>): { from: number; to: number } | null {
  let from = 0;
  while (from < cells.length && blankCell(cells[from]!)) from++;
  if (from >= cells.length) return null;
  let to = cells.length - 1;
  while (to > from && blankCell(cells[to]!)) to--;
  return { from, to };
}

/** The marker a block starts with in the gutter: the agent's dot, or the ">" of your own message, and its space. */
const GUTTER_MARK = /^[●>] /;
/** The two columns of gutter the rest of a block's rows are indented by. */
const GUTTER_INDENT = /^ {1,2}/;

/** One captured row's characters, one entry per column. */
type RowCells = Uint32Array;

/** The result of assembling a selection's text. */
export interface GrownText {
  text: string;
  /** False when some row between the two ends was never on screen, so it is missing. */
  complete: boolean;
}

/**
 * The rows seen on screen while a selection was alive.
 *
 * Keyed by block and row-in-block, so what is stored stays right however the transcript
 * moves around it. A row is stored again every frame it is visible, so text that is still
 * being written (a streaming reply, a running command) is the latest version of it.
 */
export class RowStore {
  private readonly rows = new Map<number, Map<number, RowCells>>();
  /** The last height each block was seen at, to know which rows of it should exist. */
  private readonly heights = new Map<number, number>();
  width = 0;

  clear(): void {
    this.rows.clear();
    this.heights.clear();
    this.width = 0;
  }

  /**
   * Take what the frame shows.
   *
   * `mask` is a stretch of one row that is not conversation: the "catch up" chip drawn over
   * the view's last row. A row already stored is left alone then (it was captured clean
   * when it was somewhere else); one that was not is stored with those cells blanked, so
   * the chip's words can never end up in what is copied.
   */
  capture(screen: Screen, spans: readonly BlockSpan[], view: View, mask?: { y: number; x0: number; x1: number } | null): void {
    this.width = screen.width;
    for (const s of spans) this.heights.set(s.id, s.height);
    const top = Math.max(0, view.top);
    const bottom = Math.min(screen.height, view.bottom);
    for (let y = top; y < bottom; y++) {
      const key = keyAtRow(spans, y);
      if (!key) continue;
      let inner = this.rows.get(key.id);
      if (!inner) this.rows.set(key.id, (inner = new Map()));
      const masked = mask && mask.y === y;
      if (masked && inner.has(key.off)) continue;
      const cells = new Uint32Array(screen.width);
      for (let x = 0; x < screen.width; x++) cells[x] = screen.chars[screen.index(x, y)]!;
      if (masked) for (let x = Math.max(0, mask.x0); x < Math.min(screen.width, mask.x1); x++) cells[x] = 32;
      inner.set(key.off, cells);
    }
  }

  /** Whether a conversation row has been seen. */
  has(key: RowKey): boolean {
    return this.rows.get(key.id)?.has(key.off) ?? false;
  }

  /**
   * The text between the two ends, as it would be pasted.
   *
   * `orderedIds` is every block in transcript order, and `knownHeight` what is known of a
   * block that was measured without being drawn. Together they say which rows SHOULD exist
   * between the ends, so a row that never reached the screen is reported (`complete`)
   * instead of leaving the join quietly wrong.
   */
  text(sel: GrowSel, orderedIds: readonly number[], knownHeight?: (id: number) => number | undefined): GrownText {
    const { start, end } = normalizeGrow(sel);
    const out: string[] = [];
    let complete = true;
    for (const id of orderedIds) {
      if (id < start.id || id > end.id) continue;
      const inner = this.rows.get(id);
      const height = this.heights.get(id) ?? knownHeight?.(id);
      if (height === undefined) {
        // Never drawn and never measured: nothing about it is known.
        complete = false;
        continue;
      }
      const first = id === start.id ? start.off : 0;
      const last = id === end.id ? Math.min(end.off, height - 1) : height - 1;
      // Whether this block's marker (the dot or the ">") was taken off its first row, so the rows
      // that carry on under it lose the gutter they were indented by.
      let markerGone = false;
      for (let off = first; off <= last; off++) {
        const cells = inner?.get(off);
        if (!cells) {
          complete = false;
          continue;
        }
        const cov = coverage(sel, { id, off }, cells.length);
        if (!cov) continue;
        let line = cellsText(cells, cov.from, cov.to);
        // The marker in the gutter belongs to the screen, not to the text. It goes only when the
        // selection takes in the start of the row: a word picked from the middle has no marker.
        if (cov.from === 0) {
          if (off === 0 && GUTTER_MARK.test(line)) {
            line = line.replace(GUTTER_MARK, "");
            markerGone = true;
          } else if (markerGone) {
            line = line.replace(GUTTER_INDENT, "");
          }
        }
        out.push(line);
      }
    }
    return { text: out.join("\n"), complete };
  }
}

/** A stretch of a row as text: no right halves of wide characters, no padding at the end. */
function cellsText(cells: RowCells, from: number, to: number): string {
  let line = "";
  for (let x = from; x < to; x++) {
    const ch = cells[x]!;
    // The right half of a wide character carries no codepoint of its own, and the renderer's
    // "unknown cell" sentinel is not a character; neither may reach fromCodePoint, which throws.
    if (ch === WIDE_CONTINUATION || ch > 0x10ffff) continue;
    line += String.fromCodePoint(ch);
  }
  return line.replace(/\s+$/, "");
}
