/**
 * rulesSkills.ts — rules and skills as plain files a settings screen can list and edit.
 *
 * A rule is `rules/<name>.md`; a skill is `skills/<name>/SKILL.md`. Each lives in one of
 * two places: the project's Mindweave folder, or `~/.mindweave` for every project (merged
 * by governor/index.ts, the project's own winning on a name clash). The screen edits the
 * file as text, so nothing here parses or rebuilds it; saving re-reads governance so the
 * open chat follows the change on its next message.
 */
import { promises as fs } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Session } from "../memory/types.js";
import { governanceDir, type GovernanceScope } from "../governor/index.js";
import { slugify } from "../governor/write.js";
import { parseFrontmatter } from "../governor/frontmatter.js";
import { refreshGovernance } from "../dynamo/engine.js";

export type RSKind = "rule" | "skill";

export interface RSItem {
  kind: RSKind;
  name: string;
  scope: GovernanceScope;
  /** The file to edit: the rule's .md, or the skill's SKILL.md. */
  file: string;
}

export type RSResult = { ok: true; file?: string } | { ok: false; error: string };

const RULE_TEMPLATE = (name: string) =>
  `---\nname: ${name}\ndescription: \n---\nWrite the rule here, as an instruction the agent should always follow.\n`;
const SKILL_TEMPLATE = (name: string) =>
  `---\nname: ${name}\ndescription: What this skill does, in one line.\nwhen_to_use: When the agent should run it.\n---\n1. First step\n2. Next step\n`;

async function listScope(cwd: string, scope: GovernanceScope): Promise<RSItem[]> {
  const base = governanceDir(cwd, scope);
  const items: RSItem[] = [];
  try {
    for (const n of (await fs.readdir(join(base, "rules"))).sort()) {
      if (n.toLowerCase().endsWith(".md")) items.push({ kind: "rule", name: basename(n, ".md"), scope, file: join(base, "rules", n) });
    }
  } catch {
    /* no rules yet */
  }
  try {
    for (const d of (await fs.readdir(join(base, "skills"), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(base, "skills", d.name, "SKILL.md");
      if (d.isDirectory() && (await fs.stat(file).catch(() => null))) items.push({ kind: "skill", name: d.name, scope, file });
    }
  } catch {
    /* no skills yet */
  }
  return items;
}

/** Every rule and skill for this project and for all projects. */
export async function listRulesSkills(session: Session, cwd: string = session.cwd): Promise<RSItem[]> {
  return [...(await listScope(cwd, "project")), ...(await listScope(cwd, "global"))];
}

/**
 * Only a rule or skill file of this project or of all projects may be read or written
 * through here: the path comes from the screen, and it must not become a way to edit
 * anything else on disk.
 */
function allowed(cwd: string, file: string): { kind: RSKind; scope: GovernanceScope } | null {
  const abs = resolve(file);
  for (const scope of ["project", "global"] as const) {
    const base = governanceDir(cwd, scope);
    const rel = relative(base, abs);
    if (rel.startsWith("..") || resolve(base, rel) !== abs) continue;
    const parts = rel.split(sep);
    if (parts.length === 2 && parts[0] === "rules" && parts[1]!.toLowerCase().endsWith(".md")) return { kind: "rule", scope };
    if (parts.length === 3 && parts[0] === "skills" && parts[2] === "SKILL.md") return { kind: "skill", scope };
  }
  return null;
}

export async function readRuleSkill(session: Session, file: string, cwd: string = session.cwd): Promise<string | null> {
  if (!allowed(cwd, file)) return null;
  return fs.readFile(file, "utf8").catch(() => null);
}

export async function saveRuleSkill(session: Session, file: string, text: string, cwd: string = session.cwd): Promise<RSResult> {
  if (!allowed(cwd, file)) return { ok: false, error: "That is not a rule or skill file." };
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
  await refreshGovernance(session, true);
  return { ok: true, file };
}

/** Create a new rule or skill from a short template and return its file to edit. */
export async function createRuleSkill(
  session: Session,
  kind: RSKind,
  rawName: string,
  scope: GovernanceScope,
  cwd: string = session.cwd,
): Promise<RSResult> {
  if (!rawName.trim()) return { ok: false, error: "Give it a name." };
  const name = slugify(rawName);
  const base = governanceDir(cwd, scope);
  const file = kind === "rule" ? join(base, "rules", `${name}.md`) : join(base, "skills", name, "SKILL.md");
  if (await fs.stat(file).catch(() => null)) return { ok: false, error: `A ${kind} called '${name}' already exists there.` };
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, kind === "rule" ? RULE_TEMPLATE(name) : SKILL_TEMPLATE(name), "utf8");
  await refreshGovernance(session, true);
  return { ok: true, file };
}

export async function deleteRuleSkill(session: Session, file: string, cwd: string = session.cwd): Promise<RSResult> {
  const where = allowed(cwd, file);
  if (!where) return { ok: false, error: "That is not a rule or skill file." };
  // A skill is its whole folder (bundled files included); a rule is one file.
  await fs.rm(where.kind === "skill" ? dirname(file) : file, { recursive: true, force: true });
  await refreshGovernance(session, true);
  return { ok: true };
}

/** Move a rule or skill between this project and all projects. */
export async function moveRuleSkill(session: Session, file: string, cwd: string = session.cwd): Promise<RSResult> {
  const where = allowed(cwd, file);
  if (!where) return { ok: false, error: "That is not a rule or skill file." };
  const to: GovernanceScope = where.scope === "project" ? "global" : "project";
  const base = governanceDir(cwd, to);
  const from = where.kind === "skill" ? dirname(file) : file;
  const target = where.kind === "skill" ? join(base, "skills", basename(from)) : join(base, "rules", basename(from));
  if (await fs.stat(target).catch(() => null)) return { ok: false, error: "One with the same name is already there." };
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.cp(from, target, { recursive: true });
  await fs.rm(from, { recursive: true, force: true });
  await refreshGovernance(session, true);
  return { ok: true, file: where.kind === "skill" ? join(target, "SKILL.md") : target };
}

/**
 * Add a rule or skill from a file the user picked or dropped: its name and text only,
 * since the screen reads the file itself. A file called SKILL.md, or one whose header
 * says `when_to_use`, is a skill; anything else is a rule. The name comes from the
 * header's `name`, else from the file name.
 */
export async function importRuleSkill(
  session: Session,
  fileName: string,
  text: string,
  scope: GovernanceScope,
  cwd: string = session.cwd,
): Promise<RSResult & { kind?: RSKind; name?: string }> {
  if (!text.trim()) return { ok: false, error: `${fileName} is empty.` };
  const { data } = parseFrontmatter(text);
  const base = basename(fileName).replace(/\.(md|markdown|txt)$/i, "");
  const kind: RSKind = /^skill$/i.test(base) || data.when_to_use || data.whenToUse ? "skill" : "rule";
  // Checked before slugify, which turns an empty name into "rule".
  const rawName = (data.name || (/^skill$/i.test(base) ? "" : base)).trim();
  const name = rawName ? slugify(rawName) : "";
  if (!name) return { ok: false, error: `${fileName} has no name. Add a "name:" line at the top, or rename the file.` };
  const created = await createRuleSkill(session, kind, name, scope, cwd);
  if (!created.ok) return created;
  const saved = await saveRuleSkill(session, created.file!, text, cwd);
  return saved.ok ? { ...saved, kind, name } : saved;
}
