/**
 * ApprovalBox — the bordered prompt for a decision the agent cannot make alone.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Start on this?                               │
 *   │                                              │
 *   │  › [1] Approve — Lightning (just do it)      │
 *   │    [2] Approve — Sentinel (ask each action)  │
 *   │    [3] Reject                                │
 *   │                                              │
 *   │ ↑/↓ or 1-3 · Enter to choose · Esc to cancel │
 *   └──────────────────────────────────────────────┘
 *
 * Separate from `Picker` on purpose. A picker is a LIST you scroll — sessions, models,
 * shells — and it is fine for it to look like one. This is a QUESTION with two to four
 * answers, it arrives unbidden in the middle of the user's work, and the answer commits
 * them to something (running a command, starting a plan). It gets a border so it reads
 * as a stop rather than as more output, and blank lines above and below the choices so
 * the thing being agreed to does not blur into the thing agreeing to it.
 *
 * Number keys are accepted as well as arrows, because this prompt is a decision the
 * user wants over with, not a list to browse. They are numbers rather than per-answer
 * letters ([y]/[a]/[n]) so the accelerator can never disagree with the wording — the
 * answers are supplied by the caller and change from prompt to prompt.
 *
 * HEIGHT IS BOUNDED, and that is not cosmetic. This draws in the footer, and anything
 * there that grows past the terminal's height makes Ink abandon its erase-and-redraw:
 * the screen tears, the input box is pushed off, and the app looks frozen with no way
 * to answer. That is a bug this project has already shipped once — see clipRows.
 */
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { clipRows } from "../wrap.js";

/** Rows the question may occupy before it is cut (wrapping included). */
const MAX_QUESTION_ROWS = 4;
/** Answers shown. More than this and the caller is asking the wrong question. */
const MAX_CHOICES = 6;
/** Rows reserved to show the HIGHLIGHTED option in full when the options are long enough
 *  to truncate on their own row (an ask_user with real, sentence-length choices). */
const SEL_DETAIL_ROWS = 3;

export interface ApprovalBoxProps {
  /** The question — ONE short line. Long context belongs in the transcript. */
  question: string;
  /** The answers, in order. The first is preselected. */
  options: string[];
  onSelect: (index: number) => void;
  onCancel: () => void;
  width: number;
  /** Only one input owner may be live; the caller sets this true while open. */
  active?: boolean;
  /**
   * An extra answer the user TYPES rather than picks.
   *
   * Offered as one more row in the same list, so the gesture stays "move down, press
   * Enter" and nothing about the other answers changes. Landing on it turns the box
   * into a one-line field; leaving it puts the list back. Opt-in, because eight of the
   * nine callers want a straight choice and adding a text row to those would only be a
   * way to get a useless answer.
   */
  freeText?: { label: string; placeholder: string };
  /** Called instead of onSelect when the typed answer is submitted. */
  onSubmitText?: (text: string) => void;
  /**
   * The shared menu box's item-row budget. The box is a FIXED height, so the question is
   * clipped to whatever rows are left once the answers and hint have their space — the
   * answers always show, the box never grows.
   */
  maxRows?: number;
}

export function ApprovalBox({
  question,
  options,
  onSelect,
  onCancel,
  width,
  active = true,
  freeText,
  onSubmitText,
  maxRows = MAX_QUESTION_ROWS + MAX_CHOICES,
}: ApprovalBoxProps) {
  const shown = options.slice(0, MAX_CHOICES);
  // The typed row sits at the end of the same list, so `sel === shown.length` means it.
  const rows = freeText ? shown.length + 1 : shown.length;
  const [sel, setSel] = useState(0);
  const [typed, setTyped] = useState("");
  const onText = freeText !== undefined && sel === shown.length;

  useInput(
    (input, key) => {
      // Arrows always move, even while typing: it is the only way back out of the
      // field, and a text answer nobody can escape from would be a trap.
      if (key.upArrow) setSel((s) => (s - 1 + rows) % rows);
      else if (key.downArrow) setSel((s) => (s + 1) % rows);
      else if (key.escape) onCancel();
      else if (onText) {
        // Text mode. Enter submits what was typed; an empty field is not an answer,
        // so it does nothing rather than sending "".
        if (key.return) {
          const text = typed.trim();
          if (text) {
            onSubmitText?.(text);
            // Emptied, and the highlight handed back to the first answer. Most callers
            // close the box on a typed answer and never notice. One does not: /feedback
            // asks again with the line added, and the box is the same mounted component,
            // so the text stayed in the field with the cursor still in it — a second
            // Enter added the same line twice, and the way OUT of the field was an arrow
            // key nobody had a reason to press.
            setTyped("");
            setSel(0);
          }
        } else if (key.backspace || key.delete) setTyped((t) => t.slice(0, -1));
        // Ink reports paste and ordinary keys the same way. Control bytes are dropped
        // so a stray escape sequence cannot end up inside the answer.
        else if (input) setTyped((t) => t + input.replace(/[\u0000-\u001f]/g, ""));
      } else if (key.return) onSelect(sel);
      else {
        // A number picks AND commits in one keystroke. Selecting without confirming
        // would make the fast path silently need a second key.
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= shown.length) onSelect(n - 1);
      }
    },
    { isActive: active && rows > 0 },
  );

  // Inside the border: two frame columns and one padding column each side.
  const inner = Math.max(12, width - 4);
  // The width an option's own row shows before it truncates (matches the row render below).
  const rowTextWidth = Math.max(4, inner - 7);
  // Long, sentence-length options — the ones a single row cannot show — get a full-text
  // area under the list, so the highlighted one can actually be read. Reserved only when an
  // option would truncate, so a plain Yes/No approval is left exactly as it was.
  const anyLong = shown.some((o) => o.length > rowTextWidth);
  const detailReserve = anyLong ? SEL_DETAIL_ROWS : 0;
  const selText = !onText ? shown[sel] ?? "" : "";
  const detailRows = detailReserve > 0 && selText.length > rowTextWidth ? clipRows(selText, inner, SEL_DETAIL_ROWS) : [];
  // The box holds maxRows+2 content rows; the answers (and freeText row), one blank above
  // and below, the hint, and any detail area take their share, so the question gets whatever
  // is left — always at least one line, never more than its own cap. The answers are never hidden.
  const qMax = Math.max(1, Math.min(MAX_QUESTION_ROWS, maxRows - 1 - rows - detailReserve));
  const questionRows = clipRows(question, inner, qMax);

  // Content only — the border is the ONE shared menu box in PromptInput (the same box the
  // `/` command menu, the pickers and the key manager use), so an approval reads as the
  // same surface. It still reads as a stop because that box is bordered and the input above
  // goes inert while it is open. flexShrink:0 on every row for the same reason the command
  // palette has it: without it Yoga compresses an overfull box instead of leaving it at its
  // real height, and the height is what the footer measurement depends on.
  return (
    <>
      {questionRows.map((line, i) => (
        <Box key={`q${i}`} flexShrink={0}>
          <Text bold wrap="truncate-end">{line}</Text>
        </Box>
      ))}

      <Box flexShrink={0}><Text> </Text></Box>

      {shown.map((label, i) => {
        const on = i === sel;
        return (
          <Box key={i} width={inner} flexShrink={0}>
            <Text color={on ? "cyan" : undefined} bold={on}>
              {on ? " › " : "   "}
              {`[${i + 1}] `}
            </Text>
            <Box width={Math.max(4, inner - 7)}>
              <Text color={on ? "cyan" : undefined} bold={on} wrap="truncate-end">
                {label}
              </Text>
            </Box>
          </Box>
        );
      })}

      {freeText ? (
        <Box width={inner} flexShrink={0}>
          <Text color={onText ? "cyan" : undefined} bold={onText}>
            {onText ? " › " : "   "}
            {`[${shown.length + 1}] `}
          </Text>
          <Box width={Math.max(4, inner - 7)}>
            <Text color={onText ? "cyan" : undefined} bold={onText} wrap="truncate-end">
              {/* The label until it is being used, then what is being typed. The caret
                  is a plain block rather than the prompt's blinking one: this row is
                  transient and a second animation under the chat reads as noise. */}
              {onText ? `${freeText.label}: ${typed}█` : freeText.label}
            </Text>
          </Box>
        </Box>
      ) : null}

      {/* The highlighted option in full, wrapped, when its row had to truncate it. Padded to
          a fixed height so the box never grows as you move between a short and a long option. */}
      {detailReserve > 0 ? (
        <>
          {detailRows.map((line, i) => (
            <Box key={`d${i}`} width={inner} flexShrink={0}>
              <Text dimColor wrap="truncate-end">{line}</Text>
            </Box>
          ))}
          {Array.from({ length: SEL_DETAIL_ROWS - detailRows.length }).map((_, i) => (
            <Box key={`dp${i}`} flexShrink={0}><Text> </Text></Box>
          ))}
        </>
      ) : null}

      <Box flexShrink={0}><Text> </Text></Box>

      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {onText
            ? `type your answer · Enter to send · ↑/↓ to go back · Esc to cancel`
            : `↑/↓ or 1-${shown.length} · Enter to choose · Esc to cancel`}
        </Text>
      </Box>
    </>
  );
}
