/**
 * KeySetup.tsx — the first screen a new user sees.
 *
 * Two steps in one place. The LIST shows every provider Mindweave speaks to, with the
 * ones already set up marked, and a Continue row that lights up as soon as one of them
 * is. Choosing a provider opens a single masked field for its key; saving returns to the
 * list, so someone who wants two or five keys just keeps going.
 *
 * It replaced a screen that asked for the DEFAULT provider's key and nothing else, which
 * meant a user holding a key for any of the other twelve had no way in at all.
 *
 * Height matters here as it does in the footer: thirteen providers plus a Continue row
 * plus the header does not fit a short terminal, so the list scrolls around the
 * selection rather than being clipped at the bottom where Continue lives.
 */
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { FirstRunFrame, FIRST_RUN_TIPS } from "./FirstRunFrame.js";
import { stripMouse } from "../mouse.js";
import { useState } from "react";
import { useInput } from "ink";
import { initialRow, type SetupRow, type SetupView } from "../keySetup.js";
import { ACCENT, GOOD } from "../theme.js";

/**
 * How the first-run screen uses the terminal height: how many providers to list, and
 * whether the welcome tips fit alongside them.
 *
 * Every provider is listed whenever the terminal is tall enough, because a list that shows
 * nine of sixteen reads as "these are the ones it supports" and a user holding a key for
 * one of the other seven concludes it does not. The tips are the first thing to give way,
 * since the list is what the screen is for. Only a terminal too short for the whole list
 * scrolls, and then it says what is above and below the window.
 *
 * The line counts were measured: title, subtitle, the prompt, the spacing, Continue and
 * the footer are CHROME; the first run adds a one-line note about local models, and the
 * tips add four more.
 */
const CHROME = 18;
const LOCAL_NOTE_LINES = 1;
const TIP_LINES = 4;

export function layoutFor(rows: number, count: number, firstRun: boolean): { win: number; tips: boolean } {
  const base = CHROME + (firstRun ? LOCAL_NOTE_LINES : 0);
  const tips = firstRun && rows - base - TIP_LINES >= count;
  const room = rows - base - (tips ? TIP_LINES : 0);
  // One line is held back while scrolling: the window can show "more above" and "more below"
  // at once, and the screen must not exceed the terminal, since Continue sits at the bottom.
  const win = room >= count ? count : Math.max(4, room - 1);
  return { win, tips };
}

export interface KeySetupProps {
  /** Terminal height, so the screen can sit in the middle rather than at the top. */
  rows: number;
  view: SetupView;
  version: string;
  /** Where keys are written, shown so the user knows what is being touched. */
  envPath: string;
  docsUrl: string;
  /** Save a key for this provider, then come back to the list. */
  onSaveKey: (row: SetupRow, key: string) => void;
  /** Leave setup and start chatting. Only offered once something can run. */
  onContinue: () => void;
  /** Only one input owner may be live. */
  active?: boolean;
  /**
   * Esc leaves without changing anything. Offered when the screen was opened DELIBERATELY
   * (/key) and withheld on a first run, where there is no session behind it to go back to
   * and an escape would only be a way to reach an app that cannot answer.
   */
  onCancel?: () => void;
}

export function KeySetup({ view, rows, version, envPath, docsUrl, onSaveKey, onContinue, active = true, onCancel }: KeySetupProps) {
  const [sel, setSel] = useState(() => initialRow(view));
  const [entering, setEntering] = useState<SetupRow | null>(null);
  const [value, setValue] = useState("");

  // Continue sits after the providers, as one more row, so there is a single list to
  // move through rather than a list plus a separate control with its own key.
  const rowCount = view.rows.length + 1;
  const onContinueRow = sel === view.rows.length;

  useInput(
    (input, key) => {
      // Escape is handled FIRST, and even while the field owns the keyboard. Choosing a
      // provider and then finding no way back to the list is the trap people hit
      // immediately, and "submit nothing to go back" is a rule nobody should have to
      // learn. On the list itself it only leaves when there is somewhere to leave to —
      // a first run has no session behind it.
      if (key.escape) {
        if (entering) {
          setEntering(null);
          setValue("");
        } else onCancel?.();
        return;
      }
      if (entering) return; // everything else belongs to the field
      if (key.upArrow) setSel((s) => (s - 1 + rowCount) % rowCount);
      else if (key.downArrow) setSel((s) => (s + 1) % rowCount);
      else if (key.return) choose(sel);
      else {
        // ONE keypress commits, so only single digits can ever arrive here: typing "1"
        // for row 11 picks row 1 before the second key is pressed. The hint below says
        // 1-9 for that reason — it used to advertise the full range, which was a
        // shortcut four providers did not have, Gemini among them.
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, view.rows.length)) choose(n - 1);
      }
    },
    { isActive: active },
  );

  function choose(index: number) {
    if (index === view.rows.length) {
      // Ignored rather than refused: a row that cannot act yet says so in its own label,
      // and an error for pressing Enter on it would be noise.
      if (view.canContinue) onContinue();
      return;
    }
    const row = view.rows[index];
    if (row) {
      setValue("");
      setEntering(row);
    }
  }

  if (entering) {
    return (
      <FirstRunFrame rows={rows} version={version}>
        <Text>
          Paste your <Text bold>{entering.label}</Text> API key:
        </Text>
        <Box marginTop={1}>
          <Text bold color={ACCENT}>{"  key › "}</Text>
          <TextInput
            value={value}
            // Mouse reports arrive at a focused field as TYPED TEXT once wheel reporting is
            // on, so scrolling while pasting a key fills it with escape sequences and the
            // key fails in a way that looks like the key itself is wrong. The prompt has
            // stripped these for a long time; these fields are new and did not.
            onChange={(v) => setValue(stripMouse(v))}
            onSubmit={(v) => {
              const key = v.trim();
              // An empty submit is how you back out — there is nothing to save, and
              // needing a separate key for "never mind" on a field is one more thing to
              // explain on the first screen anyone sees.
              if (key) onSaveKey(entering, key);
              setEntering(null);
              setValue("");
            }}
            placeholder="paste, then press Enter"
            mask="•"
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Don't have one? Get a key at {entering.keysUrl}</Text>
          <Text dimColor>Saved to {envPath} — on this machine only, sent only to {entering.label}.</Text>
          <Text dimColor>Esc to go back to the list.</Text>
        </Box>
      </FirstRunFrame>
    );
  }

  const firstRun = view.readyCount === 0;
  const { win, tips } = layoutFor(rows, view.rows.length, firstRun);
  const start = windowStart(sel, rowCount, win);
  return (
    <FirstRunFrame
      rows={rows}
      version={version}
      subtitle={
        view.readyCount === 0
          ? "Welcome — a coding agent that runs in your terminal, on your own key."
          : `Ready: ${view.rows.filter((r) => r.ready).map((r) => r.label).join(", ")}. Add more, or continue.`
      }
      tips={tips ? FIRST_RUN_TIPS : undefined}
    >
      <Text>Add a key for whichever provider you already use — one is enough.</Text>
      <Box marginTop={1} flexDirection="column">
        {start > 0 ? <Text dimColor>{`   … ${start} more above`}</Text> : null}
        {view.rows.slice(start, start + win).map((row, i) => {
          const index = start + i;
          const on = index === sel;
          return (
            <Box key={row.id}>
              <Text color={on ? ACCENT : undefined} bold={on}>
                {on ? " › " : "   "}
                {`${String(index + 1).padStart(2)}  `}
              </Text>
              <Box width={16}>
                <Text color={on ? ACCENT : undefined} bold={on} wrap="truncate-end">{row.label}</Text>
              </Box>
              <Text color={row.ready ? GOOD : undefined} dimColor={!row.ready}>
                {row.ready ? "✓ key added" : row.envVar}
              </Text>
            </Box>
          );
        })}
        {start + win < view.rows.length ? (
          <Text dimColor>{`   … ${view.rows.length - start - win} more below`}</Text>
        ) : null}
        {firstRun ? <Text dimColor>{"   Using a model on your own computer? Ollama needs no key. Start it and Mindweave finds it."}</Text> : null}
        <Box marginTop={1}>
          <Text color={onContinueRow ? ACCENT : undefined} bold={onContinueRow} dimColor={!view.canContinue}>
            {onContinueRow ? " › " : "   "}
            {view.canContinue ? "Continue →  start chatting" : "Continue →  (add a key first)"}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          ↑/↓ to move · 1-{Math.min(9, view.rows.length)} to jump · Enter to choose
          {onCancel ? " · Esc to leave" : ""}
        </Text>
        <Text dimColor>Keys are saved to {envPath}, on this machine only. Learn more: {docsUrl}</Text>
      </Box>
    </FirstRunFrame>
  );
}

/** Scroll the window so the selection stays inside it. */
export function windowStart(sel: number, rowCount: number, size: number): number {
  if (rowCount <= size) return 0;
  const half = Math.floor(size / 2);
  return Math.max(0, Math.min(sel - half, rowCount - 1 - size));
}
