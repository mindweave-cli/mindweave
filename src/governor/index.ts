/**
 * governor — the per-project control layer (rules · skills · forbidden).
 *
 * Like an engine's governor regulates how it may run, this regulates how Mindweave
 * works inside a project: the standing rules it must follow, the skills it can
 * run, and the paths/actions it must never touch. Everything is scoped to one
 * project and stored under that project's state dir (`~/.mindweave/projects/<proj>/`),
 * the same place sessions live — so a rule set in project A never leaks into B.
 * (Global rules/skills are a planned second layer; the per-project design leaves
 * a clean seam for merging one on top.)
 *
 * `loadGovernance` reads it all once at session start (cheap: a couple of small
 * directory reads). The forbidden config rides on the tool context for
 * mechanical enforcement; the rules and skill catalog are rendered into the
 * system prompt by the engine.
 */
import { projectDir, stateRoot } from "../memory/store.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadRules } from "./rules.js";
import { loadSkillCatalog } from "./skills.js";
import { parseForbidden, parseForbiddenCommands, parseForbiddenMcpTools } from "./forbidden.js";
import { parseCommandRules } from "../tools/commandPolicy.js";
import type { Governance } from "./types.js";

/** Read a project state file (forbidden.md / forbidden-commands.md), "" if absent. */
async function readStateFile(stateDir: string, name: string): Promise<string> {
  try {
    return await fs.readFile(join(stateDir, name), "utf8");
  } catch {
    return "";
  }
}

/**
 * Where one scope's permission files live: the project's state dir, or the universal
 * one (`~/.mindweave`) whose lists apply in every project.
 */
export function governanceDir(cwd: string, scope: GovernanceScope): string {
  return scope === "global" ? stateRoot() : projectDir(cwd);
}
export type GovernanceScope = "project" | "global";

/** The deny-lists and Sentinel allowances of ONE scope, unmerged, for a settings screen. */
export async function loadPermissionLists(cwd: string, scope: GovernanceScope) {
  const dir = governanceDir(cwd, scope);
  const [paths, commands, mcpTools, sentinel, commandRules] = await Promise.all([
    readStateFile(dir, "forbidden.md"),
    readStateFile(dir, "forbidden-commands.md"),
    readStateFile(dir, "forbidden-mcp-tools.md"),
    readStateFile(dir, "sentinel-allow.md"),
    readStateFile(dir, "command-rules.md"),
  ]);
  return {
    paths: parseForbidden(paths),
    commands: parseForbiddenCommands(commands),
    mcpTools: parseForbiddenMcpTools(mcpTools),
    sentinelAllow: parseForbiddenCommands(sentinel),
    commandRules: parseCommandRules(commandRules),
  };
}

const unique = (list: string[]): string[] => [...new Set(list)];

const CONTEXT_FILE = "context.json";

/** One scope's auto-compaction override, or null if unset/unreadable/invalid. */
export async function loadContextOverride(cwd: string, scope: GovernanceScope): Promise<number | null> {
  try {
    const raw = JSON.parse(await fs.readFile(join(governanceDir(cwd, scope), CONTEXT_FILE), "utf8")) as {
      autoCompactTokens?: unknown;
    };
    const n = raw.autoCompactTokens;
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
}

/** Set or clear one scope's auto-compaction override. `tokens: null` clears it. */
export async function saveContextOverride(cwd: string, scope: GovernanceScope, tokens: number | null): Promise<void> {
  const dir = governanceDir(cwd, scope);
  const file = join(dir, CONTEXT_FILE);
  if (tokens === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ autoCompactTokens: Math.round(tokens) }, null, 2), "utf8");
}

/**
 * Load all governance for the project rooted at `cwd`. Always succeeds (empties).
 *
 * The deny-lists and Sentinel allowances are the universal layer plus the project's,
 * merged: something forbidden everywhere is forbidden here too, and a project can only
 * add to it. Rules and skills stay per project.
 */
export async function loadGovernance(cwd: string): Promise<Governance> {
  const stateDir = projectDir(cwd);
  const [projectRules, projectSkills, globalRules, globalSkills, global, project, globalContext, projectContext] =
    await Promise.all([
      loadRules(stateDir),
      loadSkillCatalog(stateDir),
      loadRules(stateRoot()),
      loadSkillCatalog(stateRoot()),
      loadPermissionLists(cwd, "global"),
      loadPermissionLists(cwd, "project"),
      loadContextOverride(cwd, "global"),
      loadContextOverride(cwd, "project"),
    ]);
  // Rules and skills for every project come first; a project's own of the same name
  // replaces the universal one, so a project can override a general habit.
  const byName = <T extends { name: string }>(general: T[], own: T[]): T[] => {
    const ownNames = new Set(own.map((x) => x.name));
    return [...general.filter((x) => !ownNames.has(x.name)), ...own];
  };
  const rules = byName(globalRules, projectRules);
  const skills = byName(globalSkills, projectSkills);
  const sentinelAllow = unique([...global.sentinelAllow, ...project.sentinelAllow]);
  // A project's rules come after the user's own, so on a conflict the project's line is the one found last;
  // matching takes forbid over prompt over allow whichever file a rule came from.
  const commandRules = [...global.commandRules, ...project.commandRules];
  return {
    rules,
    skills,
    forbidden: {
      patterns: unique([...global.paths, ...project.paths]),
      commands: unique([...global.commands, ...project.commands]),
      mcpTools: unique([...global.mcpTools, ...project.mcpTools]),
      root: cwd,
    },
    ...(sentinelAllow.length ? { sentinelAllow } : {}),
    ...(commandRules.length ? { commandRules } : {}),
    ...(projectContext !== null ? { contextAutoCompactTokens: projectContext } : globalContext !== null ? { contextAutoCompactTokens: globalContext } : {}),
  };
}

export { renderRules } from "./rules.js";
export { renderSkillCatalog } from "./skills.js";
export type { Governance, Rule, SkillMeta, ForbiddenConfig } from "./types.js";

/**
 * Re-read governance from disk, keeping everything that exists only in this session.
 *
 * Three things do NOT come from disk and must survive a reload:
 *   - `lifted` — patterns the user allowed for this session only (approval.ts). The
 *     on-disk rule is intentionally left in place, so a plain reload would restore it
 *     and re-block a path the user had just permitted.
 *   - `notices` — one-shot lines the UI has not drained yet. Dropping them loses the
 *     message rather than delaying it.
 *   - the fired rule-scope, which is not on `Governance` at all: it lives on the tool
 *     context and is re-judged against the new rule list by the caller.
 *
 * Returns a NEW object rather than mutating: the forbidden matcher caches compiled
 * patterns in a WeakMap keyed on array identity, so fresh arrays are what make it
 * recompile instead of enforcing the old list.
 */
export async function reloadGovernance(cwd: string, previous: Governance): Promise<Governance> {
  const fresh = await loadGovernance(cwd);
  const lifted = previous.lifted ?? [];
  return {
    ...fresh,
    forbidden: {
      ...fresh.forbidden,
      patterns: fresh.forbidden.patterns.filter((p) => !lifted.includes(p)),
      commands: (fresh.forbidden.commands ?? []).filter((c) => !lifted.includes(c)),
    },
    ...(lifted.length > 0 ? { lifted } : {}),
    ...(previous.notices && previous.notices.length > 0 ? { notices: previous.notices } : {}),
  };
}

export { governanceStamp } from "./freshness.js";
export { createRuleScope, noteScopePath, rescope } from "./scope.js";
export type { RuleScope } from "./scope.js";
