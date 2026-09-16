/**
 * commands.ts — the built-in slash commands, as data.
 *
 * ONE list, read by three things that must never disagree: the input's autocomplete,
 * what `/help` prints, and what `routeCommand` accepts as a builtin. A command missing
 * from here is not merely undocumented — it does not route, so typing it gets the
 * unknown-command reply while everything about the command itself works perfectly.
 *
 * That exact failure has happened here before, and it was invisible in the source: a
 * documented `/mcp add` never matched anything for months because of a stray byte in its
 * guard (see commandRoute.ts). So the list lives apart from the component that renders
 * it, and a test walks every entry through the real router rather than trusting that
 * being written down is the same as being reachable.
 */

/** A command and the one line describing it. */
export interface CommandInfo {
  name: string;
  description: string;
}

/** The built-in commands. Project skills are appended at render time from the live
 *  session; these are the ones that always exist. */
export const BASE_COMMANDS: CommandInfo[] = [
  { name: "/help", description: "show this list" },
  { name: "/init", description: "write MINDWEAVE.md — what the agent should always know about this project" },
  { name: "/provider", description: "choose which provider serves this project" },
  { name: "/key", description: "add or replace an API key" },
  { name: "/model", description: "choose which model answers, from the current provider" },
  { name: "/think", description: "set the reasoning level for the model" },
  { name: "/screen", description: "choose the shell: fullscreen, or inline (beta)" },
  { name: "/rules", description: "list rules, or add one: /rules <directive>" },
  { name: "/skills", description: "list skills, or make one: /skills <description>" },
  { name: "/forbidden", description: "list protected paths, or add: /forbidden <path>" },
  { name: "/forbid-command", description: "list forbidden commands, or add: /forbid-command <command>" },
  { name: "/link", description: "pull in the rest of the project (monorepo / sibling repos)" },
  { name: "/include", description: "add a folder to the workspace: /include <path>" },
  { name: "/exclude", description: "remove an added folder: /exclude <label>" },
  { name: "/shells", description: "view or stop background commands (tests, servers)" },
  { name: "/mcp", description: "view MCP servers; /mcp add <name> <command|url> to connect one" },
  { name: "/context", description: "show what is filling the context window" },
  { name: "/undo", description: "roll back file changes: /undo, /undo list, /undo <n>" },
  { name: "/compact", description: "summarize the conversation to free up context" },
  { name: "/update", description: "update Mindweave and restart into this conversation" },
  { name: "/analytics", description: "see or switch anonymous usage analytics on/off" },
  { name: "/clear", description: "start a fresh conversation in this project" },
  { name: "/continue", description: "pick a past session to resume" },
];
