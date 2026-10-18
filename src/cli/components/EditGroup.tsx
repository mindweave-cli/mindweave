/**
 * EditGroup — the files the agent wrote or edited one after another, as ONE row.
 *
 *   ● Wrote 7 files  +492  tsconfig.main.json, tsconfig.json, vite.config.ts, +4 more  ▸
 *
 * Opened, the names give way to the list: one line for each edit, the file and the lines added and
 * removed, and a click on a line shows what changed in it. A click on a name in the closed row opens
 * the row with that file's change already showing. Failures show in the row without opening anything.
 */
import { Box, Text, type DOMElement } from "ink";
import { PulseDot } from "./PulseDot.js";
import { fitPath } from "./WorkGroup.js";
import { registerExpandable, registerRowBox, itemHit } from "../expandHits.js";
import { BAD, GOOD, USER_BG, USER_FG } from "../theme.js";
import { visibleWidth, wrapAnsi } from "../wrap.js";
import { expandTabs } from "../diffRows.js";
import { plainLine } from "../workLines.js";
import { editStats, headerLayout } from "../editGroup.js";
import type { WorkItem } from "../transcript.js";

const DOT = "●";
const VERB: Record<string, [string, string]> = { Update: ["Editing", "Edited"], Write: ["Writing", "Wrote"] };

interface Band {
  text: string;
  color?: string;
  dim?: boolean;
}

/** What an opened edit shows, as rows of exact width: the change, added lines green and removed lines red. */
export function bandRows(it: WorkItem, width: number): Band[] {
  const source = it.full ?? it.detail;
  const lines = source ? source.split("\n").map((l) => expandTabs(plainLine(l))) : [it.summary?.trim() || "(nothing to show for this change)"];
  const inner = Math.max(6, width - 2);
  return lines.flatMap((line) => {
    const color = /^\+(?!\+\+)/.test(line) ? GOOD : /^-(?!--)/.test(line) ? BAD : undefined;
    return wrapAnsi(line === "" ? " " : line, inner).map((text) => ({ text, color, dim: color === undefined }));
  });
}

/** The head of an item's own line in the opened list. */
const verbOf = (it: WorkItem): string => (VERB[it.name] ?? ["Changing", "Changed"])[it.status === "running" ? 0 : 1];

export function EditGroup({
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
  hovered?: boolean;
  hoveredItem?: number;
}) {
  const lay = headerLayout(items, columns, live);
  const working = !!live && items.some((it) => it.status === "running");
  const room = Math.max(8, columns - 4 - 14);
  return (
    <Box ref={(node: DOMElement | null) => registerRowBox(id, node)} marginTop={tightTop ? 0 : 1} flexDirection="column">
      <Box ref={(node: DOMElement | null) => registerExpandable(id, node)} flexDirection="row" width={columns}>
        <Box minWidth={2} flexShrink={0}>
          {working ? <PulseDot glyph={DOT} /> : <Text>{DOT}</Text>}
        </Box>
        <Box flexShrink={0}>
          <Text bold dimColor={!hovered}>{lay.head}</Text>
        </Box>
        {lay.stat ? (
          <Box flexShrink={0}>
            <Text>{"  "}</Text>
            {lay.failed > 0 ? <Text color={BAD}>{`${lay.failed} failed${lay.add || lay.del ? " " : ""}`}</Text> : null}
            {lay.add ? <Text color={GOOD}>{`+${lay.add}`}</Text> : null}
            {lay.add && lay.del ? <Text> </Text> : null}
            {lay.del ? <Text color={BAD}>{`−${lay.del}`}</Text> : null}
          </Box>
        ) : null}
        {!open ? (
          <Box flexShrink={0}>
            <Text>{"  "}</Text>
            {lay.names.map((n, i) => (
              <Text key={n.index} dimColor>
                {i > 0 ? ", " : ""}
                {/* Pointed at: underlined and bright, so it reads as its own click and not as the row's (which turns bold). */}
                <Text bold={!!items[n.index]?.open} dimColor={!items[n.index]?.open && hoveredItem !== n.index} underline={hoveredItem === n.index}>{n.label}</Text>
              </Text>
            ))}
            {lay.more > 0 ? <Text dimColor>{`, ${lay.cut}`}</Text> : null}
          </Box>
        ) : null}
        <Box flexShrink={0}>
          <Text dimColor={!hovered} bold={hovered}>{open ? "  ▾" : "  ▸"}</Text>
        </Box>
      </Box>
      {/* The list when the row is open; closed, only the files whose change was opened by a click on their name. */}
      {open || items.some((it) => it.open) ? (
        <Box flexDirection="column">
          {items.map((it, index) => {
            if (!open && !it.open) return null;
            const stats = editStats(it);
            const isOpen = !!it.open;
            const hot = hoveredItem === index;
            const failed = it.status === "error";
            const label = fitPath(it.arg ?? it.name, room);
            const band = isOpen ? bandRows(it, columns - 4) : [];
            return (
              <Box key={it.toolId} flexDirection="column" ref={(node: DOMElement | null) => registerExpandable(itemHit(id, index), node)}>
                <Box flexDirection="row" width={columns}>
                  <Text>{"  "}</Text>
                  <Box width={9} flexShrink={0}>
                    <Text dimColor>{verbOf(it)}</Text>
                  </Box>
                  <Box width={label.length + 2} flexShrink={0}>
                    <Text bold={hot || isOpen} dimColor={!hot && !isOpen} wrap="truncate-end">{label}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    {it.status === "running" ? (
                      <PulseDot glyph={DOT} />
                    ) : failed ? (
                      <Text color={BAD}>failed</Text>
                    ) : (
                      <>
                        {stats.add ? <Text color={GOOD}>{`+${stats.add}`}</Text> : null}
                        {stats.add && stats.del ? <Text> </Text> : null}
                        {stats.del ? <Text color={BAD}>{`−${stats.del}`}</Text> : null}
                      </>
                    )}
                  </Box>
                  <Text dimColor={!hot && !isOpen} bold={hot || isOpen}>{isOpen ? " ▾" : " ▸"}</Text>
                </Box>
                {isOpen ? (
                  <Box flexDirection="column" width={columns}>
                    {band.map((r, j) => (
                      <Box key={j} flexDirection="row" width={columns}>
                        <Text>{"  "}</Text>
                        <Text backgroundColor={USER_BG} color={r.color ?? USER_FG} dimColor={r.dim}>
                          {" "}
                          {r.text}
                          {" ".repeat(Math.max(0, columns - 4 - 2 - visibleWidth(r.text)))}
                          {" "}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}
