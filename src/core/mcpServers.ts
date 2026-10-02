/**
 * mcpServers.ts — managing a session's MCP servers from a UI.
 *
 * The same operations the CLI's `/mcp` box performs (see `mcpWriteAndConnect`,
 * `mcpRemove`, `mcpSetDisabled` in cli/App.tsx), without the Ink around them, so the
 * desktop app and the CLI write the same files the same way: a server lives in
 * `.mindweave/mcp.json` (this project) or `~/.mindweave/mcp.json` (every project), and
 * every change is applied to the running pool at once, never "restart to take effect".
 *
 * Views are plain data. Secrets in a server's env or headers do go back to the caller,
 * because editing a server means editing them; a UI shows them masked until asked.
 */
import type { Session } from "../memory/types.js";
import { parseEntry, type McpServerConfig } from "../mcp/config.js";
import {
  addServerToConfig,
  configPathFor,
  removeServerFromConfig,
  resolveConfigPath,
  splitArgs,
  type AddScope,
} from "../mcp/configWrite.js";
import type { ConnectionState } from "../mcp/connection.js";

export interface McpServerView {
  name: string;
  type: "stdio" | "http";
  state: ConnectionState;
  error?: string;
  toolCount: number;
  promptCount: number;
  offersResources: boolean;
  /** Tools held back because they changed since they were trusted. */
  blockedCount: number;
  scope: AddScope;
  configPath: string;
  /** What it runs or where it points, for a one-line summary. */
  target: string;
  version?: string;
  serverInfo?: { name: string; version?: string };
  /** Only an http server can be signed in to. */
  signedIn: boolean;
}

export interface McpServerDetail extends McpServerView {
  config: { command?: string; args?: string[]; url?: string; env: Record<string, string>; headers: Record<string, string> };
  tools: { name: string; description: string; readOnly: boolean; blocked: "changed" | "forbidden" | null }[];
}

/** What an add/edit form sends. `args` is one line, split the way the CLI splits it. */
export interface McpServerForm {
  name: string;
  type: "stdio" | "http";
  scope: AddScope;
  command?: string;
  args?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Set when editing: the name the server had, so a rename replaces rather than duplicates. */
  originalName?: string;
}

export type McpResult = { ok: true; view?: McpServerView } | { ok: false; error: string };

function manager(session: Session) {
  const mcp = session.toolContext.mcp;
  if (!mcp) throw new Error("This session has no MCP pool.");
  return mcp;
}

async function scopeOf(session: Session, name: string): Promise<{ scope: AddScope; path: string }> {
  const path = await resolveConfigPath(session.cwd, name);
  return { scope: path === configPathFor("global", session.cwd) ? "global" : "project", path };
}

function targetOf(config: McpServerConfig | undefined): string {
  if (!config) return "";
  return config.type === "http" ? config.url : [config.command, ...config.args].join(" ");
}

export async function listMcpServers(session: Session): Promise<McpServerView[]> {
  const mcp = manager(session);
  const signedIn = await mcp.credentialed();
  return Promise.all(
    mcp.statuses().map(async (s) => {
      const { scope, path } = await scopeOf(session, s.name);
      return {
        name: s.name,
        type: s.type,
        state: s.state,
        ...(s.error ? { error: s.error } : {}),
        toolCount: s.toolCount,
        promptCount: s.promptCount,
        offersResources: s.offersResources,
        blockedCount: mcp.blockedCountFor(s.name),
        scope,
        configPath: path,
        target: targetOf(mcp.configFor(s.name)),
        ...(s.version ? { version: s.version } : {}),
        ...(s.serverInfo ? { serverInfo: s.serverInfo } : {}),
        signedIn: signedIn.has(s.name),
      };
    }),
  );
}

export async function mcpServerDetail(session: Session, name: string): Promise<McpServerDetail | null> {
  const mcp = manager(session);
  const view = (await listMcpServers(session)).find((v) => v.name === name);
  const config = mcp.configFor(name);
  if (!view || !config) return null;
  return {
    ...view,
    config:
      config.type === "http"
        ? { url: config.url, env: {}, headers: { ...(config.headers ?? {}) } }
        : { command: config.command, args: [...config.args], env: { ...(config.env ?? {}) }, headers: {} },
    tools: mcp.toolsFor(name).map(({ def, blocked }) => ({
      name: def.name,
      description: def.description,
      readOnly: def.readOnly,
      blocked,
    })),
  };
}

/** Add a server, or replace one (`originalName`), then connect it live. */
export async function saveMcpServer(session: Session, form: McpServerForm): Promise<McpResult> {
  const mcp = manager(session);
  const name = form.name.trim();
  if (!name) return { ok: false, error: "Give the server a name." };
  const renaming = form.originalName && form.originalName !== name;
  // Checked only for a NEW name: a server already in someone's config keeps whatever
  // name it has, and editing its command must not be blocked by a rule it predates.
  if ((!form.originalName || renaming) && !/^[A-Za-z0-9._-]+$/.test(name)) {
    return { ok: false, error: "Use letters, numbers, dots, dashes or underscores in the name." };
  }
  if ((!form.originalName || renaming) && mcp.configFor(name)) return { ok: false, error: `A server called '${name}' already exists.` };

  const raw =
    form.type === "http"
      ? { type: "http", url: form.url?.trim() ?? "", headers: form.headers }
      : (() => {
          const argv = splitArgs(`${form.command ?? ""} ${form.args ?? ""}`.trim());
          return { type: "stdio", command: argv[0] ?? "", args: argv.slice(1), env: form.env };
        })();
  // Keep a disabled server disabled across an edit.
  const wasDisabled = form.originalName ? mcp.configFor(form.originalName)?.disabled === true : false;
  const config = parseEntry(name, { ...raw, ...(wasDisabled ? { disabled: true } : {}) });
  if (!config) {
    return {
      ok: false,
      error: form.type === "http" ? "Enter a full http:// or https:// address." : "Enter the command that starts the server.",
    };
  }

  try {
    if (form.originalName) {
      // Edit: take the old entry out of whichever file had it, so a scope change or a
      // rename cannot leave a second, shadowing copy behind.
      await removeServerFromConfig(configPathFor("project", session.cwd), form.originalName);
      await removeServerFromConfig(configPathFor("global", session.cwd), form.originalName);
      if (renaming) await mcp.removeServer(form.originalName);
    }
    await addServerToConfig(configPathFor(form.scope, session.cwd), { name, scope: form.scope, config });
    await mcp.addServer(config);
  } catch (e) {
    return { ok: false, error: `Couldn't save the server: ${e instanceof Error ? e.message : String(e)}` };
  }
  const view = (await listMcpServers(session)).find((v) => v.name === name);
  return { ok: true, ...(view ? { view } : {}) };
}

/** Take a server out of its config file AND stop it now. */
export async function removeMcpServer(session: Session, name: string): Promise<McpResult> {
  const mcp = manager(session);
  const gone =
    (await removeServerFromConfig(configPathFor("project", session.cwd), name)) ||
    (await removeServerFromConfig(configPathFor("global", session.cwd), name));
  const stopped = await mcp.removeServer(name);
  return gone || stopped ? { ok: true } : { ok: false, error: `No server called '${name}' is configured.` };
}

/** Turn a server off (kept in the config, never started) or back on, and apply it now. */
export async function setMcpServerDisabled(session: Session, name: string, disabled: boolean): Promise<McpResult> {
  const mcp = manager(session);
  const config = mcp.configFor(name);
  if (!config) return { ok: false, error: `No server called '${name}' is configured.` };
  const { scope, path } = await scopeOf(session, name);
  const next = { ...config, disabled };
  try {
    await addServerToConfig(path, { name, scope, config: next });
    await mcp.addServer(next);
  } catch (e) {
    return { ok: false, error: `Couldn't update ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}

export async function reconnectMcpServer(session: Session, name: string): Promise<McpResult> {
  const status = await manager(session).reconnect(name);
  return status ? { ok: true } : { ok: false, error: `No server called '${name}' is configured.` };
}

/** Sign in through the browser. `onUrl` receives the address to open (and to show, in
 *  case no browser comes up). Throws the server's own sentence on failure. */
export async function signInMcpServer(session: Session, name: string, onUrl: (url: string) => void): Promise<McpResult> {
  try {
    const status = await manager(session).authenticate(name, { onUrl });
    if (!status) return { ok: false, error: `${name} is no longer configured.` };
    if (status.state === "connected") return { ok: true };
    return { ok: false, error: status.error ? `${name} is ${status.state}: ${status.error}` : `${name} is ${status.state}.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function signOutMcpServer(session: Session, name: string): Promise<McpResult> {
  const status = await manager(session).signOut(name);
  return status ? { ok: true } : { ok: false, error: `No server called '${name}' is configured.` };
}

/** Allow every tool that is blocked for having changed since it was trusted. */
export async function allowChangedMcpTools(session: Session): Promise<McpResult> {
  await manager(session).allowChanged();
  return { ok: true };
}

/** Be told when any server changes state (connects, fails, tools change). */
export function onMcpChange(session: Session, handler: (() => void) | null): void {
  session.toolContext.mcp?.setOnChange(handler);
}
