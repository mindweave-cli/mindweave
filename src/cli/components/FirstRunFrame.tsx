/**
 * FirstRunFrame.tsx — the shell the two first-run screens sit in.
 *
 * They are the only screens that own the whole terminal, because there is no
 * conversation behind them yet. Left as plain columns they pinned themselves to the top
 * of an otherwise empty window, which reads like output that has scrolled rather than a
 * thing asking for an answer.
 *
 * So the content is CENTRED vertically, and given a title block that says what this is,
 * which version it is, and — on the very first launch — a few things worth knowing. That
 * last part is not decoration: someone who has just installed a terminal agent has no
 * idea what to type, and the moment they are asked for a key is the only moment they are
 * definitely reading.
 *
 * Everything is bounded. A short terminal falls back to top-aligned rather than clipping
 * the middle of a screen the user has to interact with.
 */
import { Box, Text, type BoxProps } from "ink";
import type { ReactNode } from "react";
import { ACCENT } from "../theme.js";

/** Below this many rows, centring costs more than it gives. */
const MIN_ROWS_TO_CENTRE = 24;

export interface FirstRunFrameProps {
  /** Terminal height, so the content can sit in the middle of it. */
  rows: number;
  /** Version string as the rest of the app renders it. */
  version: string;
  /** Shown under the title. One line. */
  subtitle?: string;
  /** The tips block, for the very first launch only. */
  tips?: string[];
  children: ReactNode;
}

export function FirstRunFrame({ rows, version, subtitle, tips, children }: FirstRunFrameProps) {
  const centred = rows >= MIN_ROWS_TO_CENTRE;
  const justify: BoxProps["justifyContent"] = centred ? "center" : "flex-start";
  return (
    <Box flexDirection="column" height={rows} justifyContent={justify} paddingX={2}>
      <Box flexShrink={0}>
        <Text bold color={ACCENT}>Mindweave 1</Text>
        <Text dimColor>{version}</Text>
      </Box>
      {subtitle ? (
        <Box flexShrink={0} marginTop={1}>
          <Text>{subtitle}</Text>
        </Box>
      ) : null}
      <Box flexShrink={0} marginTop={1} flexDirection="column">
        {children}
      </Box>
      {tips && tips.length > 0 ? (
        <Box flexShrink={0} marginTop={1} flexDirection="column">
          {tips.map((t) => (
            <Text key={t} dimColor wrap="truncate-end">{`  ${t}`}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * What a brand-new user is told while they are pasting a key.
 *
 * Four lines, because this is the one moment they are certainly reading and the one
 * thing they cannot do yet is ask. Each is something you would otherwise have to go
 * looking for: how to see everything, how to stop, where the modes are, and that nothing
 * leaves the machine.
 */
export const FIRST_RUN_TIPS = [
  "/help lists every command · @file adds a file to the conversation",
  "shift+tab switches mode: auto-accept, plan, or ask before each action",
  "Esc stops whatever is running · /undo rolls back file changes",
  "Your keys and your code stay on this machine.",
];
