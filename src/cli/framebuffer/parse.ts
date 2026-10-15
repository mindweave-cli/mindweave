/**
 * parse.ts — Ink's frame string into a cell grid.
 *
 * Ink hands the terminal one string per frame: lines separated by `\n`, with SGR
 * escape sequences (`\x1b[...m`) inline wherever the style changes. To diff frames
 * cell by cell we first have to know what each frame ACTUALLY PUTS in each cell,
 * which means interpreting those sequences the way a terminal would.
 *
 * So this is a very small terminal emulator: it walks the string carrying the
 * current pen (foreground, background, attributes), and every printable character
 * it meets is stamped into the grid at the cursor, which then advances.
 *
 * ## Scope, deliberately
 *
 * It handles what Ink emits and nothing else. Ink's frame content is styled text
 * and newlines — it does not move the cursor around inside a frame, because it
 * builds the whole frame as a string first (see `ink/build/ink.js`, which writes
 * `eraseLines(previousHeight) + wrappedOutput`). Any other CSI sequence is SKIPPED
 * rather than guessed at: skipping leaves the grid exactly as it was, which is the
 * safe direction to be wrong in, where guessing would corrupt every cell after it.
 *
 * The one non-SGR sequence that matters is the `eraseLines` prefix, and the caller
 * strips that before we ever see it — see `writer.ts`.
 */
import {
  ATTR,
  DEFAULT_COLOR,
  Screen,
  WIDE_CONTINUATION,
  paletteColor,
  rgbColor,
} from "./screen.js";
import { eastAsianWidth } from "get-east-asian-width";

/** The current pen — the style subsequent characters are written with. */
interface Pen {
  fg: number;
  bg: number;
  attrs: number;
}

/** A fresh pen: the terminal's own colours, no attributes. */
function resetPen(pen: Pen): void {
  pen.fg = DEFAULT_COLOR;
  pen.bg = DEFAULT_COLOR;
  pen.attrs = 0;
}

/**
 * Apply one SGR sequence's parameters to the pen.
 *
 * Returns nothing; mutates `pen`. Written as a loop with an index rather than a
 * `for..of` because the extended colour forms (`38;5;n` and `38;2;r;g;b`) consume
 * following parameters, so the cursor into the list has to move by more than one.
 */
function applySgr(pen: Pen, params: number[]): void {
  if (params.length === 0) {
    // A bare `\x1b[m` is `\x1b[0m` — a full reset.
    resetPen(pen);
    return;
  }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    switch (p) {
      case 0:
        resetPen(pen);
        break;
      case 1:
        pen.attrs |= ATTR.bold;
        break;
      case 2:
        pen.attrs |= ATTR.dim;
        break;
      case 3:
        pen.attrs |= ATTR.italic;
        break;
      case 4:
        pen.attrs |= ATTR.underline;
        break;
      case 7:
        pen.attrs |= ATTR.inverse;
        break;
      case 8:
        pen.attrs |= ATTR.hidden;
        break;
      case 9:
        pen.attrs |= ATTR.strikethrough;
        break;
      // 21/22 both end bold. 22 also ends dim, and clearing both for either is
      // deliberate: chalk emits 22 to close a bold span, and leaving dim set would
      // tint every cell after it.
      case 21:
      case 22:
        pen.attrs &= ~(ATTR.bold | ATTR.dim);
        break;
      case 23:
        pen.attrs &= ~ATTR.italic;
        break;
      case 24:
        pen.attrs &= ~ATTR.underline;
        break;
      case 27:
        pen.attrs &= ~ATTR.inverse;
        break;
      case 28:
        pen.attrs &= ~ATTR.hidden;
        break;
      case 29:
        pen.attrs &= ~ATTR.strikethrough;
        break;
      case 39:
        pen.fg = DEFAULT_COLOR;
        break;
      case 49:
        pen.bg = DEFAULT_COLOR;
        break;
      case 38:
      case 48: {
        // Extended colour: `38;5;n` (palette) or `38;2;r;g;b` (truecolour).
        const isFg = p === 38;
        const mode = params[i + 1];
        if (mode === 5 && params.length > i + 2) {
          const c = paletteColor(params[i + 2]!);
          if (isFg) pen.fg = c;
          else pen.bg = c;
          i += 2;
        } else if (mode === 2 && params.length > i + 4) {
          const c = rgbColor(params[i + 2]!, params[i + 3]!, params[i + 4]!);
          if (isFg) pen.fg = c;
          else pen.bg = c;
          i += 4;
        } else {
          // Malformed — consume the mode byte and carry on rather than
          // misreading the remaining parameters as colours.
          i += 1;
        }
        break;
      }
      default:
        if (p >= 30 && p <= 37) pen.fg = paletteColor(p - 30);
        else if (p >= 90 && p <= 97) pen.fg = paletteColor(p - 90 + 8);
        else if (p >= 40 && p <= 47) pen.bg = paletteColor(p - 40);
        else if (p >= 100 && p <= 107) pen.bg = paletteColor(p - 100 + 8);
        // Anything else is a code we do not model. Ignored, not guessed.
        break;
    }
  }
}

/** Reset a run of cells to default-styled blanks, the way an erase sequence does. */
function blank(screen: Screen, from: number, to: number): void {
  const lo = Math.max(0, Math.min(from, screen.chars.length));
  const hi = Math.max(lo, Math.min(to, screen.chars.length));
  screen.chars.fill(32, lo, hi);
  screen.fg.fill(DEFAULT_COLOR, lo, hi);
  screen.bg.fill(DEFAULT_COLOR, lo, hi);
  screen.attrs.fill(0, lo, hi);
}

/** Where the next character goes, carried from one line of a frame to the next. */
interface Cursor {
  x: number;
  y: number;
}

/**
 * Interpret one line of a frame: text and SGR styling, written at the cursor.
 *
 * Returns whether the line was PURE: nothing but printable characters and SGR sequences, so that what it
 * leaves in the grid depends only on the line itself, the pen it started with and the grid's width. Only a
 * pure line may be remembered (see `parseFrame`); anything that moves the cursor, erases, or is a control
 * character makes the result depend on more than the text.
 */
function parseLine(screen: Screen, frame: string, pen: Pen, cursor: Cursor, top: number): boolean {
  let pure = true;
  let x = cursor.x;
  let y = cursor.y;

  for (let i = 0; i < frame.length; ) {
    const ch = frame[i]!;

    if (ch === "\x1b") {
      // CSI: ESC [ params... final-byte
      if (frame[i + 1] === "[") {
        let j = i + 2;
        while (j < frame.length) {
          const c = frame.charCodeAt(j);
          // Parameter bytes are 0x30-0x3F, intermediates 0x20-0x2F; the final byte
          // is 0x40-0x7E and ends the sequence.
          if (c >= 0x40 && c <= 0x7e) break;
          j++;
        }
        const final = frame[j];
        const body = frame.slice(i + 2, j);
        const params = body === "" ? [] : body.split(";").map((s) => (s === "" ? 0 : Number.parseInt(s, 10) || 0));
        if (final === "m") {
          applySgr(pen, params);
        } else if (final === "H" || final === "f") {
          pure = false;
          // Absolute cursor position, 1-based on the real screen. `top` is where
          // row 0 of this grid sits, so it comes back off to get a grid row.
          y = (params[0] ?? 1) - 1 + top;
          x = (params[1] ?? 1) - 1;
        } else if (final === "C") {
          pure = false;
          x += Math.max(1, params[0] ?? 1);
        } else if (final === "D") {
          pure = false;
          x = Math.max(0, x - Math.max(1, params[0] ?? 1));
        } else if (final === "J") {
          pure = false;
          // Erase display. A real terminal blanks the cells; skipping it left this
          // parser believing text was still there that the terminal had already wiped,
          // which is a difference that only shows up on a resize (the one time the
          // writer sends one). 2 = whole screen, 1 = up to the cursor, 0 = from it on.
          const mode = params[0] ?? 0;
          const from = mode === 2 ? 0 : mode === 1 ? 0 : y * screen.width + x;
          const to = mode === 2 ? screen.chars.length : mode === 1 ? y * screen.width + x : screen.chars.length;
          blank(screen, from, to);
        } else if (final === "K") {
          pure = false;
          // Erase in line, same three modes but bounded to the current row.
          const mode = params[0] ?? 0;
          const rowStart = y * screen.width;
          const from = mode === 0 ? rowStart + x : rowStart;
          const to = mode === 1 ? rowStart + x + 1 : rowStart + screen.width;
          blank(screen, from, to);
        } else {
          pure = false;
        }
        // Every other CSI is skipped whole — see the file header.
        i = j + 1;
        continue;
      }
      pure = false;
      const introducer = frame[i + 1];
      if (introducer === "]" || introducer === "P" || introducer === "X" || introducer === "^" || introducer === "_") {
        // A STRING sequence: OSC, DCS, SOS, PM, APC. What follows the introducer is
        // data, not text to draw — a window title, a hyperlink target, a clipboard
        // payload — and it runs until a string terminator, either BEL or `ESC \`.
        let j = i + 2;
        while (j < frame.length) {
          if (frame[j] === "\x07") {
            j += 1;
            break;
          }
          if (frame[j] === "\x1b" && frame[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }

      // Any other escape: optional intermediate bytes (0x20-0x2F) and one final byte.
      // `ESC ( B` selects a character set, `ESC M` scrolls back a line, `ESC 7` and
      // `ESC 8` save and restore the cursor. None of them draw anything.
      //
      // Consuming only the ESC left the rest to be read as text, and every one of these
      // ends in a LETTER — which is how a bare `M` or `B` appeared in the middle of a
      // line. The cell it landed in then held that letter in the model as well as on the
      // screen, so the diff saw nothing wrong with it and no later frame took it away.
      let j = i + 1;
      while (j < frame.length) {
        const c = frame.charCodeAt(j);
        j++;
        if (c < 0x20 || c > 0x2f) break;
      }
      i = j;
      continue;
    }

    if (ch === "\r") {
      pure = false;
      x = 0;
      i += 1;
      continue;
    }

    if (ch === "\t") {
      pure = false;
      // Tab stops every eight columns. Stamping the tab itself would put a character in
      // the model that `paint` then writes back out, and the terminal would advance the
      // cursor for it — knocking the rest of the row, and everything the diff believes
      // about it, out of alignment.
      x = (Math.floor(x / 8) + 1) * 8;
      i += 1;
      continue;
    }

    const control = frame.charCodeAt(i);
    if (control < 0x20 || control === 0x7f) {
      pure = false;
      // Every remaining C0 control and DEL. A terminal acts on these; none of them leave
      // a glyph behind, so neither may the model.
      if (control === 0x08) x = Math.max(0, x - 1);
      i += 1;
      continue;
    }

    // A printable character. Read a full codepoint, because a surrogate pair is one
    // character occupying (usually) two columns, and splitting it would write two
    // meaningless halves.
    const code = frame.codePointAt(i)!;
    const size = code > 0xffff ? 2 : 1;
    i += size;

    if (y >= screen.height || y < 0) {
      // Past the bottom of the grid: keep scanning so the pen stays correct if the
      // frame comes back into range, but write nothing.
      continue;
    }

    const w = eastAsianWidth(code);
    // Past the right margin. A terminal with autowrap off — which is the mode the app
    // runs the screen in, see `altScreen.ts` — does not discard these: each one replaces
    // the character already in the last column. Dropping them here instead left the model
    // holding a different character than the terminal was showing, in the one column most
    // likely to be written over, and a cell the model has wrong is never repainted.
    const cx = Math.min(x, screen.width - 1);
    if (cx >= 0) {
      const at = screen.index(cx, y);
      screen.chars[at] = code;
      screen.fg[at] = pen.fg;
      screen.bg[at] = pen.bg;
      screen.attrs[at] = pen.attrs;
      // A wide character claims the next column too. Marking it is what keeps every
      // later column on the row aligned with what the terminal will actually do.
      if (w === 2 && cx + 1 < screen.width) {
        const next = screen.index(cx + 1, y);
        screen.chars[next] = WIDE_CONTINUATION;
        screen.fg[next] = pen.fg;
        screen.bg[next] = pen.bg;
        screen.attrs[next] = pen.attrs;
      }
    }
    x += w;
  }

  cursor.x = x;
  cursor.y = y;
  return pure;
}

/** One remembered line: the cells it writes at the left edge of its row, and the pen it leaves behind. */
interface RowMemo {
  chars: Uint32Array;
  fg: Uint32Array;
  bg: Uint32Array;
  attrs: Uint32Array;
  endFg: number;
  endBg: number;
  endAttrs: number;
  endX: number;
}

/** Remembered lines. Most of a frame is the same lines as the one before it, and reading a line is the cost. */
const ROW_MEMO_MAX = 800;
const rowMemo = new Map<string, RowMemo>();

/**
 * Draw `frame` into `screen`, starting at row `top`.
 *
 * The screen is NOT cleared first — the caller decides that, because a resize
 * wants a clean grid while an ordinary frame is a complete repaint of the rows it
 * covers and clearing would be redundant work. Rows the frame does not reach are
 * left alone.
 *
 * A frame is its lines, and between two frames nearly all of them are the same, so a line that has been
 * read before (same text, same starting pen, same grid width) is copied in from memory instead of being
 * read again. Only lines that are pure (see `parseLine`) are remembered, and the copy writes exactly the
 * cells reading would have written. `memo: false` reads everything, for comparing the two.
 */
export function parseFrame(screen: Screen, frame: string, top = 0, memo = true): void {
  const pen: Pen = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0 };
  const cursor: Cursor = { x: 0, y: top };
  let at = 0;
  for (;;) {
    const nl = frame.indexOf("\n", at);
    const line = nl === -1 ? frame.slice(at) : frame.slice(at, nl);
    if (line !== "") readLine(screen, line, pen, cursor, top, memo);
    if (nl === -1) return;
    cursor.y++;
    cursor.x = 0;
    at = nl + 1;
  }
}

function readLine(screen: Screen, line: string, pen: Pen, cursor: Cursor, top: number, memo: boolean): void {
  const y = cursor.y;
  const inRange = y >= 0 && y < screen.height;
  // Only a line read from the start of its row, which is every line of a frame.
  if (!memo || cursor.x !== 0) {
    parseLine(screen, line, pen, cursor, top);
    return;
  }
  const key = `${screen.width}\u0001${pen.fg}\u0001${pen.bg}\u0001${pen.attrs}\u0001${line}`;
  const known = rowMemo.get(key);
  if (known) {
    if (inRange) {
      const base = y * screen.width;
      screen.chars.set(known.chars, base);
      screen.fg.set(known.fg, base);
      screen.bg.set(known.bg, base);
      screen.attrs.set(known.attrs, base);
    }
    pen.fg = known.endFg;
    pen.bg = known.endBg;
    pen.attrs = known.endAttrs;
    cursor.x = known.endX;
    return;
  }
  const pure = parseLine(screen, line, pen, cursor, top);
  if (!pure || !inRange || cursor.y !== y) return;
  const base = y * screen.width;
  const extent = Math.min(cursor.x, screen.width);
  if (rowMemo.size >= ROW_MEMO_MAX) rowMemo.delete(rowMemo.keys().next().value as string);
  rowMemo.set(key, {
    chars: screen.chars.slice(base, base + extent),
    fg: screen.fg.slice(base, base + extent),
    bg: screen.bg.slice(base, base + extent),
    attrs: screen.attrs.slice(base, base + extent),
    endFg: pen.fg,
    endBg: pen.bg,
    endAttrs: pen.attrs,
    endX: cursor.x,
  });
}
