/**
 * ToolGroup — one row for a run of consecutive reads, with what was read listed beneath it.
 *
 *   ● Read 6 files
 *     ⎿ views.py, models.py, urls.py
 *       forms.py, admin.py, tests.py
 *
 * The row opens with the first read and every read after it joins, however the model split
 * them into calls. While any of them is still working the dot pulses and the header is in the
 * present tense ("Reading 4 files"); when the last one is done the dot goes still and the verb
 * settles. Three names to a line, the branch on the first line only, so a burst of reads takes a
 * couple of lines instead of one per file.
 *
 * White only, like every tool row. A read that failed says so beside its name.
 *
 * What is grouped is narrow (see isGroupable): reads, and the background-shell status checks a
 * model polls while it waits. Searches and the code lookups are never drawn at all.
 */
import { Box, Text } from "ink";
import { PulseDot } from "./PulseDot.js";
import type { ToolGroupItem } from "../transcript.js";

const DOT = "●";
const BRANCH = "⎿";
/** Names on one line of the list. */
export const NAMES_PER_LINE = 3;
/** Lines of names shown before the rest are counted instead. */
export const GROUP_MAX_ROWS = 6;

/** The names one item contributes: each file a read covered, or the call itself otherwise. Pure. */
export function itemNames(it: ToolGroupItem): string[] {
  const failed = it.status === "error" ? " (failed)" : "";
  if (it.kind === "read" && it.arg) {
    const files = (it.covers ?? 1) > 1 ? it.arg.split(/,\s*/) : [it.arg];
    return files.filter(Boolean).map((f) => f + failed);
  }
  const word = it.name.toLowerCase();
  return [(it.arg ? `${word} ${it.arg}` : word) + failed];
}

/** Every distinct name in the group, in order, with how many times it came up. Pure. */
export function groupNames(items: ToolGroupItem[]): { name: string; count: number }[] {
  const names: { name: string; count: number }[] = [];
  for (const it of items) {
    for (const name of itemNames(it)) {
      const same = names.find((n) => n.name === name);
      if (same) same.count++;
      else names.push({ name, count: 1 });
    }
  }
  return names;
}

/**
 * The list under the header (pure): names in order, a repeat of the same name folded into
 * `name ×N`, three to a line, capped at `maxRows` lines with the rest counted.
 */
export function groupLines(items: ToolGroupItem[], perLine = NAMES_PER_LINE, maxRows = GROUP_MAX_ROWS): string[] {
  const names = groupNames(items);
  const shown = names.map((n) => (n.count > 1 ? `${n.name} ×${n.count}` : n.name));
  const lines: string[] = [];
  for (let i = 0; i < shown.length; i += perLine) lines.push(shown.slice(i, i + perLine).join(", "));
  if (lines.length <= maxRows) return lines;
  const kept = lines.slice(0, maxRows);
  const rest = shown.length - maxRows * perLine;
  return [...kept, `… ${rest} more`];
}

export function ToolGroup({
  items,
  live,
  columns,
  tightTop,
}: {
  items: ToolGroupItem[];
  /** Is the turn that made these calls still running? A row from an ended turn never pulses. */
  live?: boolean;
  columns: number;
  tightTop?: boolean;
}) {
  const working = !!live && items.some((it) => it.status === "running");
  const allReads = items.every((it) => it.kind === "read");
  // Files, not calls: one call can read several files, and a file read twice is still one file
  // (the list shows it as `name ×2`).
  const n = allReads ? groupNames(items).length : items.reduce((total, it) => total + (it.covers ?? 1), 0);
  const noun = allReads ? (n === 1 ? "file" : "files") : n === 1 ? "item" : "items";
  const verb = working ? (allReads ? "Reading" : "Checking") : allReads ? "Read" : "Checked";
  const lines = groupLines(items);
  const content = Math.max(8, columns - 5);

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      <Box flexDirection="row">
        <Box minWidth={2}>{working ? <PulseDot glyph={DOT} /> : <Text>{DOT}</Text>}</Box>
        <Text bold>{`${verb} ${n} ${noun}`}</Text>
      </Box>
      {lines.map((line, i) => (
        <Box key={i} flexDirection="row" width={columns}>
          <Text dimColor>{i === 0 ? `  ${BRANCH} ` : "    "}</Text>
          <Box width={content}>
            <Text dimColor wrap="truncate-end">{line}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
