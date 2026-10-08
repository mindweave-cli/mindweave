/**
 * MarathonBox.tsx — the CLI's Marathon panel: the run's status and its task list, live.
 *
 * A passive panel under the input. It takes no keys and sits beside a fully live input, so
 * someone can keep typing (queue a message, steer the run) while it ticks. Its height follows
 * its content up to a cap (see marathonUi.ts) and every line is exactly one row: text is cut
 * with an ellipsis rather than wrapped, because a wrapped line is a row the footer's budget
 * did not plan for.
 *
 * Plain, like the rest of the screen: the task being worked on is a dot that blinks while the
 * run is alive, a finished one gets a green tick, and one still waiting is dim. The border stays
 * one neutral colour in every state; what the run is doing is said in the header.
 */
import { useEffect, useState, type ReactElement } from "react";
import { Box, Text } from "ink";
import { marathonBoxHeight, windowChecklist, type MarathonUi } from "../marathonUi.js";
import { GOOD } from "../theme.js";

const BLINK_MS = 550;
const BORDER = "gray";

/** Cut to `max` columns with an ellipsis (a single row, never wrapped). */
export function fit(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export function MarathonBox({ ui, width, cap }: { ui: MarathonUi; width: number; cap: number }): ReactElement {
  const alive = ui.phase === "running" || ui.phase === "verifying";
  const [lit, setLit] = useState(true);
  useEffect(() => {
    if (!alive) return;
    const id = setInterval(() => setLit((v) => !v), BLINK_MS);
    return () => clearInterval(id);
  }, [alive]);

  const inner = Math.max(10, width - 4); // border (2) + padding (2)
  const color = BORDER;
  const height = marathonBoxHeight(ui, cap);

  const title = ui.phase === "armed" ? "armed" : ui.line || "starting";
  const spend = ui.spend && ui.phase !== "armed" ? ` · ${ui.spend}` : "";

  let body: ReactElement;
  if (ui.phase === "armed") {
    body = (
      <>
        <Text wrap="truncate-end">Type your goal and press Enter to start.</Text>
        <Text dimColor wrap="truncate-end">Asks first, then runs on its own. Esc cancels.</Text>
      </>
    );
  } else if (ui.todos.length === 0) {
    body = (
      <Text wrap="truncate-end">
        {alive ? <Text dimColor={!lit}>{"● "}</Text> : null}
        <Text dimColor>{fit(ui.goal || "getting started…", inner - 2)}</Text>
      </Text>
    );
  } else {
    const w = windowChecklist(ui.todos, Math.max(3, cap));
    body = (
      <>
        {w.above > 0 ? <Text dimColor wrap="truncate-end">{`  ↑ ${w.above} earlier`}</Text> : null}
        {w.rows.map(({ item, index }) => {
          if (item.status === "completed") {
            return (
              <Text key={index} wrap="truncate-end">
                <Text color={GOOD}>✔ </Text>
                <Text dimColor>{fit(item.content, inner - 2)}</Text>
              </Text>
            );
          }
          if (item.status === "in_progress") {
            return (
              <Text key={index} wrap="truncate-end">
                <Text dimColor={alive && !lit}>{"● "}</Text>
                <Text>{fit(item.activeForm || item.content, inner - 2)}</Text>
              </Text>
            );
          }
          return (
            <Text key={index} wrap="truncate-end" dimColor>
              {"○ "}
              {fit(item.content, inner - 2)}
            </Text>
          );
        })}
        {w.below > 0 ? <Text dimColor wrap="truncate-end">{`  ↓ ${w.below} more`}</Text> : null}
      </>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      flexShrink={0}
      borderStyle="single"
      borderColor={color}
      paddingX={1}
      overflow="hidden"
    >
      <Text wrap="truncate-end">
        <Text bold>Marathon</Text>
        <Text dimColor>{` · ${fit(title, Math.max(8, inner - 11 - spend.length))}${spend}`}</Text>
      </Text>
      {body}
    </Box>
  );
}
