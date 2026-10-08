/**
 * grep.ts — search file contents with a regular expression.
 *
 * Primary engine is ripgrep: precise, fast, .gitignore-aware,
 * and it never loads the project into the agent — only matches come back. When
 * `rg` isn't installed we fall back to a pure-Node walk so search still works.
 *
 * The interface is a familiar, predictable search shape — `pattern`, `path`, `glob`,
 * `output_mode`, `ignore_case`, `context` — so any model can drive it reliably.
 *
 * That flag was literally named `-i` until an audit pointed out it was the only
 * parameter in the whole registry whose name started with a dash. JSON Schema permits
 * it, but function-calling implementations vary in how they handle a property name
 * that looks like a CLI flag, and a parameter the model cannot reliably send is worse
 * than a slightly longer name. It reads better spelled out anyway.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { isMultiRoot, nextTouch, relativize, resolvePath, rootLabel, rootsOf, searchUnits, type SearchUnit, markScope } from "./paths.js";
import { addFocus } from "./focus.js";
import { DEFAULT_IGNORES, globToRegExp, walkFiles } from "./walk.js";
import { SEARCH_EXCLUDE_GLOBS, excludedFromSearch, guardedPathReason } from "./guard.js";
import { ripgrepAvailable, runRipgrep } from "./ripgrep.js";
import { fail, failQuietly } from "./results.js";

const MAX_FILES = 5_000;
/** Cap on matching lines returned. Exported so the merged `search` tool states the
 *  same number in its description instead of drifting from it. */
export const GREP_MAX_OUTPUT_LINES = 250;
const MAX_OUTPUT_LINES = GREP_MAX_OUTPUT_LINES;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Mode = "files_with_matches" | "content" | "count";

export const grepDef: Tool = {
  name: "grep",
  readOnly: true,
  // The old description named the modes and stopped, which left the model to read an
  // empty result as "that string is not in this codebase". It often is: .gitignore is
  // respected, so build output and generated code are invisible, and secrets and other
  // agents' data are refused outright. A wrong "it does not exist" is worse than a slow
  // search, because the model acts on it. The regex-flavour line matters for the same
  // reason: a lookahead pattern fails with an error the model reads as "no matches".
  description:
    "Search file contents with a regular expression. `output_mode` is " +
    "'files_with_matches' (default, just paths), 'content' (matching lines), or " +
    "'count'. Searches every session root unless `path` (a file, directory, or root label) is given. " +
    "WHAT IS NOT SEARCHED, so an empty result is NOT proof a string is absent: anything " +
    "the project's .gitignore excludes (build output, dist, generated code), node_modules " +
    "and .git always, and secrets (.env, keys) plus other coding agents' data, which are " +
    "refused rather than missing. If what you need lives in one of those, read the file " +
    "directly instead of concluding it is not there. " +
    "Avoid lookahead, lookbehind and backreferences; the search engine rejects them. " +
    "Character classes, groups, alternation and anchors are all fine. " +
    `Output stops after ${MAX_OUTPUT_LINES} matching lines. When it does it tells you the ` +
    "`offset` to pass for the next page, so a capped search is something to continue, not " +
    "a reason to start reading whole files. " +
    "`multiline` lets a pattern cross line breaks, which is how you find a construct that " +
    "is not on one line. " +
    "To find the uses of a symbol you can NAME, try references first: it reads parsed " +
    "code rather than raw text, so a mention in a comment or a string is not a match. " +
    "Come back here when it reports a name-level answer and exact identity matters.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "The regular expression to search for." },
      path: {
        type: "string",
        description: "File, directory, or root label to search. Defaults to all session roots.",
      },
      glob: {
        type: "string",
        description: 'Only search files whose path matches this glob (e.g. "*.ts").',
      },
      output_mode: {
        type: "string",
        enum: ["files_with_matches", "content", "count"],
        description: "What to return. Defaults to files_with_matches.",
      },
      ignore_case: { type: "boolean", description: "Case-insensitive search." },
      context: {
        type: "integer",
        minimum: 0,
        description: "Lines of context to show before and after each match (content mode).",
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
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) return failQuietly("`pattern` is required.");

    const mode: Mode =
      args.output_mode === "content" || args.output_mode === "count"
        ? args.output_mode
        : "files_with_matches";
    // Context is asymmetric. A symmetric window is the wrong shape for the commonest
    // question a search asks — "what IS this thing" — where the answer is the lines
    // AFTER the declaration and the lines before are the end of something unrelated.
    const context = nonNegative(args.context);
    const before = nonNegative(args.before) || context;
    const after = nonNegative(args.after) || context;
    const multiline = args.multiline === true;
    // Paging. Without it, a search that hits the cap could only be narrowed — and when
    // the model could not narrow it, its remaining move was to read whole files, which
    // is the expensive habit this tool exists to prevent.
    const headLimit = typeof args.head_limit === "number" && args.head_limit >= 0 ? Math.floor(args.head_limit) : undefined;
    const offset = nonNegative(args.offset);
    const caseInsensitive = args.ignore_case === true;
    const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;

    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const units = searchUnits(ctx, rawPath);
    const haveRg = await ripgrepAvailable();

    // Gather labeled result lines across every root, then format once.
    const lines: string[] = [];
    for (const unit of units) {
      const target = unit.sub ? join(unit.root, unit.sub) : unit.root;
      let stat;
      try {
        stat = await fs.stat(target);
      } catch {
        if (rawPath) return fail(`path not found: ${rawPath}`);
        continue; // a missing root in a multi-root sweep is skipped, not fatal
      }
      // A walk leaves secrets out, but a target named outright was searched as given: a
      // search pointed at .env returned its lines. The target itself goes through the
      // same guard a read does, which also catches a folder that is a link to .ssh.
      if (rawPath) {
        const blocked = await guardedPathReason(target);
        if (blocked) return fail(`Refusing to search ${rawPath}: it is ${blocked}.`);
      }
      const o: GrepOpts = { pattern, mode, before, after, multiline, caseInsensitive, glob, ctx, unit, isFile: stat.isFile() };
      const got = haveRg ? await grepViaRipgrep(o) : await grepViaWalk(o);
      if (got.invalid) return failQuietly(got.invalid);
      lines.push(...got.lines);
    }

    // Keep what the search found. Without this a grep is the one useful thing the model
    // can do that leaves NOTHING behind: its result lives only in the transcript, which
    // keeps the last 8 tool results and sweeps to 2 at a task boundary, while a read leaves
    // its file in the read ledger. Left alone, the harness teaches, mechanically, that
    // reading sticks and searching does not, and the model reads, narrowly and repeatedly,
    // where one search would have answered it.
    if (mode === "content" && lines.length > 0) await recordSearchHits(ctx, lines);

    return formatGrep(mode, pattern, lines, headLimit, offset);
  },
};

/** How many distinct files one search may put into the working set. */
const SEARCH_FOCUS_FILES = 5;
/** How many hits per file are worth keeping — beyond a handful it is a read, not a hit. */
const SEARCH_FOCUS_SPANS = 4;
/** Lines of context kept either side of a hit, so the match is readable in place. */
const SEARCH_FOCUS_PAD = 2;
/** `path:LINE:text` — a ripgrep/walk content hit. Context rows use `-` and are skipped. */
const CONTENT_HIT = /^(.+?):(\d+):/;

/**
 * Record a bounded focus span around each hit, so the regions a search found ride in the
 * working set the same way a read's do.
 *
 * BOUNDED on both axes: a broad search must not swamp the block with regions the model
 * never asked to keep. And marked `viaSearch`, because a grep shows matching lines, never
 * the file — the read-before-write gates must not open on the strength of it.
 */
async function recordSearchHits(ctx: ToolContext, lines: readonly string[]): Promise<void> {
  const hits = new Map<string, number[]>();
  for (const line of lines) {
    const m = CONTENT_HIT.exec(line);
    if (!m) continue;
    const at = hits.get(m[1]!);
    if (at) {
      if (at.length < SEARCH_FOCUS_SPANS) at.push(Number(m[2]));
    } else if (hits.size < SEARCH_FOCUS_FILES) {
      hits.set(m[1]!, [Number(m[2])]);
    }
  }

  for (const [display, at] of hits) {
    let abs: string;
    try {
      abs = resolvePath(ctx, display);
    } catch {
      continue; // a label that doesn't round-trip is not worth guessing at
    }
    const prior = ctx.reads.get(abs);
    let focus = prior?.focus;
    for (const n of at) {
      focus = addFocus(focus, { start: Math.max(1, n - SEARCH_FOCUS_PAD), end: n + SEARCH_FOCUS_PAD });
    }
    if (prior) {
      // The recorded stat says what the model was last SHOWN, and matching inside a file
      // does not change that — leave it alone so read_file's freshness check stays true.
      prior.touchedAt = nextTouch();
      if (focus) prior.focus = focus;
      continue;
    }
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      markScope(ctx, abs);
      ctx.reads.set(abs, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        full: false,
        touchedAt: nextTouch(),
        viaSearch: true,
        ...(focus ? { focus } : {}),
      });
    } catch {
      // Gone between the search and now — nothing to carry.
    }
  }
}

interface GrepOpts {
  pattern: string;
  mode: Mode;
  /** Lines kept BEFORE each match. */
  before: number;
  /** Lines kept AFTER each match. */
  after: number;
  /** Match across line boundaries (`.` spans newlines). */
  multiline: boolean;
  caseInsensitive: boolean;
  glob: string | undefined;
  ctx: ToolContext;
  unit: SearchUnit;
  isFile: boolean;
}

/** One unit's labeled output lines, or an `invalid` regex message to surface. */
interface UnitResult {
  lines: string[];
  invalid?: string;
}

/** Combine all roots' labeled lines into the final tool result, capped per mode. */
/**
 * Render the gathered lines, honouring the caller's window.
 *
 * The window is the point. Before it existed, a search that hit the cap could only say
 * "narrow the search" — and when the model could not narrow it (a common identifier, a
 * broad question), its remaining move was to read whole files. Being able to ask for the
 * NEXT page turns a capped result from a dead end into a continuation, which is the
 * difference between locating something and giving up and reading everything.
 */
function formatGrep(
  mode: Mode,
  pattern: string,
  lines: string[],
  headLimit: number | undefined,
  offset: number,
): ToolResult {
  if (lines.length === 0) {
    return { output: "No matches found.", summary: `grep ${pattern} — no matches` };
  }
  if (mode === "count") {
    let total = 0;
    for (const line of lines) {
      const n = parseInt(line.slice(line.lastIndexOf(":") + 1), 10);
      if (!isNaN(n)) total += n;
    }
    return { output: lines.join("\n"), summary: `grep ${pattern} (${total} in ${lines.length} files)` };
  }

  // `head_limit: 0` means "no limit" and must not collapse into the default, so unset
  // and zero stay distinguishable rather than being defaulted away.
  const ceiling = mode === "content" ? MAX_OUTPUT_LINES : 100;
  const limit = headLimit === undefined ? ceiling : headLimit === 0 ? lines.length : Math.min(headLimit, ceiling);
  const page = lines.slice(offset, offset + limit);
  const shown = offset + page.length;
  const noun = mode === "content" ? "line" : "file";

  if (page.length === 0) {
    return {
      output: `No further matches: offset ${offset} is past the ${lines.length} ${noun}s found.`,
      summary: `grep ${pattern} — offset past the end`,
    };
  }
  const out = [...page];
  // Say what is left AND how to reach it. "Narrow the search" on its own was advice the
  // model frequently could not take.
  if (shown < lines.length) {
    out.push(
      `… (${lines.length - shown} more ${noun}s — pass offset: ${shown} for the next page, or narrow the search)`,
    );
  }
  return {
    output: out.join("\n"),
    summary: `grep ${pattern} (${lines.length} ${noun}${lines.length === 1 ? "" : "s"})`,
  };
}

// ── ripgrep path (primary) ────────────────────────────────────────────────────
async function grepViaRipgrep(o: GrepOpts): Promise<UnitResult> {
  const args: string[] = ["--hidden", "--path-separator", "/"];
  // ORDER IS LOAD-BEARING: ripgrep's `-g` rules are last-match-wins. The caller's own
  // glob therefore has to be registered BEFORE the exclusions, or a filter as ordinary
  // as `**/*` matches last and cancels every guard below it.
  if (o.glob) args.push("-g", o.glob);
  // Skip the same noise directories the walk does, regardless of .gitignore.
  for (const dir of DEFAULT_IGNORES) args.push("-g", `!${dir}`);
  // `--hidden` above means ripgrep would otherwise descend into dot-directories,
  // which is exactly where secrets and other agents' saved sessions live. Exclude
  // them so a search can't print what a direct read would refuse.
  for (const pattern of SEARCH_EXCLUDE_GLOBS) args.push("-g", `!${pattern}`);

  if (o.caseInsensitive) args.push("-i");
  if (o.mode === "files_with_matches") args.push("-l");
  else if (o.mode === "count") args.push("-c");
  else {
    args.push("-n", "--max-columns", "500");
    if (o.before > 0) args.push("-B", String(o.before));
    if (o.after > 0) args.push("-A", String(o.after));
  }
  // `--multiline-dotall` is what makes the flag useful: without it `.` still stops at a
  // newline, so a pattern spanning lines only matches if it spells out every break.
  if (o.multiline) args.push("-U", "--multiline-dotall");
  args.push("-e", o.pattern);
  // Run FROM the unit's root so emitted paths are root-relative; we label them below.
  args.push("--", o.unit.sub || ".");

  const res = await runRipgrep(args, o.unit.root);

  if (res.code === 2) {
    return { lines: [], invalid: `invalid regular expression or search options: ${res.stderr || o.pattern}` };
  }
  if (res.code !== 0 && res.code !== 1) {
    return grepViaWalk(o); // some other failure — fall back to the pure-Node walk
  }
  // Multi-root: prefix the root label so every path round-trips (a `--` group
  // separator is left alone). Single-root: the lines are already cwd-relative.
  // Searching `.` makes ripgrep emit `./a.txt`, so labelling produced `rootA/./a.txt`
  // and the path no longer round-tripped back to a root. The walk path never had the
  // `./`, so the two engines also printed different paths for the same hit.
  const prefix = isMultiRoot(o.ctx) ? `${rootLabel(rootsOf(o.ctx), o.unit.root)}/` : "";
  const clean = res.lines.map((l) => (l === "--" ? l : l.replace(/^\.\//, "")));
  const lines = prefix ? clean.map((l) => (l === "--" ? l : prefix + l)) : clean;
  return { lines };
}

// ── pure-Node walk (fallback when rg is unavailable) ──────────────────────────
async function grepViaWalk(o: GrepOpts): Promise<UnitResult> {
  let regexp: RegExp;
  try {
    // `s` (dotAll) alongside `g` is what makes multiline useful: without dotAll `.` still
    // refuses to cross a newline, so the flag would be accepted and quietly do nothing —
    // a capability the tool claims and does not have.
    const flags = `${o.caseInsensitive ? "i" : ""}${o.multiline ? "gs" : ""}`;
    regexp = new RegExp(o.pattern, flags || undefined);
  } catch (error) {
    return { lines: [], invalid: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}` };
  }

  const target = o.unit.sub ? join(o.unit.root, o.unit.sub) : o.unit.root;
  let files: { abs: string; rel: string }[];
  if (o.isFile) {
    files = excludedFromSearch(target) ? [] : [{ abs: target, rel: relativize(o.ctx, target) }];
  } else {
    const walked = await walkFiles(target, MAX_FILES);
    // Same exclusions the ripgrep path applies, for the no-ripgrep fallback.
    files = walked.files.filter((f) => !excludedFromSearch(f.abs));
    if (o.glob) {
      const g = globToRegExp(o.glob);
      files = files.filter((f) => g.test(f.rel));
    }
  }

  const out: string[] = [];
  let truncated = false;
  for (const file of files) {
    if (truncated) break;
    let text: string;
    try {
      const buf = await fs.readFile(file.abs);
      if (buf.length > MAX_FILE_BYTES || isBinary(buf)) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }

    const lines = text.split("\n");
    let fileCount = 0;

    // MULTILINE: match against the WHOLE file, then map each match's character offset
    // back to a line number. Matching line by line cannot see a construct that spans a
    // break at all, which is the entire reason the flag exists.
    if (o.multiline) {
      regexp.lastIndex = 0;
      for (let m = regexp.exec(text); m !== null; m = regexp.exec(text)) {
        fileCount++;
        if (o.mode === "content") {
          const startLine = text.slice(0, m.index).split("\n").length - 1;
          const endLine = startLine + (m[0].split("\n").length - 1);
          const lo = Math.max(0, startLine - o.before);
          const hi = Math.min(lines.length - 1, endLine + o.after);
          for (let j = lo; j <= hi; j++) {
            out.push(`${relativize(o.ctx, file.abs)}:${j + 1}:${lines[j]}`);
            if (out.length >= MAX_OUTPUT_LINES) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
        // A zero-width match never advances lastIndex, so this would spin forever.
        if (m[0].length === 0) regexp.lastIndex++;
      }
      if (fileCount > 0 && o.mode === "files_with_matches") out.push(relativize(o.ctx, file.abs));
      if (fileCount > 0 && o.mode === "count") out.push(`${relativize(o.ctx, file.abs)}:${fileCount}`);
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      if (!regexp.test(lines[i])) continue;
      fileCount++;
      if (o.mode === "content") {
        const lo = Math.max(0, i - o.before);
        const hi = Math.min(lines.length - 1, i + o.after);
        for (let j = lo; j <= hi; j++) {
          out.push(`${relativize(o.ctx, file.abs)}:${j + 1}:${lines[j]}`);
          if (out.length >= MAX_OUTPUT_LINES) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
    }
    if (fileCount > 0 && o.mode === "files_with_matches") out.push(relativize(o.ctx, file.abs));
    if (fileCount > 0 && o.mode === "count") out.push(`${relativize(o.ctx, file.abs)}:${fileCount}`);
  }
  return { lines: out };
}

/** A NUL byte in the first chunk is a cheap, reliable "not text" signal. */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** A non-negative whole number from a tool argument, or 0. */
function nonNegative(v: unknown): number {
  return typeof v === "number" && v > 0 ? Math.floor(v) : 0;
}

