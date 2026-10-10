/**
 * TipLine.tsx — the hint under the input box, and the hints themselves.
 *
 * It used to pick one tip at random when the session started and keep it there until the
 * next launch, which meant a user could work all day and be shown exactly one of the six.
 * A hint nobody reads twice is worth showing once; the rest were simply never seen. So the
 * line advances now, and the order is a rotation rather than a fresh random draw, which is
 * what makes it show all of them before repeating any.
 *
 * The shape changed with it. A tip is a KEY and what the key does, kept apart so the chord
 * can carry the emphasis and the sentence can stay quiet. The old line spent its first five
 * columns on the word "tip:", which told the reader nothing they could not see.
 */
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import { ACCENT } from "../theme.js";

export interface Tip {
  /** The chord or command, shown bright. */
  key: string;
  /** What it does, shown dim. Lower case, no full stop: it is a label, not a sentence. */
  text: string;
}

/** Ordered loosely by how early it helps to know. */
export const TIPS: Tip[] = [
  { key: "shift+tab", text: "cycles Lightning / Architect / Sentinel" },
  { key: "/help", text: "lists every command" },
  { key: "@", text: "mentions a file to attach it" },
  { key: "esc", text: "interrupts a running turn" },
  { key: "/model", text: "switches which model answers" },
  { key: "ctrl+w", text: "deletes the word behind the cursor, ctrl+u the line" },
  { key: "/think", text: "sets how hard the model reasons" },
  { key: "ctrl+left", text: "moves the cursor a word at a time" },
  { key: "/undo", text: "restores the last checkpoint" },
  { key: "click", text: "a long output to open it, again to fold it (ctrl+o: the newest)" },
  { key: "/screen", text: "chooses the shell — fullscreen, or inline (beta)" },
];

/** The next tip to show. A rotation, so every tip is seen before any is seen twice. */
export function nextTip(index: number, count = TIPS.length): number {
  if (count <= 0) return 0;
  return (index + 1) % count;
}

/** Where to start, so two sessions in a row do not open on the same hint. */
export function randomTipIndex(count = TIPS.length): number {
  return count <= 0 ? 0 : Math.floor(Math.random() * count);
}

/**
 * One row, always. The height is fixed because this line sits at the bottom of a frame
 * whose rows are budgeted: a second row here comes off the chat, or off the screen.
 */
export function TipLine({ tip }: { tip: Tip }): ReactElement {
  return (
    <Box flexShrink={0}>
      <Text>
        {"  "}
        <Text color={ACCENT}>{tip.key}</Text>
        <Text dimColor>{"  " + tip.text}</Text>
      </Text>
    </Box>
  );
}
