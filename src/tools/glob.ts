/**
 * glob.ts — find files by name pattern.
 *
 * The model's way to discover paths it can then read or edit. Primary engine is
 * ripgrep (`rg --files -g <pattern>`): fast and .gitignore-aware. When `rg` isn't
 * installed it falls back to a pure-Node walk filtered by a compiled glob. A simple
 * shape: `pattern` + optional `path`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { relativize, searchUnits, type SearchUnit } from "./paths.js";
import { DEFAULT_IGNORES, globToRegExp, walkFiles } from "./walk.js";
import { SEARCH_EXCLUDE_GLOBS, excludedFromSearch, guardedPathReason } from "./guard.js";
import { noFiles } from "./emptyResult.js";
import { ripgrepAvailable, runRipgrep } from "./ripgrep.js";
import { fail, failQuietly } from "./results.js";

/** Cap on paths returned. Exported for the merged `search` tool's description. */
export const GLOB_MAX_RESULTS = 100;
const MAX_RESULTS = GLOB_MAX_RESULTS;

export const globDef: Tool = {
  name: "glob",
  readOnly: true,
  // Same failure as grep had: the model reads "No files found." as "this project does
  // not have that file", when .gitignore may simply have hidden it. Stated here so an
  // empty result is understood as a bounded search rather than a fact about the repo.
  description:
    "Find files whose path matches a glob pattern (e.g. `**/*.ts`, `src/**/*.{ts,tsx}`). " +
    "Returns matching file paths. Searches every session root unless `path` is given. " +
    "The pattern is matched against each file's path RELATIVE to the root being " +
    "searched, so `src/**/*.ts` works and a leading slash does not. " +
    "Files the project's .gitignore excludes are NOT listed, and neither are " +
    "node_modules or .git, so 'No files found' means it is not in the tracked tree, " +
    "not that it is absent from disk. Generated or built output usually falls in that " +
    `gap. Results stop after ${MAX_RESULTS} paths and say so when they do. ` +
    "Use grep instead when you care what is INSIDE files rather than what they are called.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match file paths against.",
      },
      path: {
        type: "string",
        description:
          "Directory (or a root's label) to search in. Defaults to all session roots. Omit to use the default.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) return failQuietly("`pattern` is required.");

    // Patterns are matched against a ROOT-RELATIVE path, which a leading slash can
    // never equal. Decided here rather than inside either engine because the two read
    // it differently: the Node matcher anchors the slash and finds nothing, while
    // ripgrep treats it as anchored-to-the-search-root and matches. Same call, same
    // project, two answers, depending only on whether `rg` was installed.
    if (pattern.startsWith("/")) {
      return { output: "No files found.", summary: `glob ${pattern} — no matches` };
    }

    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const units = searchUnits(ctx, rawPath);
    const haveRg = await ripgrepAvailable();

    const matched: string[] = [];
    for (const unit of units) {
      const dir = unit.sub ? join(unit.root, unit.sub) : unit.root;
      try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) {
          if (rawPath) return fail(`${rawPath} is not a directory.`);
          continue;
        }
      } catch {
        if (rawPath) return fail(`directory not found: ${rawPath}`);
        continue; // a missing root in a multi-root sweep is skipped, not fatal
      }
      // A directory named outright goes through the same guard grep applies. Without it the walk below
      // leaves a protected folder's contents out and answers "No files found.", which reads as an empty
      // folder where grep says it refuses.
      if (rawPath) {
        const blocked = await guardedPathReason(dir);
        if (blocked) return fail(`Refusing to search ${rawPath}: it is ${blocked}.`);
      }
      matched.push(...(haveRg ? await globViaRipgrep(pattern, unit, ctx) : await globViaWalk(pattern, unit, ctx)));
    }

    if (matched.length === 0) {
      return { output: noFiles(pattern, rawPath), summary: `glob ${pattern} — no matches` };
    }

    const truncated = matched.length > MAX_RESULTS;
    const lines = matched.slice(0, MAX_RESULTS);
    if (truncated) {
      lines.push(`… (${matched.length - MAX_RESULTS} more — narrow the pattern)`);
    }
    return {
      output: lines.join("\n"),
      summary: `glob ${pattern} (${matched.length} match${matched.length === 1 ? "" : "es"})`,
    };
  },
};

/** `rg --files -g` within one root. Emitted root-relative paths are re-labeled so
 *  they round-trip across roots (single-root: a plain relative path, unchanged). */
async function globViaRipgrep(pattern: string, unit: SearchUnit, ctx: ToolContext): Promise<string[]> {
  const args = ["--files", "--hidden", "--path-separator", "/"];
  // ORDER IS LOAD-BEARING. ripgrep's `-g` rules are last-match-wins, exactly like
  // .gitignore, so the caller's pattern MUST come first and the exclusions after it.
  // With the exclusions first, a pattern as ordinary as `**/*` matched last and
  // overrode every one of them, and `rg --files --hidden` then listed `.env` and
  // `id_rsa` outright. MEASURED both ways against a real rg before changing this.
  args.push("-g", pattern);
  for (const dir of DEFAULT_IGNORES) args.push("-g", `!${dir}`);
  // `--hidden` makes ripgrep descend into dot-directories, which is exactly where
  // secrets and other agents' saved sessions live. grep has always excluded them, on
  // the reasoning that a search must not surface what a direct read would refuse.
  // Listing a path is a weaker disclosure than printing its contents, but it is the
  // same disclosure in kind: it tells the model a secrets file exists and where. The
  // guard is only meaningful if every way of looking respects it.
  for (const excluded of SEARCH_EXCLUDE_GLOBS) args.push("-g", `!${excluded}`);
  args.push("--", unit.sub || ".");
  const res = await runRipgrep(args, unit.root);
  if (res.code !== 0 && res.code !== 1) return globViaWalk(pattern, unit, ctx); // fall back on rg failure
  return res.lines.map((line) => relativize(ctx, join(unit.root, line)));
}

/** Pure-Node fallback: walk one root and filter by the compiled glob; labeled output. */
async function globViaWalk(pattern: string, unit: SearchUnit, ctx: ToolContext): Promise<string[]> {
  const regexp = globToRegExp(pattern);
  const dir = unit.sub ? join(unit.root, unit.sub) : unit.root;
  const { files } = await walkFiles(dir, 20_000);
  // The same exclusions the ripgrep path applies, so the two engines cannot disagree
  // about what is allowed to be seen.
  return files
    .filter((f) => !excludedFromSearch(f.abs))
    .filter((f) => regexp.test(f.rel))
    .map((f) => relativize(ctx, f.abs));
}

