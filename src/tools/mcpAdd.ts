/**
 * mcpAdd.ts — connecting an MCP server by asking for it.
 *
 * Mindweave is a conversation, not a settings pane, so the natural way to add an
 * integration is to say so: "add the github mcp server, my token is in GITHUB_TOKEN".
 * This is the tool that makes that work. `/mcp add` is the same thing for when you
 * already know the exact command; both go through one writer so they cannot drift.
 *
 * ASK-FIRST, always. This writes a config file that spawns a process on every future
 * session, usually with a credential attached. That is squarely in the class of action
 * the approval channel exists for, and it is not something to infer from an ambiguous
 * request. With no channel to ask through it refuses rather than proceeding, matching
 * how every other governed action in the codebase fails.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import {
  addServerToConfig,
  configPathFor,
  parseAddSpec,
  removeServerFromConfig,
  resolveConfigPath,
  serverExistsInConfig,
  type AddScope,
} from "../mcp/configWrite.js";

const ADD = "Yes, add it";
const REPLACE = "Yes, replace it";
const SKIP = "No, don't";

export const mcpServer: Tool = {
  name: "mcp_server",
  deferred: true,
  readOnly: false,
  // The credential guidance was WRONG, not merely thin. It told the model to reference
  // an environment variable, and the parameter example showed "$GITHUB_TOKEN" — but
  // nothing expands `$VAR` anywhere in the MCP layer (measured), so that value reaches
  // the server as the literal seven-dollar string and the server fails to authenticate,
  // looking like a bad token rather than a bad config. Meanwhile the parent environment
  // is already inherited, so the variable the model was told to "reference" needed no
  // mention at all. The correct advice is close to the opposite of what was written.
  keywords: ["mcp", "server", "integration", "connect", "add", "remove", "delete", "disable", "enable", "turn", "off"],
  description:
    "Manage this project's MCP servers: `action` add (the default), remove, disable or " +
    "enable one. Disabling keeps the server configured and stops its tools being offered, " +
    "which is what 'turn off the linear server for now' means; removing deletes it from " +
    "the config. Both take just a `name`, and both ask the user first.\n" +
    "Adding connects a new MCP server to this project so its tools become available to you. " +
    "Use it when the user asks to add an integration: 'add the github mcp server', " +
    "'connect to our postgres'. Give either a `command` (with `args`) for a local " +
    "server or a `url` for a remote one, never both. The user is always asked to " +
    "confirm, and is told if this would replace a server of the same name.\n" +
    "CREDENTIALS: the server already inherits the user's whole environment, so a token " +
    "that is ALREADY set in their shell needs no `env` entry — leave it out and it just " +
    "works. `env` values are NOT expanded: \"$GITHUB_TOKEN\" is passed through as those " +
    "literal characters, not as the variable's contents, which fails as an invalid " +
    "credential rather than as an obvious mistake. So use `env` only for a literal " +
    "value the user gave you for this purpose, knowing it is written to a config file " +
    "in plain text. Never invent, guess, or copy a credential from elsewhere in the " +
    "conversation; if one is needed and you do not have it, ask.\n" +
    "A REMOTE SERVER THAT ANSWERS 401 NEEDS SIGNING IN, NOT AN API KEY. Nearly every " +
    "hosted MCP server uses OAuth, and Mindweave signs in to those itself: tell the user " +
    "to run `/mcp`, open the server, and choose 'Sign in'. A browser opens, they approve, " +
    "and the token is stored securely and refreshed automatically. Do NOT ask for an API " +
    "key or offer to write an Authorization header for a 401 — that puts a long-lived " +
    "secret in a config file to do a job the sign-in already does better. Headers are for " +
    "the rarer server that genuinely has no OAuth at all and documents a static key.\n" +
    "The name becomes the prefix of every tool the server offers (`github` → " +
    "`mcp__github__*`), so keep it short and recognisable. Default to this project; " +
    "`global: true` follows the user into unrelated work and is rarely what they mean.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      action: {
        type: "string",
        enum: ["add", "remove", "disable", "enable"],
        description:
          "Default 'add'. 'disable' keeps the server but stops offering its tools; 'enable' undoes that; " +
          "'remove' deletes it from the config. Those three need only `name`.",
      },
      name: {
        type: "string",
        description: "Short server name; becomes the prefix of its tools (e.g. 'github' → mcp__github__*).",
      },
      command: {
        type: "string",
        description: "Executable for a local server, e.g. 'npx'. Omit if using `url`.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments for the command, e.g. ['-y', '@modelcontextprotocol/server-github'].",
      },
      url: {
        type: "string",
        description: "https:// endpoint for a remote server. Omit if using `command`.",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Literal environment variables for a local server. NOT expanded — \"$FOO\" is " +
          "passed as those characters. Omit for anything already set in the user's shell; " +
          "the server inherits it.",
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Headers for a remote server, e.g. {\"Authorization\": \"Bearer ...\"}.",
      },
      global: {
        type: "boolean",
        description: "Save for every project instead of just this one. Default false.",
      },
    },
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const action = typeof args.action === "string" ? args.action.trim() : "add";
    if (action === "remove" || action === "disable" || action === "enable") {
      return manageServer(action, args, ctx);
    }
    if (action !== "add") {
      return { output: "Error: `action` must be add, remove, disable or enable.", isError: true, summary: "bad action" };
    }
    const spec = specFromArgs(args);
    if (!spec.ok) return { output: `Error: ${spec.error}`, isError: true, summary: "bad server spec" };

    if (!ctx.requestApproval) {
      return {
        output:
          "Error: adding an MCP server needs the user's confirmation and there's no way to ask here. " +
          "Tell them the command to run instead: /mcp add " + spec.display,
        isError: true,
        summary: "cannot ask to add server",
      };
    }

    const root = ctx.governance?.forbidden.root ?? ctx.cwd;
    const path = configPathFor(spec.scope, root);

    // Say what the write will actually DO, before consent is given rather than after.
    // Two things were missing and both change the answer: that an existing server of
    // this name is being REPLACED (the code knew, but only reported it afterwards),
    // and that credentials are being written to a file. Only the KEYS are shown — the
    // values are the secret, and putting one on screen also puts it in the transcript.
    const replacing = await serverExistsInConfig(path, spec.parsed.name);
    const secretKeys = [...Object.keys(spec.parsed.config.type === "http" ? (spec.parsed.config.headers ?? {}) : (spec.parsed.config.env ?? {}))];
    const verb = replacing ? `REPLACE the existing MCP server '${spec.name}'` : `Add the MCP server '${spec.name}'`;
    const creds =
      secretKeys.length > 0
        ? ` It stores ${secretKeys.join(", ")} in ${path}, in plain text.`
        : "";
    const choice = await ctx.requestApproval(
      `${verb}? It will run ${spec.what} on every session in ` +
        `${spec.scope === "global" ? "every project" : "this project"}, and its tools become available to me.${creds}`,
      [replacing ? REPLACE : ADD, SKIP],
    );
    if (choice !== ADD && choice !== REPLACE) {
      return { output: `Not added. '${spec.name}' was not written to any config.`, summary: "declined" };
    }

    const written = await addServerToConfig(path, spec.parsed).catch((e: unknown) => e as Error);
    if (written instanceof Error) {
      return { output: `Error: couldn't write ${path}: ${written.message}`, isError: true, summary: "write failed" };
    }

    // Connect immediately. Writing the file and saying "restart to use it" would make
    // the whole point of the tool evaporate.
    const status = await ctx.mcp?.addServer(spec.parsed.config);
    const outcome =
      status?.state === "connected"
        ? `connected with ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} (protocol ${status.version})`
        : status
          ? `saved, but it is ${status.state}${status.error ? ` — ${status.error}` : ""}`
          : "saved (not started in this context)";

    return {
      output: `${written.replaced ? "Replaced" : "Added"} '${spec.name}' in ${path} — ${outcome}.`,
      summary: `added mcp server '${spec.name}'`,
    };
  },
};

/**
 * Turn the tool's structured arguments into the same spec `/mcp add` produces.
 *
 * Deliberately routed through `parseAddSpec` rather than building a config directly:
 * one validator means the tool cannot accept something the command would reject, or
 * write a shape the loader silently drops.
 */
function specFromArgs(args: Record<string, unknown>):
  | { ok: true; name: string; scope: AddScope; what: string; display: string; parsed: { name: string; scope: AddScope; config: import("../mcp/config.js").McpServerConfig } }
  | { ok: false; error: string } {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { ok: false, error: "`name` is required." };
  // The name is handed to the shared parser as a positional argument, so a name shaped
  // like a flag gets consumed as one. That is not an escalation (checked: every such
  // name fails), but it fails as "A command is required" when a command WAS given,
  // which sends you looking in the wrong place. Reject it where the cause is known.
  if (name.startsWith("-")) {
    return { ok: false, error: `'${name}' cannot be a server name — it starts with a dash and reads as an option.` };
  }

  const url = typeof args.url === "string" ? args.url.trim() : "";
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!url && !command) return { ok: false, error: "Give either `command` (local server) or `url` (remote server)." };
  if (url && command) return { ok: false, error: "Give `command` OR `url`, not both." };

  const argv: string[] = [];
  if (args.global === true) argv.push("--global");
  if (url) argv.push("--http");
  for (const [k, v] of Object.entries(asStrings(args.headers))) argv.push("--header", `${k}: ${v}`);
  for (const [k, v] of Object.entries(asStrings(args.env))) argv.push("--env", `${k}=${v}`);
  argv.push(name, url || command);
  // `--` so a server's own flags are never read as ours.
  const extra = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
  if (extra.length > 0) argv.push("--", ...extra);

  const parsed = parseAddSpec(argv);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const what = url ? url : [command, ...extra].join(" ");
  return {
    ok: true,
    name,
    scope: parsed.spec.scope,
    what: `\`${what}\``,
    display: `${url ? "--http " : ""}${name} ${what}`,
    parsed: parsed.spec,
  };
}

/**
 * Remove, disable or enable one configured server.
 *
 * Every one of these was reachable only through the `/mcp` screen, so "turn that server
 * off" could be said and not done. They go through the same config write and the same live
 * manager call the screen uses, so a change takes effect now rather than next launch.
 */
async function manageServer(
  action: "remove" | "disable" | "enable",
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return { output: "Error: `name` is required — which server.", isError: true, summary: "no server name" };
  const config = ctx.mcp?.configFor(name);
  if (!config) {
    return {
      output: `Error: no MCP server named '${name}' is configured here. The servers in play are the mcp__<server>__* tools you can see; /mcp lists them all.`,
      isError: true,
      summary: `no server '${name}'`,
    };
  }
  if (!ctx.requestApproval) {
    return {
      output:
        `Error: changing an MCP server needs the user's confirmation and there's no way to ask here. ` +
        `Tell them to run /mcp and ${action} '${name}' there.`,
      isError: true,
      summary: "cannot ask",
    };
  }

  const root = ctx.governance?.forbidden.root ?? ctx.cwd;
  const question =
    action === "remove"
      ? `Remove the MCP server '${name}' from the config? Its tools stop being available.`
      : action === "disable"
        ? `Disable the MCP server '${name}'? It stays configured, and its tools stop being offered.`
        : `Enable the MCP server '${name}' again? Its tools become available.`;
  const yes = action === "remove" ? "Yes, remove it" : action === "disable" ? "Yes, disable it" : "Yes, enable it";
  const choice = await ctx.requestApproval(question, [yes, SKIP]);
  if (choice !== yes) {
    return { output: `Left '${name}' as it was.`, summary: "declined" };
  }

  if (action === "remove") {
    const path = await resolveConfigPath(root, name);
    const removed = await removeServerFromConfig(path, name).catch((e: unknown) => e as Error);
    if (removed instanceof Error) {
      return { output: `Error: couldn't write ${path}: ${removed.message}`, isError: true, summary: "write failed" };
    }
    await ctx.mcp?.removeServer(name);
    return removed
      ? { output: `Removed '${name}' from ${path}. Its tools are gone from this session.`, summary: `removed '${name}'` }
      : { output: `'${name}' was not in ${path}, so nothing was written.`, isError: true, summary: `'${name}' not in config` };
  }

  const disabled = action === "disable";
  const path = await resolveConfigPath(root, name);
  const scope: AddScope = path === configPathFor("global", root) ? "global" : "project";
  const next = { ...config, disabled };
  const written = await addServerToConfig(path, { name, scope, config: next }).catch((e: unknown) => e as Error);
  if (written instanceof Error) {
    return { output: `Error: couldn't write ${path}: ${written.message}`, isError: true, summary: "write failed" };
  }
  await ctx.mcp?.addServer(next);
  return {
    output: disabled
      ? `Disabled '${name}'. It stays in ${path}; say the word and I can enable it again.`
      : `Enabled '${name}'. Its tools are available again.`,
    summary: `${disabled ? "disabled" : "enabled"} '${name}'`,
  };
}

function asStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}
