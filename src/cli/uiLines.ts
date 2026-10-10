/**
 * uiLines.ts — how the lines of a UI test's row are coloured (pure).
 *
 * The row used to be one grey block: steps, list and headings all the same weight, so the
 * part worth reading (what was done, and which control it was done to) looked exactly like
 * the part nobody reads (the thirty controls of the page). Here the steps are plain text,
 * the controls are dim, the numbers that tie the two together stand out, and each section
 * has a title, so the opened row reads as two parts of one result.
 *
 * A line that is none of these is dim, which is what it was.
 */

export type SegKind = "plain" | "dim" | "ref" | "name" | "title";

export interface Seg {
  text: string;
  kind: SegKind;
}

const TITLE = /^(Steps|Page|Page reported|Result)( · .*)?$/;
const STEP = /^(\s*)(\d+\.) (.*)$/;
const CONTROL = /^(\s*)(\[\d+\]) (.*)$/;
const REF_OR_QUOTE = /(\[\d+\])|("(?:[^"\\]|\\.)*")/g;

/** A step's own words: numbers in brackets and quoted names stand out, the rest is plain. */
function stepWords(text: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(REF_OR_QUOTE)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), kind: "plain" });
    out.push({ text: m[0], kind: m[1] ? "ref" : "name" });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: "plain" });
  return out;
}

/** A control's own words: what it is (dim), what it is called, then its value and state (dim). */
function controlWords(text: string): Seg[] {
  const q = text.search(/"/);
  if (q < 0) return [{ text, kind: "dim" }];
  const end = text.slice(q + 1).search(/(?<!\\)"/);
  if (end < 0) return [{ text, kind: "dim" }];
  const nameEnd = q + 1 + end + 1;
  const out: Seg[] = [];
  if (q > 0) out.push({ text: text.slice(0, q), kind: "dim" });
  out.push({ text: text.slice(q, nameEnd), kind: "name" });
  if (nameEnd < text.length) out.push({ text: text.slice(nameEnd), kind: "dim" });
  return out;
}

export function uiSegments(line: string): Seg[] {
  if (TITLE.test(line)) {
    const dot = line.indexOf(" · ");
    return dot < 0 ? [{ text: line, kind: "title" }] : [{ text: line.slice(0, dot), kind: "title" }, { text: line.slice(dot), kind: "dim" }];
  }
  const step = STEP.exec(line);
  if (step) return [{ text: `${step[1]}${step[2]} `, kind: "dim" }, ...stepWords(step[3]!)];
  const control = CONTROL.exec(line);
  if (control) return [{ text: control[1]!, kind: "dim" }, { text: control[2]!, kind: "ref" }, { text: " ", kind: "dim" }, ...controlWords(control[3]!)];
  return [{ text: line, kind: "dim" }];
}
