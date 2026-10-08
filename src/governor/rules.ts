/**
 * rules.ts — the user's standing rules for a project.
 *
 * A rule is a directive the user has asked Mindweave to always follow here ("use
 * pnpm, never npm"; "every component gets a test"). Each lives as its own
 * markdown file under `<project-state>/rules/`, and ALL of them are injected into
 * the system prompt every turn — this is the always-on layer of project directives.
 * Per-file (not one big file) so a single rule
 * can be added or removed cleanly, the same way the memory system works.
 *
 * "Make it a rule" is the model writing a new file here; the loader just reads
 * whatever files exist, so hand-authored rules work identically.
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { Rule } from "./types.js";

/** Parse a frontmatter `globs` field (comma/space/newline separated) into a clean list. */
export function parseGlobs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((g) => g.trim().replace(/^\.?\//, "").replace(/\/+$/, ""))
    .filter((g) => g.length > 0);
}

/** Read every `rules/*.md` for the project, newest-named last (stable order). */
export async function loadRules(stateDir: string): Promise<Rule[]> {
  const dir = join(stateDir, "rules");
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".md")).sort();
  } catch {
    return []; // no rules dir yet
  }

  const rules: Rule[] = [];
  for (const name of names) {
    try {
      const raw = await fs.readFile(join(dir, name), "utf8");
      const { data, body } = parseFrontmatter(raw);
      if (!body) continue; // an empty rule says nothing — skip it
      const globs = parseGlobs(data.globs);
      rules.push({
        name: data.name || basename(name, ".md"),
        description: data.description || "",
        body,
        ...(data.origin ? { origin: data.origin } : {}),
        ...(globs.length > 0 ? { globs } : {}),
      });
    } catch {
      // Unreadable file — skip it rather than fail all rule loading.
    }
  }
  return rules;
}

/**
 * Pick the rules active for this turn: every always-on rule (no globs) plus any
 * glob-scoped rule that has already FIRED — see scope.ts, which decides that once, when
 * a matching path is touched, instead of re-deriving it from the whole working set on
 * every model call.
 *
 * `fired` holds rule NAMES. Filtering by the live rule list rather than by that set is
 * what makes a rule deleted from disk stop rendering even though its name is remembered.
 */
export function activeRules(rules: Rule[], fired: ReadonlySet<string> = new Set()): Rule[] {
  return rules.filter((r) => !r.globs || r.globs.length === 0 || fired.has(r.name));
}

/**
 * Render the active rules into the block injected in the system prompt. "" when
 * none apply (the engine then omits the block). Content only — the engine wraps
 * it in its `<rules>` framing, matching how the task list is done.
 */
export function renderRules(rules: Rule[], fired: ReadonlySet<string> = new Set()): string {
  const active = activeRules(rules, fired);
  if (active.length === 0) return "";
  return active.map((r) => `- ${r.body}`).join("\n");
}
