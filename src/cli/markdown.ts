/**
 * markdown.ts — render Mindweave's markdown replies as styled terminal text.
 *
 * Mindweave's model answers in markdown (`# headings`, `**bold**`, `- lists`,
 * ```code```), which looked raw in the terminal. This turns that into an ANSI
 * string that Ink renders directly inside a <Text> (Ink passes ANSI through and
 * wraps it correctly). The pipeline is straightforward: `marked` lexes to tokens,
 * a small walker emits `chalk`-styled ANSI, and fenced code goes through
 * `cli-highlight` (highlight.js) — all written here from scratch, kept compact.
 *
 * Notes:
 *  - Strikethrough is intentionally disabled: models use `~` for "approx" (~100),
 *    not actual strikethrough.
 *  - Syntax highlighting degrades to dim plain text when the language isn't known
 *    or the highlighter is unavailable, so rendering never throws.
 */
import { createRequire } from "node:module";
import chalk from "chalk";
import { CODE, LINK, SYNTAX } from "./theme.js";
import { marked, type Token, type Tokens } from "marked";

const ESC = String.fromCharCode(27); // the ANSI escape byte, built to avoid embedding it in source

// cli-highlight is loaded defensively — if it (or highlight.js) fails to resolve,
// code blocks fall back to dim plain text rather than breaking all rendering.
// It's CJS, so a createRequire keeps the load synchronous (renderMarkdown can't await).
//
// Loaded on the FIRST code block, not at startup: it registers every language highlight.js
// knows, which was about 240ms of every launch, and a session that never shows code never
// needs it. `undefined` = not tried yet, `null` = tried and unavailable.
type Highlighter = {
  highlight: (code: string, opts: { language: string; ignoreIllegals?: boolean; theme?: Record<string, (s: string) => string> }) => string;
  supportsLanguage: (lang: string) => boolean;
};
/** highlight.js scopes mapped onto the app's syntax palette (theme.ts SYNTAX). */
const CODE_THEME: Record<string, (s: string) => string> = {
  keyword: chalk.hex(SYNTAX.keyword),
  built_in: chalk.hex(SYNTAX.type),
  type: chalk.hex(SYNTAX.type),
  literal: chalk.hex(SYNTAX.number),
  number: chalk.hex(SYNTAX.number),
  regexp: chalk.hex(SYNTAX.string),
  string: chalk.hex(SYNTAX.string),
  subst: (s) => s,
  symbol: chalk.hex(SYNTAX.number),
  class: chalk.hex(SYNTAX.type),
  function: (s) => s,
  title: chalk.hex(SYNTAX.fn),
  params: (s) => s,
  comment: chalk.hex(SYNTAX.comment),
  doctag: chalk.hex(SYNTAX.comment),
  meta: chalk.hex(SYNTAX.comment),
  "meta-keyword": chalk.hex(SYNTAX.keyword),
  "meta-string": chalk.hex(SYNTAX.string),
  section: chalk.hex(SYNTAX.fn),
  tag: chalk.hex(SYNTAX.keyword),
  name: chalk.hex(SYNTAX.keyword),
  "builtin-name": chalk.hex(SYNTAX.type),
  attr: chalk.hex(SYNTAX.prop),
  attribute: chalk.hex(SYNTAX.prop),
  variable: chalk.hex(SYNTAX.prop),
  bullet: chalk.hex(SYNTAX.number),
  code: chalk.hex(SYNTAX.prop),
  emphasis: chalk.italic,
  strong: chalk.bold,
  formula: chalk.hex(SYNTAX.number),
  link: chalk.hex(LINK).underline,
  quote: chalk.hex(SYNTAX.comment),
  "selector-tag": chalk.hex(SYNTAX.keyword),
  "selector-id": chalk.hex(SYNTAX.fn),
  "selector-class": chalk.hex(SYNTAX.fn),
  "selector-attr": chalk.hex(SYNTAX.prop),
  "selector-pseudo": chalk.hex(SYNTAX.prop),
  "template-tag": chalk.hex(SYNTAX.keyword),
  "template-variable": chalk.hex(SYNTAX.prop),
  addition: chalk.hex("#A3CF6E"),
  deletion: chalk.hex("#EC7C72"),
  default: (s) => s,
};
let loadedHighlighter: Highlighter | null | undefined;
function highlighterNow(): Highlighter | null {
  if (loadedHighlighter === undefined) {
    try {
      loadedHighlighter = createRequire(import.meta.url)("cli-highlight") as Highlighter;
    } catch {
      loadedHighlighter = null;
    }
  }
  return loadedHighlighter;
}

let configured = false;
function configure(): void {
  if (configured) return;
  configured = true;
  // Drop strikethrough parsing — `~approx` is almost never intended as <del>.
  marked.use({ tokenizer: { del: () => undefined } });
}

// The visible columns available to the renderer, set per call. Used to fit tables
// so a wide one never exceeds the width (which makes Ink wrap each line and shatter
// the box). Module-level because renderMarkdown is synchronous and single-threaded.
let tableWidth = 80;

const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const TABLE_RE = /^\s*\|/;
/** A line that is nothing but bold text, optionally ending in a colon — models write
 *  these as section labels, so they behave like headings even though they aren't. */
const LABEL_RE = /^\s*\*\*[^*]+\*\*:?\s*$/;
/**
 * A definition line: a bold term, a separator, then its description.
 *
 *   **Smart Organization** — auto-linking, quick switcher, …
 *   **Export**: Markdown, HTML, PDF
 *
 * This is the shape models reach for constantly when summarising, and it was the
 * single worst thing this renderer did. Each one is a separate fact, but written
 * without blank lines they are consecutive lines of one paragraph as far as
 * CommonMark is concerned — so nine of them lexed to ONE token and rendered as an
 * unbroken nine-line wall with bold scattered through it. `LABEL_RE` did not save
 * them because it requires the line to be bold and NOTHING else.
 *
 * The separator has to be present and followed by text: that is what distinguishes a
 * definition from an ordinary sentence that merely opens with emphasis ("**The trick**
 * that keeps it specific is…"), which must stay part of its paragraph.
 */
const DEFN_RE = /^\s*\*\*[^*]+\*\*\s*(?:[—–:]|-)\s+\S/;

/**
 * Put blank lines back at block boundaries, before the markdown is lexed.
 *
 * Models write markdown tightly — a list directly under the sentence introducing it,
 * a sentence directly under the last bullet, a bold label hard against the paragraph
 * above. Rendered faithfully that produces the wall of text this fixes: every block
 * hugging the next with nothing to separate them.
 *
 * It also repairs a real parse fault, not just spacing. In CommonMark a prose line
 * directly beneath a list item is a LAZY CONTINUATION — it is absorbed into that item
 * rather than starting a paragraph. So a summary sentence written under the last
 * bullet became part of the bullet, and rendered hanging at the left margin under it,
 * looking like a bug. A blank line is what tells the parser they are separate things.
 *
 * Deliberately conservative: it only inserts blanks where two DIFFERENT kinds of block
 * meet. Content inside a fence is never touched, and an indented line after a bullet
 * is left alone because that is a genuine continuation of the item.
 */
export function normalizeBlocks(md: string): string {

  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;
  const blank = (s: string) => s.trim() === "";
  // 2+ leading spaces: a continuation of the list item above, not a new block.
  const indented = (s: string) => /^\s{2,}\S/.test(s);

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (!inFence && out.length > 0 && !blank(out[out.length - 1]!)) out.push("");
      out.push(line);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const prev = out.length > 0 ? out[out.length - 1]! : "";
    if (!blank(line) && !blank(prev)) {
      const prevList = BULLET_RE.test(prev);
      const thisList = BULLET_RE.test(line);
      const needsAir =
        (thisList && !prevList) || // prose introducing a list
        (prevList && !thisList && !indented(line)) || // prose after a list — the lazy-continuation fix
        HEADING_RE.test(line) ||
        HEADING_RE.test(prev) ||
        LABEL_RE.test(line) ||
        DEFN_RE.test(line) || // a definition starts its own block…
        DEFN_RE.test(prev) || // …and so does whatever follows one
        FENCE_RE.test(prev) || // the line after a closing fence
        TABLE_RE.test(line) !== TABLE_RE.test(prev); // either edge of a table
      if (needsAir) out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Render a markdown string to a styled ANSI string for an Ink <Text>. `width` is
 *  the visible columns available; tables are sized to fit inside it. */
export function renderMarkdown(content: string, width = 80): string {
  configure();
  tableWidth = Math.max(20, width);
  try {
    return marked
      .lexer(normalizeBlocks(content))
      .map((t) => renderToken(t, 0, null))
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return content; // never let a parse error swallow the reply
  }
}

const BULLET = "•";

function renderToken(token: Token, depth: number, ordered: number | null): string {
  switch (token.type) {
    case "heading": {
      const text = inline(token.tokens);
      const styled = token.depth === 1 ? chalk.bold.underline(text) : chalk.bold(text);
      return styled + "\n\n";
    }
    case "paragraph":
      return inline(token.tokens) + "\n\n";
    case "text": {
      const t = token as Tokens.Text;
      return t.tokens ? inline(t.tokens) : decodeEntities(t.text);
    }
    case "code":
      return renderCodeBlock(token as Tokens.Code) + "\n";
    case "blockquote": {
      const inner = (token.tokens ?? []).map((t) => renderToken(t, 0, null)).join("").trim();
      return (
        inner
          .split("\n")
          .map((line) => chalk.dim("│ ") + chalk.italic(line))
          .join("\n") + "\n\n"
      );
    }
    case "list": {
      const list = token as Tokens.List;
      return (
        list.items
          .map((item, i) => renderListItem(item, depth, list.ordered ? Number(list.start) + i : null))
          .join("") + (depth === 0 ? "\n" : "")
      );
    }
    case "hr":
      return chalk.dim("─".repeat(24)) + "\n\n";
    case "table":
      // A blank line below (like paragraphs) so the next section doesn't hug the
      // table's last row — the collapse in renderMarkdown trims any excess.
      return renderTable(token as Tokens.Table) + "\n\n";
    case "space":
      return "\n";
    case "html":
    case "def":
      return "";
    default:
      return "text" in token ? (token as { text: string }).text : "";
  }
}

/** One list item, indented by depth, with a bullet or its number. */
function renderListItem(item: Tokens.ListItem, depth: number, ordered: number | null): string {
  const indent = "  ".repeat(depth);
  const marker = ordered === null ? chalk.dim(BULLET) : chalk.dim(`${ordered}.`);
  // An item's children are usually a "text" token plus possibly nested lists.
  let head = "";
  let rest = "";
  for (const child of item.tokens ?? []) {
    if (child.type === "list") {
      rest += renderToken(child, depth + 1, null);
    } else if (child.type === "text") {
      const t = child as Tokens.Text;
      head += t.tokens ? inline(t.tokens) : decodeEntities(t.text);
    } else {
      head += renderToken(child, depth, null);
    }
  }
  return `${indent}${marker} ${head.trim()}\n${rest}`;
}

/** Inline tokens (the children of a paragraph/heading/list item). */
function inline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens.map(inlineToken).join("");
}

function inlineToken(token: Token): string {
  switch (token.type) {
    case "strong":
      return chalk.bold(inline((token as Tokens.Strong).tokens));
    case "em":
      return chalk.italic(inline((token as Tokens.Em).tokens));
    case "codespan":
      return chalk.hex(CODE)(decodeEntities((token as Tokens.Codespan).text));
    case "link": {
      const l = token as Tokens.Link;
      const text = decodeEntities(inline(l.tokens) || l.href);
      const shown = chalk.hex(LINK).underline(text);
      // Show the URL only when it differs from the link text. No OSC-8 escapes —
      // they render as garbage in terminals that don't support them.
      return l.href && l.href !== text ? `${shown} ${chalk.dim(`(${l.href})`)}` : shown;
    }
    case "br":
      return "\n";
    case "escape":
      return decodeEntities((token as Tokens.Escape).text);
    case "text":
      return decodeEntities((token as Tokens.Text).text);
    default:
      return "text" in token ? decodeEntities((token as { text: string }).text) : "";
  }
}

// marked HTML-escapes text tokens (& < > " '). Decode them for the terminal.
// &amp; is decoded last so an encoded entity like &amp;lt; doesn't double-decode.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, "&");
}

/** A fenced code block: syntax-highlighted if possible, else dim, indented 2. */
function renderCodeBlock(token: Tokens.Code): string {
  let body: string;
  const lang = (token.lang || "").trim().split(/\s+/)[0];
  const highlighter = lang ? highlighterNow() : null;
  if (highlighter && lang && safeSupports(highlighter, lang)) {
    try {
      body = highlighter.highlight(token.text, { language: lang, ignoreIllegals: true, theme: CODE_THEME });
    } catch {
      body = chalk.dim(token.text);
    }
  } else {
    body = chalk.dim(token.text);
  }
  return body
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
}

function safeSupports(highlighter: Highlighter, lang: string): boolean {
  try {
    return highlighter.supportsLanguage(lang);
  } catch {
    return false;
  }
}

// Strips SGR color codes (for plain-text cell measurement/wrapping).
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Pad a plain string to width w with trailing spaces. */
function padCell(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Greedy word-wrap of PLAIN text to `width`, hard-breaking any word longer than it. */
function wrapPlain(s: string, width: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (let word of words) {
    while (word.length > width) {
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += " " + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Shrink the widest columns one at a time until the row fits the content budget. */
function fitColumns(natural: number[], budget: number): number[] {
  const widths = natural.map((w) => Math.max(1, w));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let idx = 0;
    for (let i = 1; i < widths.length; i++) if (widths[i] > widths[idx]) idx = i;
    if (widths[idx] <= 1) break; // nothing left to shrink
    widths[idx]--;
    total--;
  }
  return widths;
}

// A column narrower than this holds nothing readable. The old sizer shrank the
// widest column one character at a time with a floor of ONE, so a wide table
// degraded into a stack of single letters rather than admitting it did not fit.
const MIN_COL = 3;
// Cells never touch the terminal's last column: a box drawn exactly to the edge is
// one rounding error away from Ink wrapping a row and shattering the border.
const SAFETY_MARGIN = 2;
// Past this many lines in a single row, the grid is doing more harm than good and
// the vertical layout reads better. Same threshold Froge's port settled on.
const MAX_ROW_LINES = 4;
// Per column: a space either side of the content plus one border character.
const CELL_PADDING = 3;

/**
 * A bordered monospace table that always fits the available width.
 *
 * The borderless version this replaces was airier in isolation and worse in use: with
 * only a thin gutter between columns, a wrapped cell was hard to tell from the row
 * below it, and the whole thing stopped reading as a unit of structured data. A drawn
 * box is what makes a table scan as a table at a glance, which is the only reason to
 * choose one over prose in the first place.
 *
 * Sizing runs in three tiers rather than shrinking the widest column until something
 * gives: use the natural widths if they fit, otherwise distribute the available space
 * in proportion to how much each column wants, and only hard-wrap when even the
 * longest single WORD in each column cannot fit.
 *
 * And when no arrangement is readable — a row taller than MAX_ROW_LINES, or a box
 * still wider than the terminal — it stops trying and renders vertically instead. A
 * table that does not fit is not a table; forcing it into columns produces the
 * shredded output this fallback exists to avoid.
 */
function renderTable(token: Tokens.Table): string {
  const n = token.header.length;
  if (n === 0) return "";

  const styledOf = (t: Token[] | undefined) => inline(t ?? []).replace(/\s+/g, " ").trim();
  const headers = token.header.map((c) => styledOf(c.tokens));
  const rows = token.rows.map((r) => token.header.map((_, i) => styledOf(r[i]?.tokens)));
  const plain = (s: string) => stripAnsi(s);

  const columns = (i: number) => [headers[i]!, ...rows.map((r) => r[i]!)];
  // What a column wants, and the least it can take without slicing through a word.
  const ideal = token.header.map((_, i) => Math.max(MIN_COL, ...columns(i).map((c) => plain(c).length)));
  const floor = token.header.map((_, i) =>
    Math.max(MIN_COL, ...columns(i).flatMap((c) => plain(c).split(/\s+/).map((w) => w.length))),
  );

  const budget = Math.max(n * MIN_COL, tableWidth - SAFETY_MARGIN - (n * CELL_PADDING + 1));
  const totalIdeal = ideal.reduce((a, b) => a + b, 0);
  const totalFloor = floor.reduce((a, b) => a + b, 0);

  let widths: number[];
  let hard = false;
  if (totalIdeal <= budget) {
    widths = ideal;
  } else if (totalFloor <= budget) {
    // Share the leftover in proportion to how much each column is giving up, so a
    // column that wanted a lot gets more of the slack than one that barely wanted any.
    const slack = budget - totalFloor;
    const want = ideal.map((w, i) => w - floor[i]!);
    const totalWant = want.reduce((a, b) => a + b, 0);
    widths = floor.map((w, i) => (totalWant === 0 ? w : w + Math.floor((want[i]! / totalWant) * slack)));
  } else {
    hard = true;
    widths = fitColumns(floor, budget);
  }

  // Styling survives only when a cell fits on one line. Wrapping a string that
  // carries ANSI means splitting between an escape and the text it colours, which
  // renders as leaked codes — so a wrapped cell falls back to its plain text. That
  // keeps `inline code` and **bold** in the short cells where they carry meaning,
  // without a full ANSI-aware wrapper to get subtly wrong.
  const cellLines = (styled: string, w: number): string[] => {
    const text = plain(styled);
    if (text.length <= w) return [styled + " ".repeat(w - text.length)];
    return wrapPlain(text, w).map((l) => padCell(l, w));
  };

  const height = (cells: string[]) => Math.max(1, ...cells.map((c, i) => cellLines(c, widths[i]!).length));
  const tallest = Math.max(height(headers), ...rows.map(height));
  const boxWidth = widths.reduce((a, b) => a + b, 0) + n * CELL_PADDING + 1;
  if (hard || tallest > MAX_ROW_LINES || boxWidth > tableWidth - SAFETY_MARGIN) {
    return renderTableVertically(headers, rows);
  }

  const bar = chalk.dim("│");
  const rule = (left: string, mid: string, right: string) =>
    chalk.dim(left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right);

  const renderRow = (cells: string[], header: boolean): string[] => {
    const parts = cells.map((c, i) => cellLines(c, widths[i]!));
    const lines: string[] = [];
    for (let r = 0; r < Math.max(...parts.map((p) => p.length)); r++) {
      const body = parts
        .map((p, i) => {
          const text = p[r] ?? " ".repeat(widths[i]!);
          return ` ${header ? chalk.bold(text) : text} `;
        })
        .join(bar);
      lines.push(bar + body + bar);
    }
    return lines;
  };

  return [
    rule("┌", "┬", "┐"),
    ...renderRow(headers, true),
    rule("├", "┼", "┤"),
    ...rows.flatMap((r) => renderRow(r, false)),
    rule("└", "┴", "┘"),
  ].join("\n");
}

/**
 * The fallback for a table that cannot be a table here: each row becomes a small
 * labelled stack, separated by a rule.
 *
 * This is the honest answer to a table that is too wide. The alternative — squeezing
 * columns until the words break — keeps the SHAPE of a table while destroying the
 * thing a table is for, which is comparing values by position. Stacked labels lose
 * the comparison but keep every value readable, and on a narrow terminal that is
 * strictly the better trade.
 */
function renderTableVertically(headers: string[], rows: string[][]): string {
  const label = (s: string) => chalk.bold(stripAnsi(s) || "—");
  const out: string[] = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push(chalk.dim("─".repeat(Math.min(40, tableWidth))));
    row.forEach((cell, c) => {
      const head = label(headers[c] ?? `Column ${c + 1}`);
      const value = stripAnsi(cell).trim();
      const indent = "  ";
      const lines = wrapPlain(value, Math.max(10, tableWidth - stripAnsi(head).length - 2));
      out.push(`${head}: ${lines[0] ?? ""}`);
      for (const rest of lines.slice(1)) out.push(indent + rest);
    });
  });
  return out.join("\n");
}
