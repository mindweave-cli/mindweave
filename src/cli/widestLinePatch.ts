/**
 * widestLinePatch.ts — remember text widths between frames, applied only to the exact
 * `widest-line` this was written against.
 *
 * Ink measures every text node on every frame with `widest-line`, which runs `string-width` over
 * each line: Unicode segmentation, emoji and East Asian width checks, character by character.
 * The same strings come back frame after frame (a scroll moves rows, it does not change them),
 * and profiled in a real terminal this measuring was the largest single cost left in both
 * streaming and scrolling. The width of a string never changes, so it is looked up instead of
 * measured again. The cache is bounded and simply cleared when full.
 *
 * Same mechanism and the same guarantees as inkOutputPatch.ts: the loader hook replaces the
 * module text only when its hash is in `KNOWN_WIDEST_LINE`, and `MINDWEAVE_NO_INK_PATCH=1`
 * turns it off. `widestLinePatch.test.ts` checks the replacement returns exactly what the
 * original does.
 */
import { createHash } from "node:crypto";

/** SHA-256 of the `widest-line/index.js` this replaces (widest-line 6.0.0). */
export const KNOWN_WIDEST_LINE: readonly string[] = ["c56c70d00610e14d157c1ed4fc3a2b83d96f7e595b1842ba12f3a84217796eb1"];

/** The replacement module text. Its import resolves from the same folder the original's does. */
export const PATCHED_WIDEST_LINE: string = String.raw`import stringWidth from 'string-width';
// MINDWEAVE-PATCHED: a string's width never changes, so it is remembered across frames.
const CAP = 8000;
const widths = new Map();
export default function widestLine(string) {
	const known = widths.get(string);
	if (known !== undefined) {
		return known;
	}
	let lineWidth = 0;
	for (const line of string.split('\n')) {
		lineWidth = Math.max(lineWidth, stringWidth(line));
	}
	if (widths.size >= CAP) {
		widths.clear();
	}
	widths.set(string, lineWidth);
	return lineWidth;
}
`;

/** The patched text for this source, or null when it is not the known original (or patching is off). */
export function patchWidestLine(source: string): string | null {
  if (process.env["MINDWEAVE_NO_INK_PATCH"] === "1") return null;
  const hash = createHash("sha256").update(source).digest("hex");
  return KNOWN_WIDEST_LINE.includes(hash) ? PATCHED_WIDEST_LINE : null;
}
