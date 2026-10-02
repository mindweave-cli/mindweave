/**
 * TrustGate.tsx — asked once, the first time Mindweave opens a folder.
 *
 * Choosing where to work is the widest permission there is: every other guard is scoped
 * to the workspace, so the workspace itself has to be chosen on purpose. Opened at a
 * drive root the workspace is the entire drive, and the outside-the-workspace prompt can
 * never fire because nothing is outside it.
 *
 * Deliberately plain. It is the first thing a new user sees, it is a security question,
 * and a security question dressed up is one people learn to press through. Same header
 * and same footer style as the key setup screen so the two read as one flow.
 */
import { Box, Text } from "ink";
import { useInput } from "ink";
import { useState } from "react";
import { FirstRunFrame } from "./FirstRunFrame.js";
import type { Breadth } from "../trust.js";
import { ACCENT, WARN } from "../theme.js";

export interface TrustGateProps {
  /** Terminal height, so the gate sits in the middle rather than at the top. */
  rows: number;
  cwd: string;
  breadth: Breadth;
  /** The extra sentence for a broad root, or "" for an ordinary folder. */
  warning: string;
  /** Whether a yes is remembered — shown, because it is part of the answer. */
  persists: boolean;
  version: string;
  docsUrl: string;
  onTrust: () => void;
  onQuit: () => void;
  active?: boolean;
}

const CHOICES = ["Yes, work in this folder", "No, quit"] as const;

export function TrustGate({ cwd, rows, breadth, warning, persists, version, docsUrl, onTrust, onQuit, active = true }: TrustGateProps) {
  const [sel, setSel] = useState(0);

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow) setSel((s) => (s + 1) % CHOICES.length);
      else if (key.return) (sel === 0 ? onTrust : onQuit)();
      else if (key.escape) onQuit();
      else if (input === "1") onTrust();
      else if (input === "2") onQuit();
    },
    { isActive: active },
  );

  return (
    <FirstRunFrame rows={rows} version={version} subtitle="Work in this folder?">
      <Box marginTop={1}>
        <Text bold color={ACCENT}>{cwd}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>Mindweave will be able to read, change and run files here.</Text>
        <Text dimColor>
          Open it somewhere you trust — your own project, your team's, or open source you know.
          If you are not sure what is in this folder, look before you say yes.
        </Text>
      </Box>

      {warning ? (
        <Box marginTop={1}>
          <Text color={WARN}>{warning}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {CHOICES.map((label, i) => (
          <Box key={label}>
            <Text color={i === sel ? ACCENT : undefined} bold={i === sel}>
              {i === sel ? " › " : "   "}
              {`[${i + 1}] ${label}`}
            </Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {persists
            ? "Remembered for this folder — you won't be asked again."
            : `Just for this session${breadth === "root" ? " (a whole drive is never remembered)" : " (your home directory is never remembered)"}.`}
        </Text>
        <Text dimColor>↑/↓ or 1-2 · Enter to choose · Esc to quit · {docsUrl}</Text>
      </Box>
    </FirstRunFrame>
  );
}
