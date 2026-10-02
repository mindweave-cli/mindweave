/**
 * inputText.ts — what is allowed to enter the prompt box.
 *
 * Whatever reaches the box is drawn back onto the screen by the renderer, so a character that is
 * an instruction to the terminal does not stay text: a carriage return moves the cursor to the
 * start of the row, a backspace moves it left, an escape sequence can clear the screen or set the
 * window title. Pasting several lines from a terminal is the ordinary way to meet one: terminals
 * send line breaks in a paste as carriage returns, and the box then drew its own text over its
 * own border (the row came out as a fragment of the last line, with no frame around it).
 *
 * So everything is made plain text on the way in: every kind of line break becomes a newline,
 * tabs become spaces, escape sequences are dropped whole (not just their escape byte, which would
 * leave `[2J` behind as typed text), and the other control characters are removed.
 */

/** Escape sequences: CSI (ESC [ ... final), OSC (ESC ] ... BEL or ESC \), and the short forms. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]?/g;

/** Control characters other than the line break (and the tab, handled before): C0, DEL and C1. */
const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

const NEEDS_CLEANING = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/;

/** The text as the box may hold it. Pure; a string with nothing to clean is returned as is. */
export function cleanInputText(text: string): string {
  if (!NEEDS_CLEANING.test(text)) return text;
  return text
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(ESCAPES, "")
    .replace(/\t/g, "    ")
    .replace(CONTROLS, "");
}
