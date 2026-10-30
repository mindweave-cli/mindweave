/**
 * AgentTabs — the row under the chat that switches between the main agent and the sub-agents it started.
 *
 *   Main   #1 Check the login flow ●   #2 Review the diff ✓          ←/→ switch
 *
 * It exists only while the current turn has sub-agents, so a session that never delegates has no row for it. The one being
 * shown is bold and bright; the others are dim, each with a mark: a dot while it works, then a tick, a bang or a cross.
 */
import { Box, Text } from "ink";
import { tabLabel, tabMark } from "../agentView.js";
import type { AgentEntry } from "../transcript.js";
import { ACCENT, BAD, GOOD, WARN } from "../theme.js";

const TONE = { good: GOOD, bad: BAD, warn: WARN } as const;

export function AgentTabs({ agents, viewing, width }: { agents: AgentEntry[]; viewing: string | null; width: number }) {
  if (agents.length === 0) return null;
  const hint = "←/→ switch";
  // Tabs are cut from the right when the row is too narrow, the hint first.
  let used = 2 + "Main".length;
  const tabs: Array<{ agent: AgentEntry; index: number }> = [];
  agents.forEach((agent, index) => {
    const len = 3 + tabLabel(agent, index).length + 2;
    if (used + len > width - hint.length - 1) return;
    used += len;
    tabs.push({ agent, index });
  });
  const hidden = agents.length - tabs.length;
  return (
    <Box flexShrink={0} width={width}>
      <Text>{"  "}</Text>
      {viewing === null ? <Text bold color={ACCENT}>Main</Text> : <Text dimColor>Main</Text>}
      {tabs.map(({ agent, index }) => {
        const mine = agent.agentId === viewing;
        const { mark, tone } = tabMark(agent);
        const colour = tone === "running" ? WARN : tone ? TONE[tone as keyof typeof TONE] : undefined;
        return (
          <Box key={agent.agentId} flexShrink={0}>
            <Text>{"   "}</Text>
            {mine ? <Text bold color={ACCENT}>{tabLabel(agent, index)}</Text> : <Text dimColor>{tabLabel(agent, index)}</Text>}
            <Text color={colour}>{` ${mark}`}</Text>
          </Box>
        );
      })}
      {hidden > 0 ? <Text dimColor>{`   +${hidden}`}</Text> : null}
      <Box flexGrow={1} justifyContent="flex-end">
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}
