/**
 * UpdateWait.tsx — the whole screen while `/update` installs the new version.
 *
 * Nothing on it can be answered, and it says so: the install takes a little while and a screen that looks
 * idle invites pressing keys. The spinner and the running time are the proof that it is still going.
 * Same frame as the first-run screens so it reads as part of the same family, not as a stuck chat.
 */
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { FirstRunFrame } from "./FirstRunFrame.js";
import { ACCENT } from "../theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** `m:ss` for a number of seconds (pure). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface UpdateWaitProps {
  rows: number;
  /** The version being installed. */
  version: string;
  /** The version shown in the header. */
  current: string;
  /** When the install began, in ms. */
  startedAt: number;
}

export function UpdateWait({ rows, version, current, startedAt }: UpdateWaitProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const frame = FRAMES[Math.floor(now / 250) % FRAMES.length]!;
  return (
    <FirstRunFrame rows={rows} version={current} subtitle={`Updating Mindweave to v${version}`}>
      <Box flexDirection="column">
        <Text>Please wait, the update is happening.</Text>
        <Text bold>Do not close the app and do not press anything.</Text>
        <Text dimColor>When it is done, Mindweave comes back here by itself, ready to use.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={ACCENT}>{`${frame} `}</Text>
        <Text>{`Installing v${version}…  `}</Text>
        <Text dimColor>{clock((now - startedAt) / 1000)}</Text>
      </Box>
    </FirstRunFrame>
  );
}
