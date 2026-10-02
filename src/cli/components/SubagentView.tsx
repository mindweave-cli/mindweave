/**
 * SubagentView — delegated work, as a distinct NESTED block.
 *
 * ONE worker keeps its full rail, because there is room to watch it:
 *
 *   ◆ Subagent · read-only   find every authFetch call site
 *   │ Searching authFetch
 *   │ Read login.ts
 *     ⎿ 3 steps · read-only        ← collapses here once it reports back
 *
 * SEVERAL at once become a topology instead, because read-only workers fan out in
 * parallel and their rails, side by side, are a stripe nobody can follow:
 *
 *   ◆ Subagents · 2 delegated
 *   ├── #1 · read-only  find every authFetch call site
 *   │      ⎿ 3 steps · read-only
 *   └── #2              draft unit tests for runCommand.ts
 *          ⎿ working · 4 steps
 *
 * The trade is deliberate: with one worker you can afford to watch each call; with
 * several you need the SHAPE of the delegation — who is doing what, and how far along
 * — and the individual calls become noise. What is shown is only what a worker
 * actually reports (its task, whether it may write, its progress). The reference
 * design also labels each with a model and an "isolated 8k window"; a sub-agent
 * carries neither, so inventing them would be decoration that reads as fact.
 *
 * A violet ◆ marker sets the whole family apart from the blue tool rows — these are
 * separate minds working inside the transcript, not more tools. A child's prose is
 * never shown; only its final distilled report crosses back, as the spawn's result.
 */
import { Box, Text } from "ink";
import { ERROR_COLOR } from "../toolDisplay.js";
import { collapseAdjacent } from "../toolItems.js";
import { PulseDot } from "./PulseDot.js";
import type { AgentEntry } from "../transcript.js";
import { BAD } from "../theme.js";

const DIAMOND = "●";
const BRANCH = "⎿";
const RAIL = "│";
const TEE = "├──";
const ELBOW = "└──";
// The rail/branch occupy 3 columns; item text hangs beside them, aligned under the
// header content and never spilling left into the marker gutter.
const RAIL_INDENT = 3;
/** A sub-agent is not given a colour of its own: plain, and red when one failed. */
const AGENT_COLOR: string | undefined = undefined;

export function SubagentView({
  agents,
  done,
  columns,
  tightTop,
}: {
  agents: AgentEntry[];
  done: boolean;
  columns: number;
  tightTop?: boolean;
}) {
  if (agents.length === 0) return null;
  const anyError = agents.some((a) => a.status === "error");
  const dotColor = anyError ? ERROR_COLOR : AGENT_COLOR;

  return (
    <Box marginTop={tightTop ? 0 : 1} flexDirection="column">
      <Box flexDirection="row">
        <Box minWidth={2}>
          {/* White like every tool dot: it pulses while the work goes on and is still once it is done. */}
          {done ? <Text>{DIAMOND}</Text> : <PulseDot glyph={DIAMOND} />}
        </Box>
        {agents.length === 1 ? (
          <SoloHeader agent={agents[0]!} columns={columns} color={dotColor} />
        ) : (
          <>
            <Text bold color={dotColor}>Subagents</Text>
            <Text dimColor>{` · ${agents.length} delegated`}</Text>
          </>
        )}
      </Box>

      {agents.length === 1 ? (
        <SoloBody agent={agents[0]!} columns={columns} done={done} />
      ) : (
        <Topology agents={agents} columns={columns} />
      )}
    </Box>
  );
}

/** One worker's header: its identity and the task it was given. */
function SoloHeader({ agent, columns, color }: { agent: AgentEntry; columns: number; color: string | undefined }) {
  const taskLabel = clip(agent.task, Math.max(16, columns - 22));
  return (
    <>
      <Text bold color={color}>Subagent</Text>
      {agent.readOnly ? <Text dimColor> · read-only</Text> : null}
      {taskLabel ? <Text dimColor>{"  "}{taskLabel}</Text> : null}
    </>
  );
}

/** One worker's live rail: every call it makes, then its closing line. */
function SoloBody({ agent, columns, done }: { agent: AgentEntry; columns: number; done: boolean }) {
  const content = Math.max(8, columns - RAIL_INDENT - 1);
  const errored = agent.status === "error";
  return (
    <Box flexDirection="column">
      {collapseAdjacent(agent.items).map((row) => (
        <Box key={row.item.toolId} flexDirection="row" width={columns}>
          <Text color={AGENT_COLOR} dimColor>{` ${RAIL} `}</Text>
          <Box width={content}>
            <Text color={row.anyError ? BAD : undefined} dimColor={!row.anyError} wrap="truncate-end">
              {row.label}{row.count > 1 ? `  ×${row.count}` : ""}
            </Text>
          </Box>
        </Box>
      ))}
      {done && agent.summary ? (
        <Box flexDirection="row" width={columns}>
          <Text dimColor>{` ${BRANCH} `}</Text>
          <Box width={content}>
            <Text color={errored ? BAD : undefined} dimColor={!errored} wrap="truncate-end">
              {agent.summary}
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

/** Several workers as a tree: one branch each, task on the branch, progress under it. */
function Topology({ agents, columns }: { agents: AgentEntry[]; columns: number }) {
  return (
    <Box flexDirection="column">
      {agents.map((agent, i) => {
        const last = i === agents.length - 1;
        const errored = agent.status === "error";
        // A worker still going is described by what it has DONE so far, since its
        // closing summary does not exist yet — otherwise a running branch says nothing
        // and reads as stalled.
        const steps = agent.items.length;
        const progress = agent.summary
          ? agent.summary
          : `working${steps > 0 ? ` · ${steps} step${steps === 1 ? "" : "s"}` : ""}`;
        const label = `#${i + 1}${agent.readOnly ? " · read-only" : ""}`;
        const taskWidth = Math.max(8, columns - 8 - label.length);
        return (
          <Box key={agent.agentId} flexDirection="column">
            <Box flexDirection="row" width={columns}>
              <Text color={AGENT_COLOR} dimColor>{`  ${last ? ELBOW : TEE} `}</Text>
              <Text bold color={errored ? ERROR_COLOR : AGENT_COLOR}>{label}</Text>
              <Box width={taskWidth}>
                <Text dimColor wrap="truncate-end">{"  "}{clip(agent.task, taskWidth)}</Text>
              </Box>
            </Box>
            <Box flexDirection="row" width={columns}>
              {/* The rail continues past a branch that is not the last one, so the
                  tree stays connected down the left edge. */}
              <Text color={AGENT_COLOR} dimColor>{`  ${last ? " " : RAIL}    ${BRANCH} `}</Text>
              <Box width={Math.max(8, columns - 12)}>
                <Text color={errored ? BAD : undefined} dimColor={!errored} wrap="truncate-end">
                  {progress}
                </Text>
              </Box>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** Flatten and clip a task to one short line for a header. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (max <= 1) return "";
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}
