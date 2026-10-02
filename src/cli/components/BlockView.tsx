/**
 * BlockView — render one transcript block, the same whether committed (in
 * <Static> scrollback) or live in the tail. Gutter-aligned: the
 * first row of every block is a single marker in a 2-col gutter, the content
 * breathing beside it and wrapped lines hanging under the content.
 *
 * Multi-line text is wrapped BY US (wrap.ts), not left to Ink's own
 * `wrap="wrap"` — that has a real, reproduced bug where some continuation
 * lines come out indented by a stray leading space and others on the exact
 * same text don't (see wrap.ts's header comment for the proof). Wrapping
 * ourselves and rendering one <Text> per finished line leaves nothing for
 * Ink's wrapper to be inconsistent about.
 */
import { memo } from "react";
import { Box, Text } from "ink";
import { renderMarkdown } from "../markdown.js";
import { wrapAnsi, visibleWidth } from "../wrap.js";
import { BAD, USER_BG, USER_FG } from "../theme.js";
import { compactionLines } from "../compaction.js";
import { ToolLine } from "./ToolLine.js";
import { ToolGroup } from "./ToolGroup.js";
import { SubagentView } from "./SubagentView.js";
import type { Block } from "../transcript.js";

/**
 * Text pre-wrapped to `width`, one <Text> row per line — see the file header.
 *
 * A blank line is rendered as a single space, not as "". Ink's `measureText`
 * (`ink/build/measure-text.js`) returns `height: 0` for an empty string, so an empty
 * <Text> occupies no row at all and every blank line in the markdown disappears —
 * which is what turned structured answers into one undifferentiated wall. The
 * separators were being produced correctly by renderMarkdown and thrown away here.
 * Probed: rows ["A","","B"] render as ["A","B"] with "", as ["A","","B"] with " ".
 */
function WrappedText({ text, width, color }: { text: string; width: number; color?: string }) {
  return (
    <Box width={width} flexDirection="column">
      {wrapAnsi(text, width).map((line, i) => (
        <Text key={i} color={color} wrap="truncate-end">{line === "" ? " " : line}</Text>
      ))}
    </Box>
  );
}

/**
 * Your own message: a grey band the full width of the conversation, white text inside it.
 *
 * It used to be coloured text (cyan), which was the loudest thing on screen and still read
 * as just another kind of output. A band marks the turn without colouring the words, the
 * way the app draws your message on its own surface. Every row is padded to the full width
 * so the band is one even block rather than ragged ends, with a column of padding on each
 * side so the text does not touch its right edge. The ">" sits in the first column, exactly where the
 * agent's dot does, and the words start in the same column as the agent's words, so the two
 * kinds of message line up down the screen.
 */
function UserBand({ text, columns }: { text: string; columns: number }) {
  const width = Math.max(10, columns);
  const inner = Math.max(4, width - 3); // the "> " gutter, then one space at the right edge
  const rows = wrapAnsi(text, inner);
  return (
    <Box marginTop={1} flexDirection="column" width={width}>
      {rows.map((line, i) => {
        const body = line === "" ? "" : line;
        const pad = Math.max(0, inner - visibleWidth(body));
        return (
          <Text key={i} backgroundColor={USER_BG} color={USER_FG} wrap="truncate-end">
            {`${i === 0 ? ">" : " "} ${body}${" ".repeat(pad)} `}
          </Text>
        );
      })}
    </Box>
  );
}

function BlockViewInner({ block, columns, tightTop }: { block: Block; columns: number; tightTop?: boolean }) {
  const textWidth = Math.max(8, columns - 4);

  switch (block.kind) {
    case "user":
      return <UserBand text={block.text} columns={columns} />;

    case "assistant": {
      if (!block.text) return null;
      // Prose runs to the same width as everything else on screen.
      //
      // It used to be capped at 88 columns on a typographic argument: past roughly
      // that, the eye starts losing its place on the return sweep. The argument is
      // real for a page of body text and wrong for this. A terminal is a pane the
      // reader sized deliberately, and the answer sat in a narrow column with a third
      // of the window empty beside it, which reads as broken rather than considered.
      // Widening the window should give you more room, not more margin.
      const proseWidth = textWidth;
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text>{"●"}</Text></Box>
          <WrappedText text={renderMarkdown(block.text, proseWidth)} width={proseWidth} />
        </Box>
      );
    }

    case "tool":
      return (
        <ToolLine
          name={block.name}
          arg={block.arg}
          status={block.status}
          action={block.action}
          summary={block.summary}
          detail={block.detail}
          detailKind={block.detailKind}
          meta={block.meta}
          columns={columns}
          live={block.live}
          tightTop={tightTop}
          since={block.since}
          waited={block.waited}
          startedAt={block.startedAt}
        />
      );

    case "tools":
      return <ToolGroup items={block.items} live={block.live} columns={columns} tightTop={tightTop} />;

    case "subagent":
      return (
        <SubagentView
          agents={block.agents}
          done={block.done}
          columns={columns}
          tightTop={tightTop}
        />
      );

    case "error":
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text color={BAD}>{"●"}</Text></Box>
          <WrappedText text={block.text} width={textWidth} color={BAD} />
        </Box>
      );

    case "completion":
      return (
        <Box marginTop={1} flexDirection="row">
          <Box minWidth={2}><Text dimColor>{"●"}</Text></Box>
          <Text dimColor>{block.text}</Text>
        </Box>
      );

    case "note": {
      const noteLines = wrapAnsi(block.text, Math.max(4, columns - 2));
      return (
        <Box width={columns} flexDirection="column">
          {noteLines.map((line, i) => (
            <Text key={i} dimColor>{i === 0 ? "· " : "  "}{line}</Text>
          ))}
        </Box>
      );
    }

    case "notice": {
      // A gate, not a remark. Amber marker and a rail, so "you are about to run this"
      // cannot be mistaken for the assistant's own ● prose and skimmed past. Lines are
      // rendered verbatim — no markdown — because they are literal commands and paths
      // where a stray backtick or underscore must not be reinterpreted.
      const railWidth = Math.max(8, columns - 4);
      return (
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row">
            <Box minWidth={2}><Text>{"●"}</Text></Box>
            <Text bold>{block.title}</Text>
          </Box>
          {block.body.split("\n").flatMap((line, i) =>
            wrapAnsi(line, railWidth).map((row, j) => (
              <Box key={`${i}-${j}`} flexDirection="row" width={columns}>
                <Text dimColor>{"  │ "}</Text>
                <Box width={railWidth}>
                  <Text wrap="truncate-end">{row}</Text>
                </Box>
              </Box>
            )),
          )}
        </Box>
      );
    }

    case "compaction": {
      // The bars are pre-composed as plain rows (compaction.ts) so the layout is
      // testable without a terminal. Each row is printed verbatim and truncated, never
      // wrapped: half a progress bar on the next line reads as two broken bars.
      const rows = compactionLines(block.report, columns - 2);
      return (
        <Box marginTop={1} marginBottom={1} flexDirection="column" width={columns}>
          {rows.map((line, i) => (
            <Text key={i} dimColor={i !== 1} wrap="truncate-end">{"  "}{line}</Text>
          ))}
        </Box>
      );
    }

    case "context":
      // Context trimming (compaction) — set off from ordinary activity with its own
      // faint marker and italics, so it reads as housekeeping, not something Mindweave did.
      return (
        <Box marginTop={1} marginBottom={1} width={columns}>
          <Text dimColor italic wrap="truncate-end">{"⋯ "}{block.text}</Text>
        </Box>
      );
  }
}

/**
 * MEMOIZED, and this is the single most load-bearing line in the UI's performance.
 *
 * Ink re-renders the WHOLE component tree on every React state change — there is no
 * partial update, and after the commit it erases the drawn lines and rewrites them.
 * Every keystroke is a state change (the prompt's reducer), and so is every wheel
 * tick (`scrollUp`). Without this wrapper each of those re-ran `renderMarkdown` and
 * `wrapAnsi` from scratch for EVERY block on screen, then handed Yoga a fresh tree to
 * lay out.
 *
 * Measured, on a realistic assistant reply, before this landed:
 *
 *   | blocks | text work per keystroke |
 *   |--------|-------------------------|
 *   |     30 |                 17.9 ms |
 *   |     80 |                 47.7 ms |
 *   |    150 |                 89.4 ms |
 *
 * — and that is BEFORE layout and redraw, against Ink's 32ms frame throttle. It is
 * why typing got slower the longer the conversation ran, why scrolling stuttered, and
 * why a tool block "popped" instead of appearing cleanly: it was landing inside a
 * frame that took ~90ms to draw.
 *
 * The reason a plain shallow compare is CORRECT here, rather than a lucky shortcut:
 * the transcript reducer never rebuilds a block that did not change. `commit` concats,
 * `patch` maps and returns `b` untouched unless the id matches, and `endTurn`'s `clear`
 * returns `b` itself for everything except a live tool row. So block identity is stable
 * across renders by construction, and the one moment a committed row is allowed to
 * change (`live` flipping at turn end) DOES produce a new object and so DOES re-render.
 * `columns` and `tightTop` are primitives. Nothing here is a fresh object or closure
 * per render, which is the usual reason `memo` silently does nothing.
 *
 * If a future block type is given a prop that is built inline at the call site (an
 * array, an object, a callback), this optimization is dead and the lag returns with no
 * test failing. Keep the props primitive-or-stable.
 */
export const BlockView = memo(BlockViewInner);

