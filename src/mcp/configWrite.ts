/**
 * configWrite.ts — adding and removing MCP servers without hand-editing JSON.
 *
 * Every comparable tool ships an add path rather than making people hand-write the
 * config, and for good reason: the config spawns processes and
 * carries credentials, so a typo is a server that silently fails to start. Making people
 * hand-write it is how you get a bad first five minutes.
 *
 * Two callers share everything here — the `/mcp add` command and the `mcp_server`
 * tool the model can use when you just say what you want. One writer, so the two can
 * never disagree about what a valid config looks like.
 *
 * The parse is PURE and returns errors as values rather than throwing, because both
 * callers need to show the user what was wrong with what they typed.
 */
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { globalConfigPath, parseEntry, projectConfigPath, type McpServerConfig } from "./config.js";

/** Where an added server is written. Project by default: a server is usually a fact
 *  about THIS codebase, and a global one silently follows you into unrelated work. */
export type AddScope = "project" | "global";

export function configPathFor(scope: AddScope, cwd: string): string {
  return scope === "global" ? globalConfigPath() : projectConfigPath(cwd);
}

export interface AddSpec {
  name: string;
  scope: AddScope;
  config: McpServerConfig;
}

export type ParseResult = { ok: true; spec: AddSpec } | { ok: false; error: string };

const USAGE =
  "Usage: /mcp add <name> <command> [args...]   or   /mcp add --http <name> <url>\n" +
  "  --global            save for every project instead of just this one\n" +
  "  --env KEY=VALUE     pass an environment variable (repeatable)\n" +
  "  --header 'K: V'     send a header (--http only, repeatable)\n" +
  "  --                  everything after this goes to the server, not to Mindweave\n" +
  "Example: /mcp add github npx -y @modelcontextprotocol/server-github --env GITHUB_TOKEN=ghp_x";

/**
 * Split a typed command line into arguments, respecting quotes (pure).
 *
 * Needed because the two things most likely to be quoted here are the two that break
 * badly when split naively: a header (`--header 'Authorization: Bearer x'`) and a path
 * with spaces. Not a shell — no expansion, no escapes beyond the quote pairs — because
 * anything cleverer would be a surprise in a config-writing command.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true; // so `--env ""` survives as an empty argument
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
  }
  if (current || started) out.push(current);
  return out;
}

/**
 * Parse `/mcp add` arguments into a server config (pure).
 *
 * The `--` separator is the important detail and the reason this is not a one-liner: an
 * MCP server has its own flags, and `--verbose` meant for the server would otherwise be
 * eaten as one of ours. Everything after `--` is handed over untouched.
 */
export function parseAddSpec(argv: readonly string[]): ParseResult {
  const rest: string[] = [];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let scope: AddScope = "project";
  let http = false;
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (passthrough) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--global" || arg === "-g") {
      scope = "global";
      continue;
    }
    if (arg === "--http") {
      http = true;
      continue;
    }
    if (arg === "--env" || arg === "-e") {
      const pair = argv[++i];
      if (!pair) return bad("`--env` needs a KEY=VALUE.");
      const eq = pair.indexOf("=");
      // Split on the FIRST `=` only: a token or a connection string can contain more.
      if (eq <= 0) return bad(`'${pair}' is not KEY=VALUE.`);
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
      continue;
    }
    if (arg === "--header" || arg === "-H") {
      const pair = argv[++i];
      if (!pair) return bad("`--header` needs a 'Name: value'.");
      const colon = pair.indexOf(":");
      if (colon <= 0) return bad(`'${pair}' is not a 'Name: value' header.`);
      headers[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
      continue;
    }
    if (arg.startsWith("-") && rest.length === 0) return bad(`Unknown option '${arg}'.\n\n${USAGE}`);
    rest.push(arg);
  }

  const name = (rest.shift() ?? "").trim();
  if (!name) return bad(`A server name is required.\n\n${USAGE}`);
  // The name becomes part of every tool name (`mcp__<name>__<tool>`), so a name that
  // normalizes to nothing would produce unusable tools.
  if (!/[a-zA-Z0-9]/.test(name)) return bad(`'${name}' has no usable characters for a server name.`);

  const head = rest.shift();
  if (!head) return bad(`${http ? "A URL" : "A command"} is required.\n\n${USAGE}`);

  if (http) {
    if (!/^https?:\/\//i.test(head)) return bad(`'${head}' is not an http(s) URL.`);
    if (rest.length > 0) return bad("An --http server takes a URL and no arguments.");
    return okSpec({
      name,
      scope,
      config: { type: "http", name, url: head, ...(Object.keys(headers).length ? { headers } : {}) },
    });
  }

  if (Object.keys(headers).length > 0) return bad("`--header` only applies to `--http` servers.");
  return okSpec({
    name,
    scope,
    config: { type: "stdio", name, command: head, args: rest, ...(Object.keys(env).length ? { env } : {}) },
  });
}

function bad(error: string): ParseResult {
  return { ok: false, error };
}

function okSpec(spec: AddSpec): ParseResult {
  // Round-trip through the reader so anything we write is guaranteed to parse back.
  // Two code paths describing "a valid server" is exactly how a writer starts emitting
  // configs the loader quietly drops.
  const echoed = parseEntry(spec.name, serialize(spec.config));
  if (!echoed) return bad("That produced a config Mindweave would not accept. Check the command or URL.");
  return { ok: true, spec };
}

/**
 * The on-disk shape for one server (the inverse of `parseEntry`).
 *
 * `disabled` was missing from both branches until now — the field exists on
 * `McpServerConfig` and `parseEntry` reads it back, but nothing ever WROTE it, so a
 * server disabled through the manager came back enabled on the next launch. Persisting
 * it is what lets Disable survive a restart rather than being a this-session-only toggle.
 */
export function serialize(config: McpServerConfig): Record<string, unknown> {
  if (config.type === "http") {
    return {
      type: "http",
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
      // Carried through rather than dropped: this block is hand-written by someone whose
      // server cannot be signed in to automatically, and losing it on the next edit would
      // silently put them back to a flow that does not work for them. Same gap `disabled`
      // used to have, where the manager wrote a config the loader could not reproduce.
      ...(config.oauth ? { oauth: config.oauth } : {}),
      ...(config.disabled ? { disabled: true } : {}),
    };
  }
  return {
    command: config.command,
    ...(config.args.length ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.disabled ? { disabled: true } : {}),
  };
}

export interface WriteOutcome {
  path: string;
  replaced: boolean;
}

/**
 * Is a server of this name already configured at `path`?
 *
 * Exists so a caller can say what the write will actually DO before asking the user to
 * approve it. `addServerToConfig` already reports `replaced`, but only afterwards, and
 * "add this server?" answered yes should not quietly overwrite a working integration
 * the user had already set up.
 */
export async function serverExistsInConfig(path: string, name: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const root = parsed as Record<string, unknown>;
    const key = root.servers && !root.mcpServers ? "servers" : "mcpServers";
    const servers = root[key];
    if (!servers || typeof servers !== "object") return false;
    return Object.prototype.hasOwnProperty.call(servers, name);
  } catch {
    return false; // no file, or unreadable — nothing to replace
  }
}

/**
 * Which config file a server actually lives in — project or global — so an edit lands on
 * the file that already defines it instead of guessing.
 *
 * Checked project-first, same order `/mcp remove` already searches in: a project-scoped
 * server shadows a global one of the same name, so if both happen to define it, the
 * project's is the one actually running and the one an edit should change. Falls back to
 * `project` when the server is not on disk at either path — the case for one added through
 * a route that never persisted, where there is nothing to prefer and project is the
 * ordinary default (see `AddScope`).
 */
export async function resolveConfigPath(cwd: string, name: string): Promise<string> {
  const projectPath = configPathFor("project", cwd);
  if (await serverExistsInConfig(projectPath, name)) return projectPath;
  const globalPath = configPathFor("global", cwd);
  if (await serverExistsInConfig(globalPath, name)) return globalPath;
  return projectPath;
}

/**
 * Write a server into an mcp.json, preserving everything already there.
 *
 * Read-modify-write rather than overwrite: this file is hand-editable and may hold
 * servers, comments-as-keys, and formatting the user cares about. Clobbering it to add
 * one entry would be the worst possible first impression of the feature.
 */
export async function addServerToConfig(path: string, spec: AddSpec): Promise<WriteOutcome> {
  let root: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
  } catch {
    // No file, or one we cannot parse. Starting fresh is right for the first case; for
    // the second, refusing would leave the user stuck behind a file they may not know
    // is broken — and we only ever add, so nothing valid is lost.
  }
  // Respect whichever key the file already uses; default to the ecosystem's `mcpServers`.
  const key = root.servers && !root.mcpServers ? "servers" : "mcpServers";
  const existing = root[key];
  const servers: Record<string, unknown> = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};

  const replaced = Object.prototype.hasOwnProperty.call(servers, spec.name);
  servers[spec.name] = serialize(spec.config);
  root[key] = servers;

  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(root, null, 2) + "\n", "utf8");
  return { path, replaced };
}

/** Remove a server by name. `false` when it was not there. */
export async function removeServerFromConfig(path: string, name: string): Promise<boolean> {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!root || typeof root !== "object") return false;
  const key = root.servers && !root.mcpServers ? "servers" : "mcpServers";
  const servers = root[key];
  if (!servers || typeof servers !== "object") return false;
  const copy = { ...(servers as Record<string, unknown>) };
  if (!Object.prototype.hasOwnProperty.call(copy, name)) return false;
  delete copy[name];
  root[key] = copy;
  await fs.writeFile(path, JSON.stringify(root, null, 2) + "\n", "utf8");
  return true;
}

export { USAGE as ADD_USAGE };
