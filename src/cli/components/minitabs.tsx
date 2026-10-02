/**
 * minitabs.tsx — the shared shape behind every drill-down manager (`/key`, `/mcp`, and
 * whatever is built on this next).
 *
 * A "minitab" is a level of a footer overlay: a fixed-height numbered list, one entry
 * highlighted, that either drills into another minitab (a server's actions, after its
 * list) or performs an action right there. `/key` proved the shape first — providers,
 * then one provider's keys, then one key's actions — and this file is that shape pulled
 * out so a second manager (`/mcp`, and the ones after it) does not re-derive it, or drift
 * from it in some small way nobody notices until the two managers look and feel different.
 *
 * What lives here is presentation only: a titled, padded, fixed-height panel and a
 * numbered row. The DRILLING — which minitab is showing, what Enter does at each level —
 * is each manager's own state machine, because that part is genuinely different between
 * "edit a key" and "disable a server."
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { ACCENT } from "../theme.js";

/** Rows visible at once, for a caller with no real budget to pass. Every real caller gets
 *  its budget from the shared footer box instead — see `maxRows` on `MiniTabPanel`. */
export const MINITAB_WINDOW = 7;

/** "  3 of 9" when the list is longer than its window, so nothing is silently off the
 *  bottom. On the title row, where every picker puts it, and empty when everything fits. */
export function miniTabPosition(sel: number, total: number, size: number): string {
  return total > size ? `  ${sel + 1} of ${total}` : "";
}

/** Scroll the window so the selection stays inside it. */
export function miniTabWindowStart(sel: number, rowCount: number, size = MINITAB_WINDOW): number {
  if (rowCount <= size) return 0;
  const half = Math.floor(size / 2);
  return Math.max(0, Math.min(sel - half, rowCount - size));
}

/**
 * The header + body of one minitab, CONTENT ONLY. The bordered box around it is the ONE
 * shared menu box in PromptInput (same box the `/` command menu and every picker use), so
 * a manager built on this reads as the same surface as everything else — the box never
 * changes, only what is inside it. Every row is `flexShrink={0}` so Yoga leaves the box at
 * its real height (the footer measurement depends on it) instead of compressing an
 * overfull one.
 */
/** One tab in the header row — a bracketed number, filled solid when it is the one
 *  showing. Optional: a manager with only one real destination names none, and the
 *  title row reads exactly as it always has. */
export interface MiniTab {
  active: boolean;
}

export function MiniTabPanel({
  title,
  counter = "",
  tabs,
  titleWidth,
  rows,
  maxRows,
  hint,
  width,
  children,
}: {
  title: string;
  /** Position in a list longer than the window — see `miniTabPosition`. */
  counter?: string;
  /** Bracketed `[1] [2] [3]` tabs in the title row, spread to the right of it, the active
   *  one bright/bold white rather than dim — no background fill, just brightness. Only
   *  render tabs that lead somewhere real — a placeholder tab with nothing behind it is
   *  worse than the tab bar leaving it out. */
  tabs?: MiniTab[];
  /** A FIXED width for the title, so the tab bar lands in the same column on every screen
   *  this panel can show — not a minimum. A minimum was not enough: any title longer than
   *  it (a server's own name, a step counter appended to it) pushed the tabs sideways, and
   *  a tab bar that moves as you navigate is a tab bar you have to re-find every time. A
   *  title longer than this truncates instead. The COUNTER is rendered after the tabs for
   *  the same reason — it varies in width, so it cannot sit before them. */
  titleWidth?: number;
  /** Body rows `children` occupies, so the blank fill below them can be worked out. */
  rows: number;
  maxRows: number;
  hint: string;
  width: number;
  children: ReactNode;
}) {
  // Fill the box out to its fixed height so the hint is pinned to the BOTTOM at every
  // level. Without the fill a short list left the hint floating in the middle of a box
  // whose size never changes, and each level put it somewhere else — the one line that
  // should be in the same place every time. Title(1) + hint(2, its top margin included)
  // is the three rows the body does not get, which is the command list's shape and every
  // picker's: title, then rows, then the hint on the bottom line.
  const pad = Math.max(0, maxRows - 1 - rows);
  const inner = Math.max(12, width - 4);
  return (
    <>
      <Box flexShrink={0} width={inner}>
        <Box flexShrink={0} width={titleWidth}>
          <Text bold wrap="truncate-end">{title}</Text>
          {titleWidth === undefined && counter ? <Text dimColor>{counter}</Text> : null}
        </Box>
        {tabs && tabs.length > 0 ? (
          <Box flexShrink={0} marginLeft={2}>
            {tabs.map((t, i) => (
              <Box key={i} flexShrink={0} marginLeft={i === 0 ? 0 : 1}>
                {t.active ? (
                  <Text bold color="white">{`[${i + 1}]`}</Text>
                ) : (
                  <Text dimColor>{`[${i + 1}]`}</Text>
                )}
              </Box>
            ))}
          </Box>
        ) : null}
        {titleWidth !== undefined && counter ? <Text dimColor>{counter}</Text> : null}
      </Box>
      {children}
      {Array.from({ length: pad }).map((_, i) => (
        <Box key={`pad${i}`} flexShrink={0}>
          <Text> </Text>
        </Box>
      ))}
      <Box flexShrink={0} marginTop={1}>
        <Text dimColor wrap="truncate-end">{hint}</Text>
      </Box>
    </>
  );
}

/**
 * One numbered row. `mid` is a second COLUMN rather than more text in `left`, because a
 * hint appended to a label moves with the length of the label and the markers then land
 * in different places, so the list stops reading as a table.
 */
export function MiniTabRow({
  on,
  n,
  numWidth = 1,
  showNumber = true,
  left,
  leftColor,
  leftDim,
  mid,
  right,
  rightColor,
  width,
}: {
  on: boolean;
  n: number;
  /** Digits to reserve for the number, so a two-digit item does not shove a one-digit
   *  item's label a column to the right. The parent knows the list length; the row does
   *  not. Right-aligned within it, the way a numbered list reads. */
  numWidth?: number;
  /** Show the row number at all. `/key` numbers every row (Enter and digit-select both
   *  work); a manager whose list is short and whose rows are picked by name rather than
   *  by number can turn it off for a plainer `› label` row. Digit-select still works
   *  either way — this only changes what is drawn. */
  showNumber?: boolean;
  left: string;
  /** Override the label's colour when it is not the row's own selected/dim state — an
   *  action that creates something (Add) reading as distinct from one that inspects or
   *  changes something already there. */
  leftColor?: string;
  /** Draw the label as GHOST text when it is not the selected row — the same weight a
   *  placeholder has in a text field, for a row that is an example of what you could type
   *  rather than a thing that exists. The selected row is never dimmed, whatever this
   *  says: whatever you are on has to read as solid. */
  leftDim?: boolean;
  mid?: string;
  right?: string;
  rightColor?: string;
  width: number;
}) {
  const inner = Math.max(12, width - 4);
  // `right` used to be a bare, unbounded Text — fine while every caller only ever passed
  // a short fixed phrase ("2 keys", "● active"). A caller reporting something genuinely
  // variable-length (a server's own error text) can overflow the row's fixed width, which
  // is the same class of glitch a too-long line anywhere else in a fixed box produces —
  // so `right` gets the same truncate-to-what's-left treatment `left` and `mid` already
  // have, sized from what the rest of the row actually used.
  const prefixWidth = showNumber ? 3 + numWidth + 2 : 3; // "{marker} " (3) [+ number + "  "]
  const midWidth = mid === undefined ? 0 : 9;
  // `left` used to be capped at a fixed 24 (10 beside a `mid` column) EVEN when there was
  // no `right` claiming the rest of the row — a caller with a single long label and
  // nothing else on the row (a picker option: "A command (runs locally, e.g. npx …)")
  // had it chopped to 24 characters while most of the box sat empty beside it. With no
  // `right`, `left` now takes whatever the row actually has left; a `right` still reserves
  // its usual share first, so a two-column row (a label plus a status) is unchanged.
  const leftWidth = right === undefined ? Math.max(4, inner - prefixWidth - midWidth) : mid === undefined ? 24 : 10;
  const rightWidth = Math.max(4, inner - prefixWidth - leftWidth - midWidth);
  const labelColor = leftColor ?? (on ? ACCENT : undefined);
  return (
    <Box flexShrink={0} width={inner}>
      <Text color={on ? ACCENT : undefined} bold={on}>
        {on ? " › " : "   "}
        {showNumber ? `${String(n).padStart(numWidth)}  ` : ""}
      </Text>
      <Box width={leftWidth}>
        <Text color={labelColor} dimColor={leftDim === true && !on} bold={on} wrap="truncate-end">{left}</Text>
      </Box>
      {mid === undefined ? null : (
        <Box width={midWidth}>
          <Text dimColor wrap="truncate-end">{mid}</Text>
        </Box>
      )}
      {right ? (
        <Box width={rightWidth} flexShrink={0}>
          <Text color={rightColor} dimColor={!rightColor} wrap="truncate-end">{right}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
