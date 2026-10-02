/**
 * wrap.ts — word-wrap ANSI-styled text ourselves, because Ink's own `wrap="wrap"`
 * has a real bug: some continuation lines come out indented by one stray space,
 * others don't. Confirmed with a bare Ink render, no Mindweave code involved —
 * `<Text wrap="wrap">` on a plain sentence at width 20 produced:
 *
 *   sentence that should
 *    wrap cleanly across      ← extra leading space
 *    two or three lines       ← extra leading space
 *   without issue
 *
 * lines 2 and 5 clean, 3 and 4 not — same input, same call, inconsistent. That
 * rules out anything in BlockView's own Box structure; it is Ink/wrap-ansi's
 * wrapping itself. Rather than depend on the library IT happens to use
 * internally (an undeclared transitive dependency that could vanish on the next
 * `npm install`), this wraps the text before Ink ever sees it and renders each
 * line as its own row — nothing left for Ink's wrapper to get inconsistent about.
 */

// Strips ANSI SGR codes (chalk's coloring) so width is measured on what's
// actually visible, not the escape bytes around it.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Text as at most `maxRows` RENDERED rows, saying so when it had to cut (pure).
 *
 * Rendered rows, not newlines: one 400-column line is several rows on screen, and
 * counting newlines would call it short and let it blow the frame anyway.
 *
 * This exists because an unbounded prompt is not a cosmetic problem. Anything drawn in
 * the footer that grows past the terminal's height makes Ink abandon its normal
 * erase-and-redraw, after which the screen tears and the app is unusable — measured,
 * from a 40-step plan passed as an overlay title.
 */
export function clipRows(text: string, width: number, maxRows: number): string[] {
  const rows = wrapAnsi(text, Math.max(8, width));
  if (rows.length <= maxRows) return rows;
  // Say it was cut. A silently truncated question is one the user answers without
  // having read it.
  return [...rows.slice(0, Math.max(1, maxRows - 1)), `… (${rows.length - (maxRows - 1)} more lines above)`];
}

export function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * Greedy word-wrap of ANSI-styled text to `width` columns (pure).
 *
 * Existing newlines are respected as hard breaks (a markdown reply's paragraph
 * spacing survives). Splitting on whitespace in the ORIGINAL string is safe even
 * with embedded ANSI: an escape sequence (`\x1b[...m`) is only digits and
 * semicolons, so it can never contain the whitespace being split on, and a
 * "word" that comes out of the split keeps whatever styling wraps it intact.
 *
 * A single word wider than `width` (an unbroken run with no spaces, or a long
 * styled token) still has to break somewhere. It hard-breaks on the PLAIN text
 * rather than carry ANSI codes through the cut, which could otherwise sever an
 * escape sequence or leave a color open past the end of its own line — losing
 * that one word's styling is a far smaller cost than corrupting the line after it.
 */
export function wrapAnsi(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    out.push(...wrapLine(line, w));
  }
  return out;
}

/**
 * A list item's marker, as `markdown.ts` renders one: optional nesting indent, then
 * `•` or `3.`, then a space. Deliberately NOT `-`/`*`/`+` — our own renderer emits
 * the bullet character, and a raw `-` at the start of a line is far more often a diff
 * removal or literal command output, where hanging text under it would be wrong.
 */
const LIST_MARKER_RE = /^\s*(?:•|\d+[.)])\s/;

/**
 * How far a wrapped list item's continuation rows are indented, in columns.
 *
 * Without it the second row of an item starts in the bullet's own column, so
 * "settings." under "• Font picker — let users choose…" reads as a new item rather
 * than the rest of the previous one. Capped so a narrow terminal keeps usable room.
 */
function hangingIndent(line: string, width: number): number {
  const m = LIST_MARKER_RE.exec(line.replace(ANSI_RE, ""));
  return m ? Math.min(m[0].length, Math.max(0, width - 8)) : 0;
}

function wrapLine(line: string, width: number): string[] {
  const hang = hangingIndent(line, width);
  const pad = " ".repeat(hang);
  const lines: string[] = [];
  // The first row starts at the margin; every row after it hangs under the item's text.
  const push = (s: string) => lines.push(lines.length === 0 ? s : pad + s);
  const room = () => (lines.length === 0 ? width : width - hang);

  const words = line.split(/(\s+)/).filter((w) => w !== "");
  let cur = "";
  let curWidth = 0;

  for (const word of words) {
    const isSpace = /^\s+$/.test(word);
    const wWidth = visibleWidth(word);

    if (isSpace) {
      // A run of spaces mid-line is kept (markdown text rarely has one, but
      // dropping it would be presumptuous); one that would start a wrapped
      // line is dropped — the exact leading-space bug this file exists to avoid.
      if (cur === "") continue;
      if (curWidth + wWidth > room()) {
        push(cur);
        cur = "";
        curWidth = 0;
        continue;
      }
      cur += word;
      curWidth += wWidth;
      continue;
    }

    if (wWidth > room()) {
      // Wider than a whole line by itself: flush what's pending, then hard-break
      // the plain text (see the function comment for why styling is dropped here).
      if (cur !== "") { push(cur); cur = ""; curWidth = 0; }
      const plain = word.replace(ANSI_RE, "");
      let i = 0;
      while (i < plain.length) {
        const take = room();
        push(plain.slice(i, i + take));
        i += take;
      }
      continue;
    }

    if (curWidth + wWidth > room()) {
      push(cur);
      cur = word;
      curWidth = wWidth;
    } else {
      cur += word;
      curWidth += wWidth;
    }
  }
  if (cur !== "") push(cur);
  return lines.length > 0 ? lines : [""];
}
