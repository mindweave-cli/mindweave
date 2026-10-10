/**
 * WorkGroup — everything the agent ran and read between two other things, as ONE folded row.
 *
 *   ● Ran 4 commands, read 2 files  ✓ ✓ ✗ ✓  ▸
 *
 * Commands and reads are the agent's own working. Most print nothing worth reading, and a long
 * conversation of them was a wall of rows, so they are folded: one line that says how many
 * commands ran and how many files were read, and, in a mark each, how every command ended. A
 * failure shows red in that line without anything being opened. While any of it works the dot
 * pulses and that part of the header is in the present tense ("Running 2 commands"); a call
 * that joins keeps the same row going. Commands and reads share a row in whichever order they
 * come, until the agent says or does something else.
 *
 * A click opens the list. A command is one line with its verdict in a column, and a click on
 * it opens what it printed. A read is one line too: the file, and which part of it was read
 * (`lines 410–551`, or the whole file). Everything is a click away and nothing is thrown out,
 * and the row is the same for one call as for ten.
 *
 * A question for the user is not in here: it is asked on its own, on the screen, and never
 * waits behind a fold.
 */
import { Box, Text, type DOMElement } from "ink";
import { PulseDot } from "./PulseDot.js";
import { Elapsed, MORE_MARKER, OUTCOME, lastOutcome } from "./ToolLine.js";
import { commandLabel } from "../commandLabel.js";
import { registerExpandable, itemHit } from "../expandHits.js";
import { BAD, GOOD } from "../theme.js";
import { isRead, readRows, workHeader } from "../workLines.js";
import type { WorkItem } from "../transcript.js";

const DOT = "●";
/** Marks beyond this many are counted instead, so the header never wraps. */
export const MAX_MARKS = 10;
/** Columns the verdict column holds: `✗ 130 · 2m 10s`. */
const VERDICT_WIDTH = 16;

/**
 * What the header says (pure): the tense and count of each part, and one mark per command.
 * A read earns a mark only when it failed; a read that worked is a count and a list line.
 */
export function commandHeader(items: WorkItem[], live: boolean | undefined): { text: string; marks: ("ok" | "error" | "running")[]; more: number; working: boolean } {
  const head = workHeader(items, live);
  const marks = items.filter((it) => !isRead(it) || it.status === "error").map((it) => it.status);
  const more = Math.max(0, marks.length - MAX_MARKS);
  return { text: head.text, marks: marks.slice(more), more, working: head.working };
}

/** The line of a command's output that says how it ended, if it printed one (pure). */
export function verdictLine(it: WorkItem): string | undefined {
  if (it.detailKind !== "shell" || !it.detail) return undefined;
  const lines = it.detail.split("\n");
  const at = lastOutcome(lines);
  return at >= 0 ? lines[at] : undefined;
}

/** What a command left to read once opened (pure): its command line, its output, no verdict. */
export function openedLines(it: WorkItem): string[] {
  const source = it.full ?? it.detail;
  const lines = source ? source.split("\n") : [];
  const verdict = it.detailKind === "shell" ? lastOutcome(lines) : -1;
  const body = lines
    .filter((_, i) => i !== verdict)
    .map((l) => (it.full || !MORE_MARKER.test(l) ? l : `${l.trimEnd().replace(/\)$/, "")}, not saved in this chat)`));
  const printed = body.filter((l) => !l.startsWith("$ ") && l.trim() !== "");
  if (printed.length === 0) {
    const said = it.summary && it.summary.trim() ? [it.summary.trim()] : ["(no output)"];
    return [...body.filter((l) => l.startsWith("$ ")), ...said];
  }
  return body;
}

/** The words that name a command on its line (pure). */
export function commandName(it: WorkItem, room: number): string {
  if (it.arg) return commandLabel(it.arg, room);
  const word = it.name.toLowerCase();
  return it.name === "Shell" ? "shell status" : word;
}

/** One line of the opened list: a command, or one file a read took. */
interface Row {
  key: string;
  /** Where the item is in the row, for the click. */
  index: number;
  item: WorkItem;
  label: string;
  /** Only a read has its own words; a command's verdict is worked out where it is drawn. */
  range?: string;
}

function listRows(items: WorkItem[], room: number): Row[] {
  return items.flatMap((it, index): Row[] =>
    isRead(it)
      ? readRows(it).map((r, j) => ({ key: `${it.toolId}.${j}`, index, item: it, label: r.label, range: r.range }))
      : [{ key: it.toolId, index, item: it, label: commandName(it, room) }],
  );
}

export function WorkGroup({
  id,
  items,
  open,
  live,
  columns,
  tightTop,
  hovered,
  hoveredItem,
}: {
  id: number;
  items: WorkItem[];
  open?: boolean;
  live?: boolean;
  columns: number;
  tightTop?: boolean;
  /** The pointer is over the header. */
  hovered?: boolean;
  /** The pointer is over the call at this place in the row, or -1. */
  hoveredItem?: number;
}) {
  const head = commandHeader(items, live);
  const running = items.filter((it) => it.status === "running" && it.startedAt !== undefined);
  const since = running.length > 0 ? Math.min(...running.map((it) => it.startedAt!)) : undefined;

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      <Box ref={(node: DOMElement | null) => registerExpandable(id, node)} flexDirection="row" width={columns}>
        <Box minWidth={2} flexShrink={0}>
          {head.working ? <PulseDot glyph={DOT} /> : <Text>{DOT}</Text>}
        </Box>
        <Box flexShrink={0}>
          <Text bold dimColor={!hovered}>{head.text}</Text>
        </Box>
        {head.marks.length > 0 ? (
          <Box flexShrink={0}>
            <Text>{"  "}</Text>
            {head.more > 0 ? <Text dimColor>{`+${head.more} `}</Text> : null}
            {head.marks.map((m, i) => (
              <Text key={i} color={m === "ok" ? GOOD : m === "error" ? BAD : undefined} dimColor={m === "running"}>
                {m === "ok" ? "✓" : m === "error" ? "✗" : "·"}
                {i < head.marks.length - 1 ? " " : ""}
              </Text>
            ))}
          </Box>
        ) : null}
        {head.working && since !== undefined ? (
          <Box flexShrink={0}>
            <Elapsed since={since} />
          </Box>
        ) : null}
        <Box flexShrink={0}>
          <Text dimColor={!hovered} bold={hovered}>{open ? "  ▾" : "  ▸"}</Text>
        </Box>
      </Box>
      {open ? <WorkList id={id} items={items} columns={columns} live={live} hoveredItem={hoveredItem ?? -1} /> : null}
    </Box>
  );
}

function WorkList({ id, items, columns, live, hoveredItem }: { id: number; items: WorkItem[]; columns: number; live?: boolean; hoveredItem: number }) {
  // The verdict column sits at the right of what the longest name needs, so on a wide
  // terminal the verdicts stay beside their commands instead of drifting to the far edge.
  const room = Math.max(8, columns - 4 - VERDICT_WIDTH - 4);
  const rows = listRows(items, room);
  const labelWidth = Math.min(room, Math.max(...rows.map((r) => r.label.length)) + 2);
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const it = row.item;
        const last = i === rows.length - 1;
        const reading = isRead(it);
        const hot = !reading && hoveredItem === row.index;
        const running = it.status === "running";
        const verdict = reading ? undefined : verdictLine(it);
        const shown = reading
          ? row.range ?? ""
          : running
            ? ""
            : verdict ?? (it.status === "error" ? "✗" : it.summary ? it.summary : "✓");
        // Words that do not fit beside a long command go on a line of their own under it. Squeezed
        // into what is left of the line they broke across rows ("Running as shell" / "#1") and ran
        // into the end of the command.
        const room2 = columns - 4 - labelWidth - 3;
        const below = !running && shown.length > 0 && !(!reading && OUTCOME.test(shown)) && shown.length > Math.max(VERDICT_WIDTH, room2) ? shown : "";
        const verdictColor = running ? undefined : it.status === "error" || (verdict && !verdict.startsWith("✓")) ? BAD : GOOD;
        const outcomeOnly = !reading && (OUTCOME.test(shown) || shown === "");
        const beside = below ? "" : shown;
        const failedRead = reading && it.status === "error";
        const body = !reading && it.open ? openedLines(it) : [];
        const bodyWidth = Math.max(8, columns - 8);
        const verdictBox = outcomeOnly || below ? VERDICT_WIDTH : Math.max(VERDICT_WIDTH, room2);
        // Only a command opens; a read has nothing behind its line to show.
        const registered = reading ? undefined : (node: DOMElement | null) => registerExpandable(itemHit(id, row.index), node);
        return (
          <Box key={row.key} flexDirection="column" ref={registered}>
            <Box flexDirection="row" width={columns}>
              <Text dimColor={!hot}>{last ? "  └ " : "  ├ "}</Text>
              <Box width={labelWidth} paddingRight={2} flexShrink={0}>
                <Text bold={hot} dimColor={!hot} wrap="truncate-end">{row.label}</Text>
              </Box>
              <Box width={verdictBox} flexShrink={0}>
                {running ? (
                  <>
                    <PulseDot glyph="●" />
                    {live && it.startedAt !== undefined ? <Elapsed since={it.startedAt} /> : null}
                  </>
                ) : (
                  <Text
                    color={outcomeOnly ? verdictColor : failedRead ? BAD : undefined}
                    dimColor={!outcomeOnly && !failedRead}
                    wrap={outcomeOnly ? "truncate-end" : "wrap"}
                  >
                    {beside}
                  </Text>
                )}
              </Box>
              {reading ? null : <Text dimColor={!hot} bold={hot}>{it.open ? " ▾" : " ▸"}</Text>}
            </Box>
            {below ? (
              <Box flexDirection="row" width={columns}>
                <Text dimColor={!hot}>{last && !body.length ? "      " : "  │   "}</Text>
                <Box width={bodyWidth}>
                  <Text dimColor wrap="wrap">{below}</Text>
                </Box>
              </Box>
            ) : null}
            {body.map((line, j) => (
              <Box key={j} flexDirection="row" width={columns}>
                <Text dimColor={!hot}>{last ? "      " : "  │   "}</Text>
                <Text dimColor={!hot}>{"│ "}</Text>
                <Box width={bodyWidth}>
                  <Text dimColor wrap="wrap">{line === "" ? " " : line}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
