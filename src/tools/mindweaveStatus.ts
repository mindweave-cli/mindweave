/**
 * mindweaveStatus.ts — what Mindweave is, right now, and who can change each part of it.
 *
 * Two questions kept having no answer. "What version are you running?" could only be
 * guessed at, because nothing in a turn carries it. And "turn that off" / "switch model"
 * ended in silence, because the agent had no way to know whether a thing was its to change
 * or the user's — so it either tried nothing or claimed something it had not done.
 *
 * So this reports the session's own facts, and then draws the line explicitly: the settings
 * the agent can change through its own tools, and the ones only the user can, each with the
 * command that does it. The second half is the load-bearing one — a capability the agent
 * lacks is only useful to the user if it comes back as "run /model", not as nothing.
 *
 * Read-only and deliberately cheap: it reads the live session context and the registry, and
 * touches no network and no disk beyond the version in package.json.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { appVersion } from "../cli/version.js";
import { modelLabel, providerOf, thinkLabel } from "../dynamo/model.js";
import { rootLabel, rootsOf } from "./paths.js";

/** What only the user can do, and the command that does it. Order: most asked first. */
const USER_ONLY: [what: string, how: string][] = [
  ["change the model, or the provider", "/model, /provider"],
  ["change how hard the model thinks", "/think"],
  ["add or replace an API key", "/key"],
  ["undo my file changes", "/undo"],
  ["summarize the conversation to free context", "/compact"],
  ["start a fresh conversation, or resume an old one", "/clear, /continue"],
  ["sign in to a remote MCP server", "/mcp, then Sign in"],
  ["switch between the fullscreen and inline shell", "/screen"],
  ["turn anonymous usage analytics on or off", "/analytics"],
  ["update Mindweave itself", "/update"],
];

/** What the agent can change on its own, so it offers rather than deflects. */
const AGENT_CAN = [
  "standing rules for this project, and lifting them (governor)",
  "forbidding a path, a command or an MCP tool, and lifting those (governor)",
  "skills: create one, delete one (skill)",
  "MCP servers: add, remove, disable, enable (mcp_server)",
  "durable memories (save_memory)",
  "the workspace: add another folder to work across (workspace)",
];

function list(label: string, items: string[]): string {
  if (items.length === 0) return `${label}: none`;
  return `${label} (${items.length}): ${items.join(", ")}`;
}

export const mindweaveStatus: Tool = {
  name: "mindweave",
  deferred: true,
  readOnly: true,
  keywords: [
    "version",
    "status",
    "about",
    "yourself",
    "self",
    "capabilities",
    "settings",
    "configuration",
    "config",
    "running",
    "mode",
    "who",
    // The words a user reaches for when asking for something only THEY can change: the
    // answer is this tool, which hands back the command instead of nothing.
    "model",
    "provider",
    "switch",
    "change",
    "undo",
    "compact",
    "analytics",
    "key",
  ],
  description:
    "Report what Mindweave is running right now and what can be changed. Answers 'what " +
    "version are you', 'which model are you using', 'what rules/skills/MCP servers are set " +
    "up here', 'what can you change yourself'. It also names the settings only the USER can " +
    "change and the command for each, so when you are asked for one of those you can say " +
    "exactly what to run instead of saying you cannot. Read-only: it changes nothing.",
  parameters: { type: "object", additionalProperties: false, properties: {} },

  async execute(_args, ctx: ToolContext): Promise<ToolResult> {
    const version = appVersion();
    const lines: string[] = [];
    lines.push(`Mindweave${version ? ` v${version}` : ""} (the terminal coding agent you are running as).`);

    const config = ctx.modelConfig;
    if (config) {
      const provider = providerOf(config.model);
      lines.push(`Model: ${modelLabel(config.model)} from ${provider.label}. Reasoning: ${thinkLabel(config)}.`);
    }
    const mode = ctx.planMode ? "Architect (planning, no edits)" : ctx.guarded ? "Sentinel (asks before acting)" : "Lightning";
    lines.push(`Mode: ${mode}.`);

    const roots = rootsOf(ctx);
    lines.push(
      roots.length > 1
        ? `Workspace: ${roots.map((r) => `${rootLabel(roots, r)} (${r})`).join(", ")}`
        : `Workspace: ${roots[0] ?? ctx.cwd}`,
    );

    const gov = ctx.governance;
    lines.push(list("Rules", (gov?.rules ?? []).map((r) => r.name)));
    lines.push(list("Skills", (gov?.skills ?? []).map((s) => `/${s.name}`)));
    const forbidden = gov?.forbidden;
    lines.push(
      list("Forbidden paths", forbidden?.patterns ?? []) +
        ` | ` +
        list("commands", forbidden?.commands ?? []) +
        ` | ` +
        list("MCP tools", forbidden?.mcpTools ?? []),
    );

    const servers = ctx.mcp?.statuses() ?? [];
    lines.push(
      servers.length === 0
        ? "MCP servers: none configured"
        : // `disabled` is a config fact, not a connection one: a disabled server is not
          // connected, and reporting it as "idle" would read as a fault.
          `MCP servers (${servers.length}): ${servers
            .map((s) => `${s.name} (${ctx.mcp?.configFor(s.name)?.disabled ? "disabled" : s.state}, ${s.toolCount} tools)`)
            .join(", ")}`,
    );

    lines.push("");
    lines.push("I can change these myself, if asked:");
    for (const item of AGENT_CAN) lines.push(`  - ${item}`);
    lines.push("");
    lines.push("Only the user can change these. Tell them the command rather than trying:");
    for (const [what, how] of USER_ONLY) lines.push(`  - ${what}: ${how}`);

    return {
      output: lines.join("\n"),
      summary: version ? `Mindweave v${version}` : "Mindweave",
      // The answer is the reply itself; a row saying "looked itself up" is noise.
      quiet: true,
    };
  },
};
