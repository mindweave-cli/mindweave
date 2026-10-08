/**
 * config.ts — which MCP servers to connect to.
 *
 * Servers are declared in `mcp.json`, global (`~/.mindweave/mcp.json`) and/or
 * per-project (`<cwd>/.mindweave/mcp.json`), with the project file overriding by name.
 * Two transports are configurable: a local `stdio` command, or a remote `http` URL.
 *
 * The parse is PURE and defensive throughout: a malformed file, a bad entry, an entry
 * of an unknown type — all dropped, never thrown. A broken config degrades to "no MCP"
 * rather than taking the session with it, because the alternative is a user who cannot
 * start the agent at all until they fix a JSON file.
 *
 * Shape, matching what the ecosystem already writes so an existing config just works:
 *
 *   {
 *     "mcpServers": {
 *       "fs":     { "command": "npx", "args": ["-y", "@x/server-fs"], "env": {...} },
 *       "remote": { "type": "http", "url": "https://…", "headers": {...} },
 *       "off":    { "command": "…", "disabled": true }
 *     }
 *   }
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpStdioConfig {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

/**
 * Overrides for servers that cannot be signed in to automatically.
 *
 * Every field here exists because ONE of the assumptions the automatic flow makes is
 * false for some real server, and each is inert until set — a server that supports
 * dynamic registration and publishes its metadata needs none of this and should carry
 * none of it.
 *
 * NOTE WHAT IS ABSENT: a client SECRET. This block is written to `mcp.json`, and a
 * project-scoped `mcp.json` is a file people commit. A secret belongs in the environment
 * (see `clientSecretFor`), never in a file whose whole purpose is being shared.
 */
export interface McpOAuthConfig {
  /**
   * A client id issued by hand, for an authorization server that does not offer dynamic
   * registration. Setting it skips registration entirely.
   */
  clientId?: string;
  /**
   * A fixed port for the redirect to come back on.
   *
   * Needed precisely WHEN `clientId` is: a hand-registered client has an exact redirect
   * URI recorded against it, and the random port the automatic flow picks would not match
   * it. Ignored otherwise, because a fixed port is a port something else can be sitting on.
   */
  callbackPort?: number;
  /**
   * The authorization server's metadata document, when the server publishes none of the
   * discovery documents and there is nothing to find it by. https only: this URL decides
   * where credentials are sent, so plain http would be an invitation.
   */
  authServerMetadataUrl?: string;
}

export interface McpHttpConfig {
  type: "http";
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** Only present for a server that needs the automatic flow overridden. */
  oauth?: McpOAuthConfig;
  disabled?: boolean;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/**
 * Read the optional `oauth` block, dropping anything unusable rather than failing the
 * server (pure).
 *
 * A bad override should cost the override, not the connection: every field here has a
 * working default, so falling back to the automatic behaviour is strictly better than
 * refusing to load a server because someone typed a port as a string.
 *
 * `authServerMetadataUrl` is the exception that gets a hard rule rather than a lenient
 * one: it decides where an authorization request is SENT, so an http:// value is dropped
 * outright instead of being used.
 */
export function parseOAuthConfig(raw: unknown): McpOAuthConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: McpOAuthConfig = {};
  if (typeof o.clientId === "string" && o.clientId.trim()) out.clientId = o.clientId.trim();
  if (typeof o.callbackPort === "number" && Number.isInteger(o.callbackPort) && o.callbackPort > 0 && o.callbackPort < 65536) {
    out.callbackPort = o.callbackPort;
  }
  if (typeof o.authServerMetadataUrl === "string" && /^https:\/\//i.test(o.authServerMetadataUrl.trim())) {
    out.authServerMetadataUrl = o.authServerMetadataUrl.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A hand-registered client's secret, from the environment.
 *
 * Per server first (`MINDWEAVE_MCP_CLIENT_SECRET_LINEAR` for a server named `linear`),
 * then a bare `MINDWEAVE_MCP_CLIENT_SECRET` for the common case of exactly one such
 * server. The environment rather than `mcp.json` because that file gets committed, and a
 * client secret in a repository is a client secret that has been published.
 *
 * Most servers need none of this: a client registered dynamically is public and has no
 * secret to hold.
 */
export function clientSecretFor(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const suffix = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return env[`MINDWEAVE_MCP_CLIENT_SECRET_${suffix}`]?.trim() || env.MINDWEAVE_MCP_CLIENT_SECRET?.trim() || undefined;
}

/** Where a project's MCP config lives. */
export function projectConfigPath(cwd: string): string {
  return join(cwd, ".mindweave", "mcp.json");
}

/**
 * Where the user-wide MCP config lives.
 *
 * `MINDWEAVE_STATE_DIR` is the same override `memory/store.ts` reads for the rest of
 * `~/.mindweave` — read here for the reason its own comment records: a test that writes
 * a "global" config with nothing sandboxing the word landed in this machine's REAL
 * `~/.mindweave/mcp.json`, not a fixture. That is a config file that spawns processes
 * and can carry credentials; a test writing test data into someone's real one is not a
 * theoretical risk. Read on every call, not cached, so a test can point it somewhere
 * disposable before touching anything — a real session never sets this and is unaffected.
 */
export function globalConfigPath(): string {
  const override = process.env.MINDWEAVE_STATE_DIR?.trim();
  return override ? join(override, "mcp.json") : join(homedir(), ".mindweave", "mcp.json");
}

/**
 * Pure parse of an mcp.json body into validated configs.
 *
 * `mcpServers` is the key the ecosystem settled on; `servers` is accepted too because
 * both appear in the wild and rejecting one would look like the file being ignored.
 */
export function parseMcpConfig(raw: string): McpServerConfig[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const root = data as { mcpServers?: unknown; servers?: unknown } | null;
  const servers = root?.mcpServers ?? root?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];

  const out: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const parsed = parseEntry(name.trim(), value);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** One entry → a config, or null if it cannot be used. */
export function parseEntry(name: string, value: unknown): McpServerConfig | null {
  if (!name) return null;
  const s = value as { type?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; oauth?: unknown; disabled?: unknown } | null;
  if (!s || typeof s !== "object") return null;
  const disabled = s.disabled === true;

  // An explicit type wins; otherwise infer from which field is present, which is how
  // every config in the wild is actually written.
  const declared = typeof s.type === "string" ? s.type.toLowerCase() : "";
  const isHttp = declared === "http" || declared === "streamable-http" || (!declared && typeof s.url === "string");

  if (isHttp) {
    const url = typeof s.url === "string" ? s.url.trim() : "";
    // Only http(s). A `file://` or arbitrary scheme here would be a way to point the
    // client at something that is not an MCP endpoint at all.
    if (!/^https?:\/\//i.test(url)) return null;
    const headers = sanitizeStrings(s.headers);
    const oauth = parseOAuthConfig(s.oauth);
    return { type: "http", name, url, ...(headers ? { headers } : {}), ...(oauth ? { oauth } : {}), ...(disabled ? { disabled } : {}) };
  }

  // Anything else is a local command. `sse` and `ws` are deliberately unsupported:
  // HTTP+SSE was deprecated in 2025-03-26 and its sunset has passed.
  if (declared && declared !== "stdio") return null;
  const command = typeof s.command === "string" ? s.command.trim() : "";
  if (!command) return null;
  const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
  const env = sanitizeStrings(s.env);
  return { type: "stdio", name, command, args, ...(env ? { env } : {}), ...(disabled ? { disabled } : {}) };
}

function sanitizeStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}
