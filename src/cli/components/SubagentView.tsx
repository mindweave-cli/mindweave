/**
 * SubagentView — delegated work, as a title and an answer, with the working a click away.
 *
 *   ● Sub-agent  Re-verifying a FIXED bug in Notes App  · read-only
 *     ! Could not fully verify · 8 checks · 20 steps · 2m 10s  ▸
 *
 * While it works, the dot pulses and the second line says where it is:
 *
 *   ● Sub-agent  Re-verifying a FIXED bug in Notes App  · read-only
 *     step 12 · reading use-debounced.ts  1m 5s  ▸
 *
 * What you want from a worker is the answer, so that is what shows: how it ended (a tick, a cross,
 * or a bang when it could only half do it), the steps it took and the time. Its task is a prompt
 * written for a model, so the line holds a short title taken from it, not the prompt itself. A
 * click opens a shaded band: the task, the result, a count of what it did, then each thing it
 * did, with repeats merged (a poll that came back six times is one line, ×6).
 *
 * Several at once are one group, each with its own two lines, so the shape of the delegation is
 * visible: who is doing what and how far along. A child's own prose is never shown; only its
 * report crosses back. The same look as the folded commands row, so there is one thing to learn.
 */
import { Box, Text, type DOMElement } from "ink";
import { PulseDot } from "./PulseDot.js";
import { Elapsed } from "./ToolLine.js";
import { agentTitle, bandRows, bodyRows, humanSpan, markOf, nowText, toneOf, type Tone } from "../agentLines.js";
import { registerExpandable, itemHit } from "../expandHits.js";
import type { AgentEntry } from "../transcript.js";
import { BAD, GOOD, USER_BG, USER_FG, WARN } from "../theme.js";

const DOT = "●";

const COLOUR: Record<"good" | "bad" | "warn", string> = { good: GOOD, bad: BAD, warn: WARN };
const colourOf = (tone: Tone): string | undefined => (tone ? COLOUR[tone] : undefined);

export function SubagentView({
  id,
  agents,
  done,
  columns,
  tightTop,
  hoveredItem,
}: {
  id: number;
  agents: AgentEntry[];
  done: boolean;
  columns: number;
  tightTop?: boolean;
  /** The pointer is over the worker at this place in the group, or -1. */
  hoveredItem?: number;
}) {
  if (agents.length === 0) return null;
  const solo = agents.length === 1;
  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      {solo ? null : (
        <Box flexDirection="row">
          <Box minWidth={2}>{done ? <Text>{DOT}</Text> : <PulseDot glyph={DOT} />}</Box>
          <Text bold>Sub-agents</Text>
          <Text dimColor>{` · ${agents.length} delegated`}</Text>
        </Box>
      )}
      {agents.map((agent, i) => (
        <AgentBlock key={agent.agentId} id={id} index={i} agent={agent} lead={solo} done={done} columns={columns} hot={hoveredItem === i} />
      ))}
    </Box>
  );
}

function AgentBlock({
  id,
  index,
  agent,
  lead,
  done,
  columns,
  hot,
}: {
  id: number;
  index: number;
  agent: AgentEntry;
  /** The only worker: its dot is the block's dot. */
  lead: boolean;
  done: boolean;
  columns: number;
  hot: boolean;
}) {
  const running = agent.status === "running";
  const tone = toneOf(agent);
  const name = lead ? "Sub-agent" : `#${index + 1}`;
  const tag = agent.readOnly ? " · read-only" : "";
  // Everything on the title line has a fixed place, so a long title is cut at a word and never squeezes
  // the name, as it once did ("Subagen").
  const room = Math.max(10, columns - 2 - name.length - 2 - tag.length - 1);
  const title = agentTitle(agent.task, room);
  const steps = agent.steps ?? agent.items.length;
  const took = agent.endedAt !== undefined && agent.startedAt !== undefined ? humanSpan(agent.endedAt - agent.startedAt) : "";
  const arrow = agent.open ? " ▾" : " ▸";
  const registered = (node: DOMElement | null) => registerExpandable(itemHit(id, index), node);

  const band = agent.open ? bandRows(bodyRows(agent, running, bandWidth(columns)), columns) : [];

  return (
    <Box flexDirection="column" ref={registered}>
      <Box flexDirection="row" width={columns}>
        <Box minWidth={2} flexShrink={0}>
          {lead ? running ? <PulseDot glyph={DOT} /> : <Text>{DOT}</Text> : <Text>{"  "}</Text>}
        </Box>
        <Box flexShrink={0}>
          <Text bold>{name}</Text>
        </Box>
        {title ? (
          <Box flexShrink={0}>
            <Text bold={hot}>{"  "}{title}</Text>
          </Box>
        ) : null}
        {tag ? (
          <Box flexShrink={0}>
            <Text dimColor>{tag}</Text>
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="row" width={columns}>
        <Text>{"  "}</Text>
        {running ? (
          <>
            <Box flexShrink={0}>
              <Text dimColor>{`step ${agent.items.length}${nowText(agent.items) ? ` · ${nowText(agent.items)}` : ""}`.slice(0, Math.max(12, columns - 16))}</Text>
            </Box>
            {agent.startedAt !== undefined ? <Elapsed since={agent.startedAt} /> : null}
          </>
        ) : (
          <>
            <Box flexShrink={0}>
              <Text color={colourOf(tone)} bold={tone === "bad"}>{`${markOf(tone)} ${agent.headline ?? agent.summary ?? "Finished"}`}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor>{` · ${steps} step${steps === 1 ? "" : "s"}${took ? ` · ${took}` : ""}`}</Text>
            </Box>
          </>
        )}
        <Box flexShrink={0}>
          <Text dimColor={!hot} bold={hot}>{arrow}</Text>
        </Box>
      </Box>
      {agent.open ? (
        <Box flexDirection="column" width={columns}>
          {band.map((r, j) => (
            <Box key={j} flexDirection="row" width={columns}>
              <Text>{"  "}</Text>
              <Text backgroundColor={USER_BG} color={USER_FG}>
                {" "}
                <Text dimColor>{r.label.padEnd(8)}</Text>
                <Text color={colourOf(r.tone)}>{r.text}</Text>
                {" ".repeat(r.pad)}
                {" "}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/** The width its task and the rest are wrapped to inside the band. */
function bandWidth(columns: number): number {
  return Math.max(8, columns - 14);
}
