/**
 * write.ts — persist a new rule or forbidden path for a project.
 *
 * The governor owns the on-disk formats, so the act of "make this a rule" or
 * "forbid this" lives here; the tools in src/tools are thin wrappers that call
 * these and then mirror the change into the live session so it takes effect
 * immediately. Files land under the project's state dir (the same per-project
 * folder sessions use), so they persist for every future launch in this project.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir } from "../memory/store.js";
import { parseForbidden, parseForbiddenCommands } from "./forbidden.js";
import type { Rule, SkillMeta } from "./types.js";
import { governanceDir, type GovernanceScope } from "./index.js";

/** A filesystem-safe slug from a human name/phrase (kebab, ≤50 chars). */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "rule"
  );
}

/**
 * Flatten a value to a single line before it goes into frontmatter.
 *
 * These headers are a line-oriented `key: value` format, and every value here is
 * model-supplied text. A newline inside one starts what the loader reads as a NEW
 * key, so a rule whose name ended in "\nglobs: **" would come back scoped to
 * everything, and a skill's description could rewrite its own `when_to_use`. The
 * value is written, then read back and believed, so it has to stay one field.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Build a frontmatter header, flattening EVERY value on the way in.
 *
 * `oneLine` used to be applied field by field at each call site, and one field was
 * missed: `globs` went in raw as `globs: ${globs.join(", ")}`. That is the field
 * deciding when a rule fires, and a newline inside it writes whatever the model
 * likes into the header — a second key, or a `---` that closes it early and turns
 * the rest of the rule into body.
 *
 * Written as one place that flattens everything, so the next field added cannot
 * repeat the mistake. Empty values are dropped rather than emitted blank.
 */
function frontmatter(fields: Record<string, string | undefined>): string {
  const lines: string[] = ["---"];
  for (const [key, raw] of Object.entries(fields)) {
    const value = oneLine(raw ?? "");
    if (value) lines.push(`${key}: ${value}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** A short name derived from a rule's text (first few words) when none is given. */
export function deriveRuleName(body: string): string {
  return slugify(body.split(/\s+/).slice(0, 6).join(" "));
}

/**
 * Save a standing rule as `rules/<slug>.md` in the project's state dir and return
 * it. Overwrites a rule file of the same slug (re-stating a rule updates it). Pass
 * `globs` to SCOPE the rule (fires only when the work touches matching files);
 * omit them for an always-on rule (the default).
 */
export async function writeRule(
  cwd: string,
  name: string,
  body: string,
  description = "",
  globs: string[] = [],
  origin = "",
): Promise<Rule> {
  const dir = join(projectDir(cwd), "rules");
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${slugify(name)}.md`);
  const header = frontmatter({
    name,
    description,
    globs: globs.join(", "),
    origin,
  });
  await fs.writeFile(file, `${header}${body}\n`, "utf8");
  return {
    name: oneLine(name),
    description: oneLine(description),
    body,
    ...(globs.length > 0 ? { globs } : {}),
    ...(origin ? { origin: oneLine(origin) } : {}),
  };
}

/** Fields for creating a skill (everything but where it lives). */
export interface NewSkill {
  name: string;
  description: string;
  body: string;
  whenToUse?: string;
  argumentHint?: string;
  globs?: string[];
}

/**
 * Create (or overwrite) a skill at `skills/<slug>/SKILL.md` in the project's
 * state dir and return its catalog metadata. The directory name is the skill's
 * invocation name; the frontmatter carries description / when-to-use / hint /
 * scope so it loads back identically.
 */
export async function writeSkill(cwd: string, skill: NewSkill): Promise<SkillMeta> {
  const name = slugify(skill.name);
  const dir = join(projectDir(cwd), "skills", name);
  await fs.mkdir(dir, { recursive: true });

  const description = oneLine(skill.description);
  const whenToUse = oneLine(skill.whenToUse ?? "");
  const argumentHint = oneLine(skill.argumentHint ?? "");
  const header = frontmatter({
    name, // already the slug: no newline can survive slugify
    description,
    when_to_use: whenToUse,
    "argument-hint": argumentHint,
    globs: skill.globs?.join(", ") ?? "",
  });
  await fs.writeFile(join(dir, "SKILL.md"), `${header}${skill.body}\n`, "utf8");

  return {
    name,
    description,
    whenToUse,
    dir,
    ...(argumentHint ? { argumentHint } : {}),
    ...(skill.globs && skill.globs.length > 0 ? { globs: skill.globs } : {}),
  };
}

/**
 * Append a pattern to `forbidden.md` in the project's state dir. Idempotent —
 * returns `{ added: false }` if it was already forbidden. The pattern is
 * normalized the same way the loader normalizes (drop leading `./`, trailing `/`).
 */
export async function appendForbidden(
  cwd: string,
  pattern: string,
  scope: GovernanceScope = "project",
): Promise<{ added: boolean; pattern: string }> {
  const normalized = pattern.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!normalized) return { added: false, pattern: normalized };

  const base = governanceDir(cwd, scope);
  const file = join(base, "forbidden.md");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    /* no forbidden.md yet */
  }
  if (parseForbidden(text).includes(normalized)) return { added: false, pattern: normalized };

  await fs.mkdir(base, { recursive: true });
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  await fs.writeFile(file, `${text}${separator}${normalized}\n`, "utf8");
  return { added: true, pattern: normalized };
}

/**
 * Append an MCP tool name to `forbidden-mcp-tools.md`. Sibling of
 * appendForbiddenCommand; tool names are identifiers, kept verbatim.
 */
export async function appendForbiddenMcpTool(
  cwd: string,
  name: string,
  scope: GovernanceScope = "project",
): Promise<{ added: boolean; pattern: string }> {
  const normalized = name.trim();
  if (!normalized) return { added: false, pattern: normalized };

  const base = governanceDir(cwd, scope);
  const file = join(base, "forbidden-mcp-tools.md");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    /* no forbidden-mcp-tools.md yet */
  }
  if (parseForbiddenCommands(text).includes(normalized)) return { added: false, pattern: normalized };

  await fs.mkdir(base, { recursive: true });
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  await fs.writeFile(file, `${text}${separator}${normalized}\n`, "utf8");
  return { added: true, pattern: normalized };
}

/**
 * Append a command pattern to `forbidden-commands.md` in the project's state dir.
 * Idempotent — `{ added: false }` if it was already forbidden. Sibling of
 * appendForbidden; command patterns are kept verbatim (trimmed), not path-normalized.
 */
export async function appendForbiddenCommand(
  cwd: string,
  pattern: string,
  scope: GovernanceScope = "project",
): Promise<{ added: boolean; pattern: string }> {
  const normalized = pattern.trim();
  if (!normalized) return { added: false, pattern: normalized };

  const base = governanceDir(cwd, scope);
  const file = join(base, "forbidden-commands.md");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    /* no forbidden-commands.md yet */
  }
  if (parseForbiddenCommands(text).includes(normalized)) return { added: false, pattern: normalized };

  await fs.mkdir(base, { recursive: true });
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  await fs.writeFile(file, `${text}${separator}${normalized}\n`, "utf8");
  return { added: true, pattern: normalized };
}

/**
 * Undo half of the writers above. Nothing here could be taken back before: every
 * standing decision could be made and none could be lifted, so "actually, drop that
 * rule" meant editing files under `.mindweave/` by hand.
 *
 * A miss is reported, never invented: removing something that was not there returns
 * `false`, so the caller can say so instead of claiming a change it did not make.
 */
export async function removeRule(cwd: string, name: string): Promise<boolean> {
  const file = join(projectDir(cwd), "rules", `${slugify(name)}.md`);
  try {
    await fs.rm(file);
    return true;
  } catch {
    return false;
  }
}

/** Delete a skill directory (`skills/<slug>/`). False when there was no such skill. */
export async function removeSkill(cwd: string, name: string): Promise<boolean> {
  const dir = join(projectDir(cwd), "skills", slugify(name));
  try {
    await fs.rm(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Drop one line from one of the `forbidden*.md` lists. False when it was not listed. */
async function removeForbiddenLine(cwd: string, fileName: string, value: string, scope: GovernanceScope = "project"): Promise<boolean> {
  const wanted = value.trim();
  if (!wanted) return false;
  const file = join(governanceDir(cwd, scope), fileName);
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  // Compared trimmed, so an entry written with stray spacing still matches what the
  // user asked to lift, and the file's own comments and blank lines are left alone.
  const kept = lines.filter((line) => line.trim() !== wanted);
  if (kept.length === lines.length) return false;
  await fs.writeFile(file, kept.join("\n"), "utf8");
  return true;
}

export async function removeForbiddenPath(cwd: string, pattern: string, scope: GovernanceScope = "project"): Promise<boolean> {
  const normalized = pattern.trim().replace(/^\.\//, "").replace(/\/$/, "");
  return removeForbiddenLine(cwd, "forbidden.md", normalized, scope);
}

export async function removeForbiddenCommand(cwd: string, pattern: string, scope: GovernanceScope = "project"): Promise<boolean> {
  return removeForbiddenLine(cwd, "forbidden-commands.md", pattern, scope);
}

export async function removeForbiddenMcpTool(cwd: string, name: string, scope: GovernanceScope = "project"): Promise<boolean> {
  return removeForbiddenLine(cwd, "forbidden-mcp-tools.md", name, scope);
}

/**
 * Save a kind of action (a tool name) that Sentinel mode will not ask about, in this
 * project or everywhere. Same one-per-line format as the deny-lists, so it reads and
 * edits the same way by hand. Idempotent.
 */
export async function appendSentinelAllow(
  cwd: string,
  tool: string,
  scope: GovernanceScope = "project",
): Promise<{ added: boolean; pattern: string }> {
  const normalized = tool.trim();
  if (!normalized) return { added: false, pattern: normalized };
  const base = governanceDir(cwd, scope);
  const file = join(base, "sentinel-allow.md");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    /* none yet */
  }
  if (parseForbiddenCommands(text).includes(normalized)) return { added: false, pattern: normalized };
  await fs.mkdir(base, { recursive: true });
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  await fs.writeFile(file, `${text}${separator}${normalized}\n`, "utf8");
  return { added: true, pattern: normalized };
}

export async function removeSentinelAllow(cwd: string, tool: string, scope: GovernanceScope = "project"): Promise<boolean> {
  return removeForbiddenLine(cwd, "sentinel-allow.md", tool, scope);
}

// ── command rules (command-rules.md) ─────────────────────────────────────────

/**
 * Add one line to command-rules.md: `allow npm test`, `prompt git push`, `forbid rm -rf :: why`.
 * Idempotent; the same decision for the same words is one line. Returns the line as written.
 */
export async function appendCommandRule(
  cwd: string,
  decision: "allow" | "prompt" | "forbid",
  words: string,
  scope: GovernanceScope = "project",
  why = "",
): Promise<{ added: boolean; line: string }> {
  const prefix = words.trim().replace(/\s+/g, " ").replace(/[\r\n]/g, " ");
  const reason = why.replace(/[\r\n]+/g, " ").replace(/::/g, ":").trim();
  const line = `${decision} ${prefix}${reason ? ` :: ${reason}` : ""}`;
  if (!prefix) return { added: false, line };
  const base = governanceDir(cwd, scope);
  const file = join(base, "command-rules.md");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    /* none yet */
  }
  const same = (l: string) => l.trim().toLowerCase().replace(/\s*::.*$/, "") === `${decision} ${prefix}`.toLowerCase();
  if (text.split(/\r?\n/).some(same)) return { added: false, line };
  await fs.mkdir(base, { recursive: true });
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  await fs.writeFile(file, `${text}${separator}${line}\n`, "utf8");
  return { added: true, line };
}

/** The rule lines of command-rules.md, comments and blanks left out. */
export async function readCommandRuleLines(cwd: string, scope: GovernanceScope = "project"): Promise<string[]> {
  try {
    const text = await fs.readFile(join(governanceDir(cwd, scope), "command-rules.md"), "utf8");
    return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

export async function removeCommandRule(cwd: string, line: string, scope: GovernanceScope = "project"): Promise<boolean> {
  return removeForbiddenLine(cwd, "command-rules.md", line, scope);
}
