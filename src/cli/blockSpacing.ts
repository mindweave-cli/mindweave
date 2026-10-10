/**
 * blockSpacing.ts — whether a transcript block hugs the one above it.
 *
 * Pure and on its own because it is the kind of rule that is easy to get subtly wrong and
 * impossible to check by reading: it decides a single blank row, from the shape of two
 * neighbouring blocks, and the result is only visible in a transcript long enough that
 * nobody re-reads it.
 */
import type { Block } from "./transcript.js";

/** A tool block that renders a BODY under its row — a diff, a file preview, command
 *  output — rather than at most a one-line note beside it. */
export function hasBody(block: Block | undefined): boolean {
  return !!block && block.kind === "tool" && !!block.detail;
}

/** Kinds whose result is a body (output, a page, an image), not a one-line note. */
const OUTPUT_KINDS = new Set(["run", "websearch", "screenshot"]);

/**
 * Whether a block will occupy more than one line once it settles — either it already
 * carries a body, or it is a still-running command / web lookup / capture that has none
 * YET but is going to get one.
 *
 * The running case is the point. Spacing computed from the current frame hugged two
 * bodyless running rows together, then the blank line sprang in the moment their output
 * landed — the row visibly jumping apart after the fact. Reserving the line up front, from
 * the KIND rather than from whether the body has arrived, keeps the layout still.
 */
export function willHaveBody(block: Block | undefined): boolean {
  if (hasBody(block)) return true;
  return (
    !!block &&
    block.kind === "tool" &&
    block.status === "running" &&
    !!block.action &&
    OUTPUT_KINDS.has(block.action)
  );
}

/**
 * Whether a block hugs the one above it.
 *
 * Consecutive one-line tool rows hug, because a run of them is a list and blank lines
 * between list items only make it longer. Anything carrying a body keeps its blank line,
 * on both sides of it.
 *
 * The rule used to be "a tool block after a tool block", full stop, from when a tool row
 * WAS one line. Once a row could be twenty lines of command output, that put the last
 * line of one command's output directly against the next command's header with nothing
 * between them: the taller the blocks, the more a separator was needed and the less it
 * was there.
 *
 * Takes the FULL block list, not the rendered slice, so the first visible block still
 * spaces correctly against the one scrolled off above it.
 */
export function isTight(all: readonly Block[], i: number): boolean {
  const block = all[i];
  const prev = i > 0 ? all[i - 1] : undefined;
  // A dim note keeps a blank line above it, so it never sits against the words before it; notes
  // that follow each other are one list (a command's several lines) and hug.
  if (block?.kind === "note") return prev?.kind === "note";
  if (!block || block.kind !== "tool" || !prev || prev.kind !== "tool") return false;
  return !willHaveBody(block) && !willHaveBody(prev);
}
