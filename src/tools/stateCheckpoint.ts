/**
 * stateCheckpoint.ts — what the agent saves about itself goes into the undo net too.
 *
 * Memories, rules, skills, protected paths and MCP servers are all files, but the tools
 * that write them (save_memory, governor, skill, mcp_server) write through their own
 * helpers rather than the edit tools, so none of it was checkpointed: `/undo` and a
 * rewind put the project back and left behind a rule, a memory or a server added by the
 * very turns being taken back.
 *
 * So those tools are wrapped rather than rewritten: the files they could touch are read
 * before the call and again after, and whatever changed is handed to the checkpoints
 * exactly as an edit would be. From there the existing machinery does the rest,
 * including leaving alone anything the user has changed since.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { projectDir, stateRoot } from "../memory/store.js";
import { memoryDir, MEMORY_INDEX } from "../memory/autoMemory.js";
import { globalConfigPath, projectConfigPath } from "../mcp/config.js";

/** The tools that write the agent's own state. */
const STATE_TOOLS = new Set(["save_memory", "governor", "skill", "mcp_server"]);

/** The permission lists of one scope, by file name. */
const PERMISSION_FILES = ["forbidden.md", "forbidden-commands.md", "forbidden-mcp-tools.md", "sentinel-allow.md"];

/** Whether a tool writes agent state that needs snapshotting around it. */
export function writesAgentState(toolName: string): boolean {
  return STATE_TOOLS.has(toolName);
}

/** The project root the governance tools write under (see governorTools' projectRoot). */
function rootOf(ctx: ToolContext): string {
  return ctx.governance?.forbidden.root ?? ctx.cwd;
}

async function filesUnder(dir: string, depth: number): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isFile()) out.push(path);
    else if (e.isDirectory() && depth > 0) out.push(...(await filesUnder(path, depth - 1)));
  }
  return out;
}

/** Every file these tools can write, as it exists right now. */
async function candidates(ctx: ToolContext): Promise<string[]> {
  const root = rootOf(ctx);
  const project = projectDir(root);
  const nested = await Promise.all([
    filesUnder(join(project, "rules"), 0),
    filesUnder(join(project, "skills"), 2),
    filesUnder(memoryDir(root), 0),
  ]);
  return [
    ...nested.flat(),
    ...PERMISSION_FILES.map((f) => join(project, f)),
    ...PERMISSION_FILES.map((f) => join(stateRoot(), f)),
    projectConfigPath(root),
    globalConfigPath(),
  ];
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export type StateSnapshot = Map<string, string | null>;

/** Read everything a state tool could change, before it runs. */
export async function snapshotAgentState(ctx: ToolContext): Promise<StateSnapshot> {
  const paths = await candidates(ctx);
  const values = await Promise.all(paths.map(readOrNull));
  return new Map(paths.map((p, i) => [p, values[i]!]));
}

/**
 * After the tool ran: hand every file it created, changed or deleted to the checkpoints,
 * with what it was before. A file that appeared is recorded as "did not exist", so undo
 * removes it; one that vanished is recorded as deleted, so undo puts it back.
 */
export async function recordAgentStateChanges(ctx: ToolContext, before: StateSnapshot): Promise<void> {
  const cp = ctx.checkpoints;
  if (!cp) return;
  const paths = new Set([...before.keys(), ...(await candidates(ctx))]);
  for (const path of paths) {
    const was = before.get(path) ?? null;
    const now = await readOrNull(path);
    if (was !== now) cp.backup(path, was, now);
  }
}

/** What kind of agent state a path is, for saying what a rollback took back. */
export type StateKind = "memory" | "rule" | "skill" | "permission" | "mcp";

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** Which agent state a path belongs to, or null for an ordinary project file. Every file
 *  in those places counts as agent state, the memory index and a skill's extra files too. */
export function stateKindOf(path: string, root: string): StateKind | null {
  const project = projectDir(root);
  const p = norm(path);
  if (p === norm(projectConfigPath(root)) || p === norm(globalConfigPath())) return "mcp";
  if (p.startsWith(norm(memoryDir(root)) + "/")) return "memory";
  if (p.startsWith(norm(join(project, "rules")) + "/")) return "rule";
  if (p.startsWith(norm(join(project, "skills")) + "/")) return "skill";
  const name = p.split("/").pop() ?? "";
  if (PERMISSION_FILES.includes(name) && (p.startsWith(norm(project) + "/") || p.startsWith(norm(stateRoot()) + "/"))) return "permission";
  return null;
}

/** Whether this state file is one ITEM worth counting ("1 memory"), rather than an index
 *  or a skill's supporting file that changed along with it. */
export function isStateItem(path: string, root: string): boolean {
  const kind = stateKindOf(path, root);
  const name = norm(path).split("/").pop() ?? "";
  if (kind === "memory") return name !== MEMORY_INDEX.toLowerCase();
  if (kind === "skill") return name === "skill.md";
  return kind !== null;
}
