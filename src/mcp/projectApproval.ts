/**
 * projectApproval.ts — a project's own MCP servers start only once the user agrees.
 *
 * A server is a program. The user's global config (~/.mindweave/mcp.json) is theirs, and
 * its servers start as they always have. A project's config (<project>/.mindweave/mcp.json)
 * arrives with the project: clone a repository, unzip a download, open a folder someone
 * sent, and its servers used to start the moment the session opened, with the user's full
 * privileges and before anything was asked. A project file could also define a server
 * under the name of one the user set up, and the project's definition replaced theirs.
 *
 * Now:
 *   - a project server starts only if the user approved exactly this definition, kept
 *     in the user's state folder (never in the repository) and keyed by a hash of the
 *     whole definition and the folder, so a changed command asks again;
 *   - an unapproved one is held until a turn starts and someone can be asked, with the
 *     exact command shown, and with nobody to ask it does not start;
 *   - a project definition that reuses the name of one of the user's servers is held the
 *     same way, the question says which server it would replace, and until it is
 *     approved the user's own definition is the one that runs.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { globalConfigPath, parseMcpConfig, projectConfigPath, type McpServerConfig } from "./config.js";
import { projectDir } from "../memory/store.js";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import type { ToolContext } from "../tools/types.js";

/** A project server waiting for the user's answer. */
export interface PendingServer {
  config: McpServerConfig;
  /** The user's own server of the same name, which this definition would replace. */
  replaces?: McpServerConfig;
  key: string;
}

export interface McpPlan {
  /** Start these now: the user's own servers, and project servers already approved. */
  ready: McpServerConfig[];
  /** Ask about these before starting them. */
  pending: PendingServer[];
}

export const APPROVAL_OPTIONS = ["Allow once", "Always for this project", "No"] as const;

/** The approval key for one project server: the whole definition, and the folder it is for. */
export function serverKey(config: McpServerConfig, cwd: string): string {
  const sorted = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]))
      : Array.isArray(v)
        ? v.map(sorted)
        : v;
  return createHash("sha256").update(JSON.stringify(sorted({ cwd, config }))).digest("hex");
}

function approvalsPath(cwd: string): string {
  return join(projectDir(cwd), "mcp-approved.json");
}

async function readJsonList(path: string): Promise<string[]> {
  try {
    const v = JSON.parse(await fs.readFile(path, "utf8"));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function readServers(path: string): Promise<McpServerConfig[]> {
  try {
    return parseMcpConfig(await fs.readFile(path, "utf8"));
  } catch {
    return [];
  }
}

/** Split the servers for `cwd` into those that may start now and those to ask about. */
export async function planMcpServers(cwd: string): Promise<McpPlan> {
  const [global, project, approved] = await Promise.all([
    readServers(globalConfigPath()),
    readServers(projectConfigPath(cwd)),
    readJsonList(approvalsPath(cwd)).then((l) => new Set(l)),
  ]);
  const byName = new Map(global.map((s) => [s.name, s]));
  const pending: PendingServer[] = [];
  for (const config of project) {
    const own = byName.get(config.name);
    // The same definition the user already runs globally is not new to them.
    if (own && JSON.stringify(own) === JSON.stringify(config)) continue;
    const key = serverKey(config, cwd);
    if (approved.has(key)) byName.set(config.name, config);
    else pending.push({ config, key, ...(own ? { replaces: own } : {}) });
  }
  return { ready: [...byName.values()], pending };
}

/** Remember that the user approved this definition for this project, for good. */
export async function rememberApproval(cwd: string, key: string): Promise<void> {
  const path = approvalsPath(cwd);
  const list = await readJsonList(path);
  if (list.includes(key)) return;
  await fs.mkdir(projectDir(cwd), { recursive: true });
  await writeFileAtomic(path, JSON.stringify([...list, key]));
}

/** The command line or address a server would run, as the user is shown it. */
export function describeServer(config: McpServerConfig): string {
  if (config.type === "http") return `connect to ${config.url}`;
  const env = Object.keys(config.env ?? {});
  return `run: ${[config.command, ...config.args].join(" ")}${env.length ? `\nwith environment variables: ${env.join(", ")}` : ""}`;
}

/**
 * Ask about each held project server and start the ones the user allows. Called when a
 * turn starts, which is the first moment a front end is guaranteed to be listening.
 * With nobody to ask, nothing is started and the servers stay held.
 */
export async function askPendingServers(ctx: ToolContext, cwd: string): Promise<void> {
  const pending = ctx.mcpPending;
  if (!pending || pending.length === 0 || !ctx.requestApproval || !ctx.mcp) return;
  ctx.mcpPending = [];
  for (const p of pending) {
    const replaces = p.replaces
      ? `\nIt has the same name as your own server '${p.replaces.name}' (${describeServer(p.replaces)}) and would replace it.`
      : "";
    const choice = await ctx.requestApproval(
      `This project's .mindweave/mcp.json wants to start the MCP server '${p.config.name}'. Allow it?`,
      [...APPROVAL_OPTIONS],
      `${describeServer(p.config)}${replaces}`,
      "Project MCP server",
    );
    if (choice === APPROVAL_OPTIONS[2] || !APPROVAL_OPTIONS.includes(choice as (typeof APPROVAL_OPTIONS)[number])) continue;
    if (choice === APPROVAL_OPTIONS[1]) await rememberApproval(cwd, p.key).catch(() => {});
    await ctx.mcp.addServer(p.config).catch(() => {});
  }
}
