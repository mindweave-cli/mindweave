/**
 * detail.ts — display-only rich detail for mutating tools.
 *
 * Builds the multi-line block the UI shows under a tool row: a +/- diff for an
 * edit, a preview of a freshly written file, or a command's output. This is
 * `ToolResult.detail` — it never reaches the model (the model gets the terse
 * `output`), it only makes the terminal show what actually happened —
 * a diff or a command's stdout. Lines are prefixed so the
 * renderer can colour them: `+ ` added (green), `- ` removed (red), bare = plain.
 */
import { capEnds, condense } from "./outputShape.js";

/** Cap a list of display lines, noting how many were hidden. */
export function capLines(lines: string[], max: number): string {
  if (lines.length <= max) return lines.join("\n");
  const hidden = lines.length - max;
  return [...lines.slice(0, max), `  … (${hidden} more line${hidden === 1 ? "" : "s"})`].join("\n");
}

/** Line budget for `ToolResult.detailFull` — the uncut block a graphical front end
 *  shows when a row is expanded. Still bounded, so one giant write can't flood it. */
export const FULL_DETAIL_MAX = 2000;

// ── Scope helpers (pure) — the "what/where/how much" a change touched, so the row
// isn't just a diff with no sense of range or magnitude. Kept pure + tested.

/** Lines a replacement string spans (an empty string spans none). */
export function lineCount(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

/** A line-range label: "L120" for one line, "L120-138" for a span. */
export function rangeLabel(startLine: number, endLine: number): string {
  return endLine > startLine ? `L${startLine}-${endLine}` : `L${startLine}`;
}

/** The change magnitude, "−6 +12" — a real minus sign (U+2212), never the diff's
 *  hyphen, so it can't be mistaken for a removed line. */
export function magnitude(removed: number, added: number): string {
  return `−${removed} +${added}`;
}

/** Prepend a dim scope header above a diff/preview (its own line, no +/- prefix so
 *  the renderer leaves it uncolored). Empty `body` → just the header. */
export function withScope(scope: string, body: string): string {
  return body ? `${scope}\n${body}` : scope;
}

/** A +/- diff for an edit: the replaced lines removed, the new lines added. */
export function editDetail(oldStr: string, newStr: string, max = 30): string {
  const lines = [
    ...stripTrailingNewline(oldStr).split("\n").map((l) => `- ${l}`),
    ...stripTrailingNewline(newStr).split("\n").map((l) => `+ ${l}`),
  ];
  return capLines(lines, max);
}

/** A stacked +/- diff for a sequence of edits (the edit tool), one block per edit. */
export function multiEditDetail(edits: { oldString: string; newString: string }[], max = 30): string {
  const lines: string[] = [];
  for (const e of edits) {
    lines.push(...stripTrailingNewline(e.oldString).split("\n").map((l) => `- ${l}`));
    lines.push(...stripTrailingNewline(e.newString).split("\n").map((l) => `+ ${l}`));
  }
  return capLines(lines, max);
}

/** A preview of a newly created file — all additions. */
export function writeDetail(content: string, max = 20): string {
  if (content === "") return "";
  return capLines(stripTrailingNewline(content).split("\n").map((l) => `+ ${l}`), max);
}

const ESC = String.fromCharCode(27);
// SGR colour codes, plus the cursor/erase sequences a progress-printing command emits.
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]|${ESC}\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)`, "g");

/**
 * Strip ANSI escapes from captured text.
 *
 * A command's output is captured from a pipe, and plenty of programs colour their
 * output anyway. Those bytes are meaningless in a display block that applies its own
 * colour, and they corrupt width measurement — an escape sequence counts as visible
 * characters when wrapping, so a coloured line wraps early and the block goes ragged.
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Blank-line noise from a command's own formatting, collapsed.
 *
 * PowerShell's table output leads with a blank line, separates directory groups with
 * two, and trails one. Reproduced verbatim in a display block those blanks are most of
 * the block's height and carry nothing. Runs collapse to a single blank (which still
 * separates the groups) and the leading/trailing ones go.
 */
export function collapseBlanks(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && (out.length === 0 || out[out.length - 1]!.trim() === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

/** A command's output for inline display (plain lines, no diff prefixes). */
export function outputDetail(body: string): string {
  if (!body) return "";
  return capLines(collapseBlanks(stripAnsi(body).split("\n")), 18);
}

/** Rows of output shown under a command that SUCCEEDED. Enough to see what it ended up
 *  saying; a run that worked is not a thing anyone reads. */
export const SHELL_ROWS_OK = 3;

/** Rows shown under a command that FAILED. More, because there is now something to read,
 *  and still a fixed budget: a failure must not take the screen. */
export const SHELL_ROWS_FAILED = 12;

/**
 * A command's output as it is DISPLAYED (pure).
 *
 * Three steps, in this order and no other. Escapes go first, because a colour code is
 * neither content nor width. Then the repeated chrome — job columns, timestamps — because
 * it has to be gone before anything is counted, or the budget is spent on text that is
 * identical from line to line. Only then is it capped, and from the END, since output is
 * read backwards: the error is on the last line, the banner on the first.
 */
export function shellOutput(body: string, max: number): string {
  if (!body) return "";
  return capEnds(condense(collapseBlanks(stripAnsi(body).split("\n"))), max).join("\n");
}

/**
 * The two outcome marks.
 *
 * `✗` (U+2717 BALLOT X) rather than the heavy `✖` (U+2716), and that is not a taste
 * choice. Terminals give the heavy one EMOJI presentation and draw it two columns wide,
 * while every width table this code and Ink consult call it one. So it overprinted the
 * character after it and `✖ 1 · 885ms` reached the screen as `✖1 · 885ms`, while the
 * passing row beside it sat correctly as `✓ 0 · 256ms`.
 *
 * `✓` and `✗` are the light pair from the same block, both text-presentation, both one
 * column. A failure now lines up exactly like a success, which is the whole point of
 * putting them in the same place.
 */
export const OK_MARK = "✓";
export const FAIL_MARK = "✗";

/**
 * A wall-clock span, at the precision worth reading (pure).
 *
 * Sub-second work is reported in milliseconds because "0.0s" says nothing; past a minute
 * the seconds stop mattering and the minutes start to.
 */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}s`;
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.round((clamped % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * A command's output with its outcome as the last line (pure).
 *
 *   ✓ 0 · 273ms
 *   ✗ 1 · 12.4s
 *   ✗ timed out after 30s
 *   ✗ killed (SIGTERM) · 2.1s
 *
 * Shown for a SUCCESS too, not only a failure. A row that says nothing when a command
 * passed and something when it failed makes the absence of a line the signal, and an
 * absence is easy to read past, especially under a wall of build output.
 *
 * Short, because the renderer lifts this line out of the body and sets it against the
 * right margin of the command's own header row — the one place a verdict can sit and be
 * in the same position every time, instead of at the bottom of however many lines of
 * output happened to come out. `Exit code 0` spelled out is four words to say what `0`
 * says once you know where to look, and the point of a fixed position is that you do.
 *
 * `exitCode` is null when a process was ended by a signal and never reported one; that
 * case is named by the signal instead, because reporting it as "exit 0" made a killed
 * command read as a command that worked.
 */
export function withOutcome(
  body: string,
  timedOut: boolean,
  exitCode: number | null,
  signal: string | null,
  timeoutMs: number,
  elapsedMs: number,
  pid?: number,
): string {
  const took = ` · ${formatDuration(elapsedMs)}`;
  const line = timedOut
    ? `✗ timed out after ${Math.round(timeoutMs / 1000)}s`
    : signal
      ? `✗ killed (${signal})${took}`
      : exitCode === null
        ? `✗ no exit code${took}`
        : `${exitCode === 0 ? "✓" : "✗"} ${exitCode}${took}`;
  // Which process was killed, and by what. Only when something WAS killed: on an
  // ordinary exit the pid is trivia, but after a timeout it is the thing the user needs
  // in order to check whether it actually died or is still holding a port.
  const killed = timedOut || signal !== null;
  const detail =
    killed && pid !== undefined ? `\n  Signal: ${signal ?? "SIGTERM"} sent to process (PID ${pid})` : "";
  return (body ? `${body}\n${line}` : line) + detail;
}

function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}
