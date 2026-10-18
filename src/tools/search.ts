/**
 * search.ts — the one way to find things: by what is inside files, or by what they
 * are called.
 *
 * These were `grep`, `glob` and `list_dir`. Three tools answering one question —
 * "where is it?" — differing only in where they look: inside files, at their paths, or
 * at a directory as it sits on disk. The model had to pick before it could start, and
 * the common move (find the files, then search them) meant two calls and a decision
 * the arguments already imply.
 *
 * One tool, and the arguments say what is meant:
 *
 *   search({ pattern })          → search file CONTENTS for a regex
 *   search({ files })            → find files whose PATH matches a glob
 *   search({ pattern, files })   → search contents, but only in files matching
 *   search({ path }) / search({})→ LIST that directory (or every root), one level
 *
 * The third line is why merging is worth more than tidiness: it collapses the
 * find-then-search pair into one call, and it was already possible (grep's `glob`
 * argument), just hidden behind having to know both tools. The fourth removes the
 * only remaining no-op call: asking for nothing in particular now means "show me what
 * is here", which is what a model reaching for a listing wanted anyway.
 *
 * All three implementations are untouched and still live in `grep.ts`, `glob.ts` and
 * `listDir.ts`; this only decides which one a call meant. They are genuinely different
 * machines underneath — one reads file contents, one only ever looks at paths, and the
 * listing reports the DISK rather than the searchable tree — and pretending otherwise
 * in the code would be worse than the three tools were.
 *
 * Read-only, and QUIET: it never renders a row. Searching is how the agent finds its
 * way around, not work done to the project, and the user asked for it to stay out of
 * the stream. The model still gets the full result.
 */
import type { Tool, ToolResult } from "./types.js";
import { FULL_DETAIL_MAX, capLines } from "./detail.js";
import { grepDef, GREP_MAX_OUTPUT_LINES } from "./grep.js";
import { globDef, GLOB_MAX_RESULTS } from "./glob.js";
import { listDir, MAX_ENTRIES } from "./listDir.js";

export const search: Tool = {
  name: "search",
  readOnly: true,
  description:
    "Find things in the project. Pass `pattern` to search file CONTENTS with a regular " +
    "expression, or `files` to find files by PATH, or both to search contents only " +
    "within files whose path matches — which saves a separate lookup first. Pass " +
    "NEITHER to LIST what is there, one level deep.\n" +
    "CONTENTS (`pattern`): `output_mode` is 'files_with_matches' (default, just paths), " +
    "'content' (matching lines), or 'count'. Avoid lookahead, lookbehind and " +
    "backreferences; the search engine rejects them. Character classes, groups, " +
    "alternation and anchors are all fine. `multiline` lets a pattern cross line breaks, " +
    "which is how you find a construct that is not on one line (a signature and its body, " +
    `an object literal, a JSX block). Output stops after ${GREP_MAX_OUTPUT_LINES} matching ` +
    "lines and tells you the `offset` to pass for the next page — a capped search is " +
    "something to CONTINUE, not a reason to start reading whole files. Use `after` when " +
    "you want what follows a match (a declaration's body) rather than a symmetric window.\n" +
    `PATHS (\`files\`): a glob like \`**/*.ts\` or \`src/**/*.{ts,tsx}\`, matched against ` +
    "each file's path RELATIVE to the root being searched, so a leading slash does not " +
    `work. Results stop after ${GLOB_MAX_RESULTS} paths and say so when they do.\n` +
    "LISTING (neither argument): the immediate contents of `path`, one level, not " +
    "recursive — or of every session root if you give no path. Entries come directories " +
    "first, then alphabetically. A trailing slash means a directory. `(symlink)` marks a " +
    "link, and it still gets the slash when it points at a directory; `(broken symlink)` " +
    "means the target is gone. `(skipped by search)` marks a directory that is really " +
    "there but that the two searches above will not descend into, which is why a file " +
    `inside it can exist and never appear in a search. Listings stop after ${MAX_ENTRIES} ` +
    "entries and say how many were left out.\n" +
    "Searches every session root unless `path` (a file, directory, or root label) is given.\n" +
    "WHAT IS NOT SEARCHED, so an empty result is NOT proof something is absent: anything " +
    "the project's .gitignore excludes (build output, dist, generated code), node_modules " +
    "and .git always, and secrets (.env, keys) plus other coding agents' data, which are " +
    "refused rather than missing. If what you need lives in one of those, read the file " +
    "directly instead of concluding it is not there. LISTING is the exception and the " +
    "reason to reach for it: it reports the DISK, so ignored build output, secrets and " +
    "other agents' folders all appear. Seeing something listed is not a promise you may " +
    "open it — read_file still refuses secrets and asks before another agent's data. " +
    "Treat a listing as evidence of what exists, and let the read decide what you see.\n" +
    "To find the uses of a symbol you can NAME, try references first: it reads parsed " +
    "code rather than raw text, so a mention in a comment or a string is not a match. " +
    "Come back here when it reports a name-level answer and exact identity matters.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression to search file CONTENTS for. Omit to search by path only.",
      },
      files: {
        type: "string",
        description:
          'Glob for file paths (e.g. "**/*.ts"). Alone: find files by name. With `pattern`: ' +
          "search contents only inside these files.",
      },
      path: {
        type: "string",
        description:
          "File, directory, or root label to search — or, with neither `pattern` nor " +
          "`files`, the directory to list. Defaults to all session roots.",
      },
      output_mode: {
        type: "string",
        enum: ["files_with_matches", "content", "count"],
        description: "Contents search only. What to return. Defaults to files_with_matches.",
      },
      ignore_case: { type: "boolean", description: "Contents search only. Case-insensitive." },
      context: {
        type: "integer",
        minimum: 0,
        description: "Contents search only. Lines of context around each match (content mode).",
      },
      before: {
        type: "integer",
        minimum: 0,
        description: "Lines to show BEFORE each match (content mode). Overrides `context` on that side.",
      },
      after: {
        type: "integer",
        minimum: 0,
        description: "Lines to show AFTER each match (content mode). Overrides `context` on that side.",
      },
      multiline: {
        type: "boolean",
        description:
          "Let the pattern span line breaks, with `.` matching newlines too. Off by default. " +
          "Use it for constructs that are not on one line — a function signature and its body, " +
          "an object literal, a JSX block.",
      },
      head_limit: {
        type: "integer",
        minimum: 0,
        description:
          "Return at most this many results. 0 means no limit. Defaults to the cap below.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description:
          "Skip this many results first — page through a capped search instead of narrowing it. " +
          "The result tells you the offset to pass next.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    const files = typeof args.files === "string" ? args.files.trim() : "";

    // Contents search. `files` becomes the path filter it always was under grep's own
    // `glob` argument — the merge is what makes that reachable without knowing two tools.
    //
    // Neither argument is no longer an error: nothing to match by means "show me what
    // is here", which is what a model reaching for a listing meant anyway.
    const result = pattern
      ? await grepDef.execute({ ...args, pattern, ...(files ? { glob: files } : {}) }, ctx)
      : files
        ? await globDef.execute({ ...args, pattern: files }, ctx)
        : await listDir.execute({ ...(args.path ? { path: args.path } : {}) }, ctx);

    // Quiet is applied HERE, on every path including errors, rather than inside either
    // implementation. One tool, one display policy — and a failed search is exactly the
    // row most likely to creep back onto the screen if each branch decided for itself.
    // The words behind the row's click: what the search printed, which the model got whole.
    const printed = result.isError || result.detail ? undefined : capLines(result.output.split("\n"), FULL_DETAIL_MAX);
    return { ...result, quiet: true, ...(printed ? { detail: printed, detailKind: "text" as const } : {}) };
  },
};
