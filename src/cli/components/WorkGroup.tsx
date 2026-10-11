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
import { BAD, GOOD, USER_BG, USER_FG } from "../theme.js";
import { visibleWidth, wrapAnsi } from "../wrap.js";
import { FOLD_SEP, foldControls, plainLine, isRead, isStep, readRows, stepLabel, stepReason, workHeader } from "../workLines.js";
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
  // A test step opens on everything it said: what it did, and the whole list of the page.
  if (isStep(it)) {
    const lines = source ? source.split(String.fromCharCode(10)).map(plainLine).filter((l) => !MORE_MARKER.test(l)) : [];
    return lines.length > 0 ? foldControls(lines).map((l) => (l.includes("\t") ? l : l.trim())) : [it.summary?.trim() || "(nothing more to show)"];
  }
  const lines = source ? source.split("\n").map(plainLine) : [];
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
      : [{ key: it.toolId, index, item: it, label: isStep(it) ? stepLabel(it) : commandName(it, room) }],
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
  // A test that is working says which step it is on, so a long one does not look stuck behind a fold.
  const onStep = head.working && !open ? items.filter((it) => isStep(it) && it.status === "running").pop() : undefined;

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
        {onStep ? (
          <Box flexShrink={0}>
            <Text dimColor>{"  " + stepLabel(onStep).slice(0, Math.max(12, columns - head.text.length - 24))}</Text>
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

/** One row of the shaded band: an optional dim kind, the words, and the spaces that fill it. */
interface ShadeRow {
  kind?: string;
  text: string;
  pad: number;
}

/**
 * The opened text as rows of exact width (pure). A line is wrapped to fit; a `kind<SEP>names` line
 * keeps its kind in a column of its own, and what wraps lines up under the names.
 */
export function shadeRows(body: string[], width: number): ShadeRow[] {
  const inner = Math.max(6, width - 2);
  const kindWidth = Math.min(14, Math.max(0, ...body.filter((l) => l.includes(FOLD_SEP)).map((l) => l.split(FOLD_SEP)[0]!.length)) + 2);
  const rows: ShadeRow[] = [];
  for (const line of body) {
    if (line.includes(FOLD_SEP)) {
      const [kind, names] = line.split(FOLD_SEP) as [string, string];
      wrapAnsi(names, Math.max(4, inner - kindWidth)).forEach((part, i) => {
        const text = (i === 0 ? "" : " ".repeat(kindWidth)) + part;
        rows.push({ ...(i === 0 ? { kind: kind.padEnd(kindWidth) } : {}), text: i === 0 ? part : text, pad: Math.max(0, inner - (i === 0 ? kindWidth : kindWidth) - visibleWidth(part)) });
      });
    } else {
      for (const part of wrapAnsi(line === "" ? " " : line, inner)) rows.push({ text: part, pad: Math.max(0, inner - visibleWidth(part)) });
    }
  }
  return rows;
}

function WorkList({ id, items, columns, live, hoveredItem }: { id: number; items: WorkItem[]; columns: number; live?: boolean; hoveredItem: number }) {
  // The verdict column sits at the right of what the longest name needs, so on a wide
  // terminal the verdicts stay beside their commands instead of drifting to the far edge.
  const room = Math.max(8, columns - 4 - VERDICT_WIDTH - 4);
  // A row of ONE call opens straight onto what that call did: nothing is behind a second click.
  const single = items.length === 1;
  const rows = listRows(items, room);
  const labelWidth = Math.min(room, Math.max(...rows.map((r) => r.label.length)) + 2);
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const it = row.item;
        const last = i === rows.length - 1;
        const reading = isRead(it);
        const step = isStep(it);
        const hot = !reading && hoveredItem === row.index;
        const running = it.status === "running";
        const verdict = reading || step ? undefined : verdictLine(it);
        const shown = reading
          ? row.range ?? ""
          : running
            ? ""
            : step
              ? it.status === "error" ? "✗" : "✓"
              : verdict ?? (it.status === "error" ? "✗" : it.summary ? it.summary : "✓");
        // Why a step failed, under it, in red: the one thing a folded failure must still say.
        const reason = step && it.status === "error" ? stepReason(it) : "";
        // Words that do not fit beside a long command go on a line of their own under it. Squeezed
        // into what is left of the line they broke across rows ("Running as shell" / "#1") and ran
        // into the end of the command.
        const room2 = columns - 4 - labelWidth - 3;
        const below = !running && shown.length > 0 && !(!reading && OUTCOME.test(shown)) && shown.length > Math.max(VERDICT_WIDTH, room2) ? shown : "";
        const verdictColor = running ? undefined : it.status === "error" || (verdict && !verdict.startsWith("✓")) ? BAD : GOOD;
        const outcomeOnly = !reading && (OUTCOME.test(shown) || shown === "");
        const beside = below ? "" : shown;
        const failedRead = reading && it.status === "error";
        const body = !reading && (it.open || single) ? openedLines(it) : [];
        // The one being read stands out: bright, with its text on a shaded band under it. The ones
        // that are folded stay dim, so it is plain which is open.
        const isOpen = body.length > 0;
        const bodyWidth = Math.max(8, columns - 4);
        const shade = isOpen ? shadeRows(body, columns - 4) : [];
        const verdictBox = outcomeOnly || below ? VERDICT_WIDTH : Math.max(VERDICT_WIDTH, room2);
        // Only a command opens; a read has nothing behind its line to show.
        const registered = reading || single ? undefined : (node: DOMElement | null) => registerExpandable(itemHit(id, row.index), node);
        return (
          <Box key={row.key} flexDirection="column" ref={registered}>
            {/* A row whose only call is a batch of steps says "Tested 11 steps" in its header; the call's own
                line ("Steps 11 steps") would say it again, so it is left out and what the steps did opens directly. */}
            {single && step && it.name === "Steps" ? null : (
            <Box flexDirection="row" width={columns}>
              <Text>{"  "}</Text>
              <Box width={labelWidth} paddingRight={2} flexShrink={0}>
                <Text bold={hot || isOpen} dimColor={!hot && !isOpen} wrap="truncate-end">{row.label}</Text>
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
              {reading || single ? null : <Text dimColor={!hot && !isOpen} bold={hot || isOpen}>{it.open ? " ▾" : " ▸"}</Text>}
            </Box>
            )}
            {below ? (
              <Box flexDirection="row" width={columns}>
                <Text>{"    "}</Text>
                <Box width={bodyWidth}>
                  <Text dimColor wrap="wrap">{below}</Text>
                </Box>
              </Box>
            ) : null}
            {reason ? (
              <Box flexDirection="row" width={columns}>
                <Text>{"    "}</Text>
                <Box width={bodyWidth}>
                  <Text color={BAD} wrap="wrap">{reason}</Text>
                </Box>
              </Box>
            ) : null}
            {isOpen ? (
              // What it printed sits on a shaded band, the way a message the user wrote does.
              <Box flexDirection="column" width={columns}>
                {shade.map((r, j) => (
                  <Box key={j} flexDirection="row" width={columns}>
                    <Text>{"  "}</Text>
                    <Text backgroundColor={USER_BG} color={USER_FG}>
                      {" "}
                      {r.kind !== undefined ? <Text dimColor>{r.kind}</Text> : null}
                      {r.text}
                      {" ".repeat(r.pad)}{" "}
                    </Text>
                  </Box>
                ))}
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
