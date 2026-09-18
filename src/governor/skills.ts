/**
 * skills.ts — reusable procedures the model can run on demand.
 *
 * A skill is a named playbook: `<project-state>/skills/<name>/SKILL.md`, with a
 * `name` / `description` / `when_to_use` header and a markdown body of steps.
 * The key design is **progressive disclosure**: only
 * the lightweight catalog (name + description + when-to-use) ever sits in the
 * prompt, so a project can have many skills at near-zero token cost; the full
 * body is read only when the skill is actually invoked — by the user typing
 * `/name`, or by the model calling the `use_skill` tool when a description fits.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { parseGlobs } from "./rules.js";
import { anyPathMatches } from "./glob.js";
import type { SkillMeta } from "./types.js";

const SKILL_FILE = "SKILL.md";

/** Discover the project's skills, reading only each one's frontmatter (catalog). */
export async function loadSkillCatalog(stateDir: string): Promise<SkillMeta[]> {
  const dir = join(stateDir, "skills");
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // no skills dir yet
  }

  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // skills are directories: <name>/SKILL.md
    const skillDir = join(dir, entry.name);
    try {
      const raw = await fs.readFile(join(skillDir, SKILL_FILE), "utf8");
      const { data } = parseFrontmatter(raw);
      const globs = parseGlobs(data.globs || data.paths);
      skills.push({
        name: data.name || entry.name,
        description: data.description || "",
        whenToUse: data.when_to_use || data.whenToUse || "",
        dir: skillDir,
        ...(data["argument-hint"] ? { argumentHint: data["argument-hint"] } : {}),
        ...(globs.length > 0 ? { globs } : {}),
      });
    } catch {
      // No SKILL.md (or unreadable) — not a skill directory; skip it.
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Load a skill's full body (the steps), read fresh on invocation. Null if gone. */
export async function loadSkillBody(skill: SkillMeta): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(skill.dir, SKILL_FILE), "utf8");
    return parseFrontmatter(raw).body;
  } catch {
    return null;
  }
}

/** Find a skill by its invocation name (case-insensitive). */
export function findSkill(skills: SkillMeta[], name: string): SkillMeta | undefined {
  const wanted = name.trim().toLowerCase().replace(/^\//, "");
  return skills.find((s) => s.name.toLowerCase() === wanted);
}

/**
 * The skills visible in the catalog this turn: every always-listed skill plus any
 * glob-scoped skill whose patterns match the working set. (Scoped-out skills are
 * still invokable by name — this only controls catalog noise.)
 */
export function activeSkills(skills: SkillMeta[], workingSet: string[] = []): SkillMeta[] {
  return skills.filter((s) => !s.globs || s.globs.length === 0 || anyPathMatches(workingSet, s.globs));
}

/**
 * Render the catalog for the system prompt: one line per visible skill with its
 * name (+ argument hint), description, and when-to-use. "" when none are visible.
 * Content only — the engine frames it.
 */
/**
 * Caps on the always-loaded skill catalog.
 *
 * This block renders into the CACHED system prefix on every session and only ever
 * grows: every skill created adds a line, permanently, and nothing trims it.
 *
 * The cap is on LENGTH PER ENTRY rather than on the number of entries, and that is a
 * deliberate departure from "keep the most recent N". A skill is only reachable by
 * NAME — use_skill takes one, and there is no tool that lists them — so an entry
 * dropped from this catalog is a skill the model can no longer invoke at all. Trading
 * a capability away to save tokens is the wrong trade. Clipping a rambling description
 * costs nothing by comparison: the name still appears, the skill stays callable, and
 * its full text is loaded on use anyway.
 *
 * The entry cap below is a backstop against the absurd case, set far above any real
 * project, and it says so when it bites.
 */
const MAX_SKILL_LINE_CHARS = 200;
const MAX_SKILL_ENTRIES = 100;

/** Clip to `max` on a word boundary where possible, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function renderSkillCatalog(skills: SkillMeta[], workingSet?: string[]): string {
  // OMITTING the working set means "list everything", not "list nothing". It used to
  // default to `[]`, which quietly filtered every glob-scoped skill out — so a caller
  // that had no working set to give showed an incomplete catalog, and a skill reachable
  // only by name became uninvokable.
  //
  // The engine relies on this: the catalog renders into the CACHED system prompt, so it
  // must be byte-identical all session. Filtering it by the working set made a
  // glob-scoped skill appear the moment a matching file was read, changing the system
  // prompt and invalidating the tools, system and message caches at once.
  const visible = workingSet === undefined ? skills : activeSkills(skills, workingSet);
  if (visible.length === 0) return "";
  const shown = visible.slice(0, MAX_SKILL_ENTRIES);
  const lines = shown.map((s) => {
    const hint = s.argumentHint ? ` ${s.argumentHint}` : "";
    const desc = s.description ? `: ${s.description}` : "";
    const when = s.whenToUse ? ` — use when: ${s.whenToUse}` : "";
    // The name and its argument hint are never clipped — they are what makes the
    // skill callable. Only the prose after them is.
    return `- ${s.name}${hint}${clip(`${desc}${when}`, MAX_SKILL_LINE_CHARS)}`;
  });
  if (visible.length > shown.length) {
    lines.push(
      `> WARNING: ${visible.length - shown.length} more skill(s) exist but are not listed here. ` +
        `Keep the catalog under ${MAX_SKILL_ENTRIES} skills, or scope them with \`globs\` so they appear only when relevant.`,
    );
  }
  return lines.join("\n");
}

/**
 * Substitute a skill's argument string into its body: `$ARGUMENTS` → the whole
 * string, `$1`/`$2`/… → positional tokens. If the body has no such placeholder
 * but arguments were given, they're appended as additional context — so both
 * parameterized and plain skills handle args sensibly.
 */
export function substituteSkillArgs(body: string, argString: string): string {
  const args = argString.trim();
  const positional = args.length > 0 ? args.split(/\s+/) : [];
  const hasPlaceholder = /\$ARGUMENTS\b/.test(body) || POSITIONAL.test(body);

  // ONE pass over the original body. Two chained replaces meant a `$1` inside the
  // user's own argument string was then treated as a placeholder and substituted again.
  const out = body.replace(SUBSTITUTION, (match, digit?: string) => {
    if (digit === undefined) return args;
    // Leave the placeholder visible when nothing was supplied for it. Blanking it makes
    // a skill that expected an argument read as though it never wanted one.
    return positional[Number(digit) - 1] ?? match;
  });

  if (!hasPlaceholder && args) return `${out}\n\nAdditional context from the user: ${args}`;
  return out;
}

/**
 * A positional placeholder: `$1`–`$9`, and NOT the start of a longer number.
 *
 * A skill body is a markdown playbook, so it very reasonably contains shell
 * (`awk '{print $1}'`) and money (`$100`). The old pattern was `/\$(\d+)/`, which
 * matched `$100` as positional argument one hundred, found nothing, and substituted
 * the empty string — so `Budget is $100` silently became `Budget is `, and with no
 * arguments at all EVERY `$n` in the body was deleted. The instructions the model was
 * told to follow were quietly not the instructions on disk. Single digit matches the
 * shell convention the syntax is borrowed from.
 */
const POSITIONAL_SRC = String.raw`\$([1-9])(?!\d)`;

/** Detects one, for deciding whether the skill declared any placeholder at all. */
const POSITIONAL = new RegExp(POSITIONAL_SRC);

/** Replaces every placeholder in one pass. Shares POSITIONAL's source so the two
 *  cannot drift into disagreeing about what counts as a placeholder. */
const SUBSTITUTION = new RegExp(String.raw`\$ARGUMENTS\b|` + POSITIONAL_SRC, "g");
