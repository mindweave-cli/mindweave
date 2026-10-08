/**
 * invisible.ts — remove characters a person cannot see but a model can read.
 *
 * Unicode has characters that render as nothing. Some of them can carry a whole
 * message: every ASCII letter has a twin in the "tag" block (U+E0000 to U+E007F), and
 * runs of zero-width characters or variation selectors can encode arbitrary bytes. A
 * project notes file, a web page or a tool result can therefore hold an instruction
 * that is invisible to whoever reviews it and perfectly legible to the model.
 * Bidirectional overrides do the opposite: text that reads one way on screen and
 * another way in the bytes.
 *
 * None of these has an ordinary use in what an agent reads, with three exceptions that
 * are kept: the tag sequences that spell a subdivision flag (England, Scotland, Wales),
 * a single zero-width joiner or non-joiner (emoji sequences, Persian and Indic text),
 * and a single variation selector (emoji presentation, CJK variants). What is removed:
 *
 *   - tag characters outside a flag sequence
 *   - bidirectional embedding, override and isolate controls
 *   - runs of two or more zero-width characters
 *   - runs of two or more variation selectors
 *
 * Applied where text is sent to the model (see dynamo/engine.ts), not where it is
 * stored, so the transcript and the screen keep the original.
 */

/** A subdivision flag: black flag, two to six tag letters or digits, cancel tag. */
const FLAG = "\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,6}\u{E007F}";
const TAGS = "[\u{E0000}-\u{E007F}]+";
const BIDI = "[‪-‮⁦-⁩]+";
const ZERO_WIDTH_RUN = "[​-‍⁠﻿᠎]{2,}";
const SELECTOR_RUN = "[︀-️\u{E0100}-\u{E01EF}]{2,}";

const PATTERN = new RegExp(`(${FLAG})|${TAGS}|${BIDI}|${ZERO_WIDTH_RUN}|${SELECTOR_RUN}`, "gu");

/**
 * A cheap test for "might contain something to remove": any zero-width, bidi or
 * selector character, or a high surrogate of the planes holding tags and the
 * supplementary selectors. Most text has none and skips the full pass.
 */
const MAYBE = /[​-‍⁠﻿᠎‪-‮⁦-⁩︀-️\uDB40]/;

/** The text without hidden characters, and how many code points were removed (pure). */
export function stripInvisible(text: string): { text: string; removed: number } {
  if (!MAYBE.test(text)) return { text, removed: 0 };
  let removed = 0;
  const out = text.replace(PATTERN, (match: string, flag: string | undefined) => {
    if (flag) return match;
    removed += [...match].length;
    return "";
  });
  return { text: out, removed };
}

/**
 * The text without hidden characters, followed by a visible note when any were
 * removed, so the model (and anyone reading the request) knows the text was altered
 * and that its source tried to hide something.
 */
export function withoutInvisible(text: string): string {
  const { text: out, removed } = stripInvisible(text);
  if (removed === 0) return text;
  return `${out}\n[${removed} hidden character${removed === 1 ? "" : "s"} removed from the text above; its source contained text that is invisible on screen]`;
}
