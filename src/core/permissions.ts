/**
 * permissions.ts — everything the user decides about what the agent may do, in one
 * place a settings screen can read and change.
 *
 * Four standing lists, each kept per project or for every project (the universal layer
 * in `~/.mindweave`, merged under the project's by governor/index.ts):
 *   - protected files (`forbidden.md`), which the agent may never change;
 *   - blocked commands (`forbidden-commands.md`), which it may never run;
 *   - blocked MCP tools (`forbidden-mcp-tools.md`), never offered to it;
 *   - Sentinel allowances (`sentinel-allow.md`), actions Sentinel mode will not ask about.
 *   - command rules (`command-rules.md`): `allow npm test`, `prompt git push`, `forbid rm -rf :: why`.
 * Plus the mode new chats start in, and the allowances given during THIS session, which
 * can be taken back.
 *
 * Every change is written to its file and then applied to the live session at once
 * (`refreshGovernance`), so the next tool call already obeys it.
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { Session } from "../memory/types.js";
import { governanceDir, loadPermissionLists, type GovernanceScope } from "../governor/index.js";
import {
  appendForbidden,
  appendForbiddenCommand,
  appendForbiddenMcpTool,
  appendSentinelAllow,
  removeForbiddenPath,
  removeForbiddenCommand,
  removeForbiddenMcpTool,
  removeSentinelAllow,
  appendCommandRule,
  readCommandRuleLines,
  removeCommandRule,
} from "../governor/write.js";
import { parseCommandRules } from "../tools/commandPolicy.js";
import { hooksOverview } from "../dynamo/hooks.js";
import { refreshGovernance } from "../dynamo/engine.js";
import { TOOLS } from "../tools/registry.js";
import { isMcpToolName, mcpToolName, parseMcpToolName } from "../mcp/catalog.js";
import { MODES, type ModeId } from "../cli/modes.js";

export type PermissionKind = "path" | "command" | "mcpTool" | "sentinel" | "commandRule";
export type PermissionScope = GovernanceScope;

/** The built-in actions Sentinel asks about, in words. Two are left out on purpose:
 *  changing the rules themselves (`governor`) and adding MCP servers (`mcp_server`)
 *  should always be asked about, whatever else is allowed. */
const ACTION_LABELS: Record<string, string> = {
  edit: "Edit files",
  write_file: "Create or overwrite files",
  replace_symbol_body: "Rewrite a function or class",
  run_command: "Run shell commands",
  kill_shell: "Stop background commands",
  spawn_subagent: "Start sub-agents",
  todo_write: "Update its task list",
  workspace: "Add folders to the workspace",
  save_memory: "Save notes to memory",
  skill: "Save skills",
};
const NEVER_PRE_ALLOWED = new Set(["governor", "mcp_server"]);

export interface PermissionItem {
  value: string;
  scope: PermissionScope;
  /** A readable name, for tool names. */
  label?: string;
}

export interface PermissionsView {
  /** The project these lists are for; `current` when it is the one open in the chat. */
  project: { name: string; cwd: string; current: boolean };
  defaultMode: { project: ModeId | null; global: ModeId | null };
  modes: { id: ModeId; name: string; descriptor: string }[];
  lists: Record<PermissionKind, PermissionItem[]>;
  /** Given during this session only; each can be taken back. */
  session: {
    sentinel: { value: string; label: string }[];
    lifted: string[];
    outsideDirs: string[];
  };
  /** The user's own hooks (read only here: they are edited in the file, never by the agent). */
  hooks: Awaited<ReturnType<typeof hooksOverview>>;
  /** What the pickers offer. */
  choices: {
    sentinel: { value: string; label: string }[];
    mcpTools: { value: string; label: string }[];
  };
}

export type PermissionResult = { ok: true } | { ok: false; error: string };

function toolLabel(name: string): string {
  if (ACTION_LABELS[name]) return ACTION_LABELS[name]!;
  const mcp = parseMcpToolName(name);
  return mcp ? `${mcp.tool} (${mcp.server})` : name;
}

// ── default mode ──

const MODE_FILE = "mode.json";

async function readModeFile(dir: string): Promise<ModeId | null> {
  try {
    const raw = JSON.parse(await fs.readFile(join(dir, MODE_FILE), "utf8")) as { defaultMode?: unknown };
    return MODES.some((m) => m.enabled && m.id === raw.defaultMode) ? (raw.defaultMode as ModeId) : null;
  } catch {
    return null;
  }
}

/** The mode new chats in this project start in: the project's choice, else the
 *  universal one, else null (the app's own default). */
export async function defaultModeFor(cwd: string): Promise<ModeId | null> {
  return (await readModeFile(governanceDir(cwd, "project"))) ?? (await readModeFile(governanceDir(cwd, "global")));
}

export async function setDefaultMode(
  session: Session,
  scope: PermissionScope,
  mode: ModeId | null,
  cwd: string = session.cwd,
): Promise<PermissionResult> {
  const dir = governanceDir(cwd, scope);
  const file = join(dir, MODE_FILE);
  if (mode === null) {
    await fs.rm(file, { force: true });
    return { ok: true };
  }
  if (!MODES.some((m) => m.enabled && m.id === mode)) return { ok: false, error: `Unknown mode: ${mode}` };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ defaultMode: mode }, null, 2), "utf8");
  return { ok: true };
}

// ── the view ──

/**
 * Everything the Permissions screen shows, for `cwd` (the open project by default, or
 * any other project the user picks). This chat's temporary allowances are only
 * reported for the project that is actually open.
 */
export async function permissionsView(session: Session, cwd: string = session.cwd): Promise<PermissionsView> {
  const current = sameProject(cwd, session.cwd);
  const [global, project] = await Promise.all([
    loadPermissionLists(cwd, "global"),
    loadPermissionLists(cwd, "project"),
  ]);
  const both = (key: "paths" | "commands" | "mcpTools" | "sentinelAllow", withLabel = false): PermissionItem[] => [
    ...project[key].map((value) => ({ value, scope: "project" as const, ...(withLabel ? { label: toolLabel(value) } : {}) })),
    ...global[key].map((value) => ({ value, scope: "global" as const, ...(withLabel ? { label: toolLabel(value) } : {}) })),
  ];
  const [ruleLinesProject, ruleLinesGlobal] = await Promise.all([
    readCommandRuleLines(cwd, "project"),
    readCommandRuleLines(cwd, "global"),
  ]);
  const ctx = session.toolContext;
  const mcpDefs = ctx.mcp?.snapshot().catalog ?? [];
  return {
    project: { name: basename(cwd), cwd, current },
    defaultMode: {
      project: await readModeFile(governanceDir(cwd, "project")),
      global: await readModeFile(governanceDir(cwd, "global")),
    },
    modes: MODES.filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.name, descriptor: m.descriptor })),
    lists: {
      path: both("paths"),
      command: both("commands"),
      mcpTool: both("mcpTools", true),
      sentinel: both("sentinelAllow", true),
      commandRule: [
        ...ruleLinesProject.map((value) => ({ value, scope: "project" as const })),
        ...ruleLinesGlobal.map((value) => ({ value, scope: "global" as const })),
      ],
    },
    session: current
      ? {
          sentinel: [...(ctx.guardAllowed ?? [])].map((value) => ({ value, label: toolLabel(value) })),
          lifted: [...(session.governance.lifted ?? [])],
          outsideDirs: [...(ctx.allowedOutsideDirs ?? [])],
        }
      : { sentinel: [], lifted: [], outsideDirs: [] },
    hooks: await hooksOverview(cwd),
    choices: {
      sentinel: [
        ...TOOLS.filter((t) => !t.readOnly && !NEVER_PRE_ALLOWED.has(t.name)).map((t) => ({ value: t.name, label: toolLabel(t.name) })),
        ...mcpDefs.filter((d) => !d.readOnly).map((d) => ({ value: mcpToolName(d.server, d.name), label: toolLabel(mcpToolName(d.server, d.name)) })),
      ],
      mcpTools: mcpDefs.map((d) => ({ value: mcpToolName(d.server, d.name), label: toolLabel(mcpToolName(d.server, d.name)) })),
    },
  };
}

// ── changing the lists ──

/** Clean a value the way its list stores it, or say why it can't be used. */
function normalize(kind: PermissionKind, raw: string): { value: string } | { error: string } {
  const value = raw.trim();
  if (!value) return { error: "Type something first." };
  if (kind === "path") {
    const path = value.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
    if (/^[a-zA-Z]:\//.test(path) || path.startsWith("../") || path === "..") {
      return { error: "Use a path inside the project, like src/legacy or *.pem, not a full path." };
    }
    return path ? { value: path } : { error: "That path points at the whole project." };
  }
  if (kind === "mcpTool" && !isMcpToolName(value)) {
    return { error: "Pick a tool from the list: MCP tools are named mcp__server__tool." };
  }
  if (kind === "commandRule") {
    const rules = parseCommandRules(value);
    if (rules.length !== 1) {
      return { error: "Write it as: allow npm test, prompt git push, or forbid rm -rf :: why." };
    }
    const r = rules[0]!;
    return { value: `${r.decision} ${r.words.join(" ")}${r.justification ? ` :: ${r.justification}` : ""}` };
  }
  if (kind === "sentinel" && NEVER_PRE_ALLOWED.has(value)) {
    return { error: "Changing permissions and adding MCP servers are always asked about." };
  }
  return { value };
}

/** Paths compared the way Windows and macOS treat them: case and slashes don't matter. */
function sameProject(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

async function write(cwd: string, kind: PermissionKind, value: string, scope: PermissionScope): Promise<boolean> {
  switch (kind) {
    case "path": return (await appendForbidden(cwd, value, scope)).added;
    case "command": return (await appendForbiddenCommand(cwd, value, scope)).added;
    case "mcpTool": return (await appendForbiddenMcpTool(cwd, value, scope)).added;
    case "sentinel": return (await appendSentinelAllow(cwd, value, scope)).added;
    case "commandRule": {
      const r = parseCommandRules(value)[0]!;
      return (await appendCommandRule(cwd, r.decision, r.words.join(" "), scope, r.justification ?? "")).added;
    }
  }
}

async function erase(cwd: string, kind: PermissionKind, value: string, scope: PermissionScope): Promise<boolean> {
  switch (kind) {
    case "path": return removeForbiddenPath(cwd, value, scope);
    case "command": return removeForbiddenCommand(cwd, value, scope);
    case "mcpTool": return removeForbiddenMcpTool(cwd, value, scope);
    case "sentinel": return removeSentinelAllow(cwd, value, scope);
    case "commandRule": return removeCommandRule(cwd, value, scope);
  }
}

// Each writer takes an optional `cwd` for editing a project other than the open one.
// The open chat is refreshed either way: a universal change reaches it too.

export async function addPermission(
  session: Session,
  kind: PermissionKind,
  raw: string,
  scope: PermissionScope,
  cwd: string = session.cwd,
): Promise<PermissionResult> {
  const n = normalize(kind, raw);
  if ("error" in n) return { ok: false, error: n.error };
  const added = await write(cwd, kind, n.value, scope);
  if (!added) return { ok: false, error: `That is already on the ${scope === "global" ? "all-projects" : "project"} list.` };
  await refreshGovernance(session, true);
  return { ok: true };
}

export async function removePermission(
  session: Session,
  kind: PermissionKind,
  value: string,
  scope: PermissionScope,
  cwd: string = session.cwd,
): Promise<PermissionResult> {
  const removed = await erase(cwd, kind, value, scope);
  if (!removed) return { ok: false, error: "That entry is no longer on the list." };
  await refreshGovernance(session, true);
  return { ok: true };
}

/** Move an entry between this project and all projects. */
export async function movePermission(
  session: Session,
  kind: PermissionKind,
  value: string,
  from: PermissionScope,
  cwd: string = session.cwd,
): Promise<PermissionResult> {
  const to: PermissionScope = from === "project" ? "global" : "project";
  await write(cwd, kind, value, to); // already there is fine: the move still ends in one place
  await erase(cwd, kind, value, from);
  await refreshGovernance(session, true);
  return { ok: true };
}

/** Take back something allowed during this session. */
export async function revokeSessionGrant(session: Session, kind: "sentinel" | "lifted" | "outside", value: string): Promise<PermissionResult> {
  const ctx = session.toolContext;
  if (kind === "sentinel") {
    ctx.guardAllowed?.delete(value);
  } else if (kind === "outside") {
    ctx.allowedOutsideDirs?.delete(value);
  } else {
    // A lifted pattern returns by dropping it from `lifted` and re-reading from disk,
    // which is where the rule was left in place on purpose.
    session.governance.lifted = (session.governance.lifted ?? []).filter((p) => p !== value);
    await refreshGovernance(session, true);
  }
  return { ok: true };
}
