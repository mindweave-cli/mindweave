/**
 * forbidden.ts — the user's per-project deny-list, enforced mechanically.
 *
 * This is the strong half of "forbidden": besides being told in the prompt, the
 * mutating tools call these pure checks before acting, so a forbidden file
 * literally cannot be edited/overwritten and a command that names a forbidden
 * path is refused. It's the user-defined sibling of guard.ts's built-in
 * protected-paths list — same shape (reason string or null), same fail-open rule
 * (anything not matched is allowed).
 *
 * Format of `forbidden.md` (one pattern per line; `#` comments and blanks
 * ignored): gitignore-style globs relative to the project root —
 *   src/legacy/**        # a folder and everything under it
 *   config/prod.json     # a single file
 *   *.pem                # a glob
 * A leading `/` or `./` is tolerated and treated as project-relative.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { globToRegExp, literalPrefix } from "./glob.js";
import type { ForbiddenConfig } from "./types.js";
import { realPathOf } from "../tools/guard.js";

/** Parse the raw text of a forbidden.md into a clean pattern list. */
export function parseForbidden(text: string): string[] {
  const patterns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Normalize a leading `/` or `./` to a plain project-relative pattern.
    const cleaned = trimmed.replace(/^\.?\//, "").replace(/\/+$/, "");
    if (cleaned) patterns.push(cleaned);
  }
  return patterns;
}

/** Parse the raw text of a forbidden-commands.md into a clean pattern list. Unlike
 *  path patterns these are command fragments, so there is NO path normalization —
 *  a line is kept verbatim (trimmed), minus `#` comments and blanks. */
export function parseForbiddenCommands(text: string): string[] {
  const patterns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

/**
 * If `command` matches a forbidden command pattern, return the pattern (for the
 * message); otherwise null. Match is case-insensitive on whitespace-collapsed text,
 * so `tauri dev` blocks `npm run tauri  dev` alike. Deterministic and strict by
 * design — the model cannot run a forbidden command; only the user can lift it.
 */
/**
 * Parse `forbidden-mcp-tools.md` into tool names. Verbatim like commands, not
 * path-normalized: an MCP tool name is an identifier, not a path.
 */
export function parseForbiddenMcpTools(text: string): string[] {
  return parseForbiddenCommands(text);
}

/**
 * Compile one command pattern into a word-boundary matcher (pure).
 *
 * A bare substring test is what this used to do, and it over-blocks badly on short
 * patterns: forbidding `rm` also refused `npm run warm` and `npm run format`, which
 * reads as the agent being broken rather than as a rule firing.
 *
 * Two details make the boundary version actually work:
 *
 *  - The pattern is user text and can hold regex metacharacters (`c++`, `a|b`), so it
 *    is escaped before it becomes a pattern.
 *  - `\b` is defined between a word character and a non-word one, so a pattern that
 *    starts or ends with something else (`-rf`, `./deploy`, `--force`) would never
 *    match with `\b` glued on. The boundary is therefore applied only at an edge that
 *    is itself a word character; other edges match anywhere, which is correct because
 *    the neighbouring character is already punctuation.
 */
export function commandPatternRegExp(pattern: string): RegExp | null {
  const pat = pattern.toLowerCase().replace(/\s+/g, " ").trim();
  if (!pat) return null;
  const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^\w/.test(pat) ? "\\b" : "";
  const right = /\w$/.test(pat) ? "\\b" : "";
  return new RegExp(`${left}${escaped}${right}`);
}

export function forbiddenCommandPatternReason(
  cfg: ForbiddenConfig | undefined,
  command: string,
): string | null {
  const commands = cfg?.commands;
  if (!commands || commands.length === 0) return null;
  // Whitespace is collapsed on BOTH sides, so `tauri dev` still blocks
  // `npm run tauri  dev` — the run of spaces in the command becomes one.
  const norm = command.toLowerCase().replace(/\s+/g, " ");
  for (const raw of commands) {
    const re = commandPatternRegExp(raw);
    if (re && re.test(norm)) return raw;
  }
  return null;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

// Compiled form of one pattern: its regex and its literal prefix.
interface Compiled {
  raw: string;
  re: RegExp;
  prefix: string;
}

// Cache compilation per `patterns` array (tiny lists, but checks run per
// edit/write/command). Keyed on the array identity, which is stable for a session.
const cache = new WeakMap<string[], Compiled[]>();

function compile(patterns: string[]): Compiled[] {
  let compiled = cache.get(patterns);
  if (!compiled) {
    compiled = patterns.map((raw) => ({ raw, re: globToRegExp(raw), prefix: literalPrefix(raw) }));
    cache.set(patterns, compiled);
  }
  return compiled;
}

/**
 * If `absPath` is forbidden, return the pattern that matched (for the message);
 * otherwise null. Paths outside the project root are never matched by relative
 * patterns. `cfg` may be undefined (no forbidden list) → always allow.
 */
export function forbiddenPathReason(
  cfg: ForbiddenConfig | undefined,
  absPath: string,
  roots: readonly string[] = [],
): string | null {
  if (!cfg || cfg.patterns.length === 0) return null;
  const abs = isAbsolute(absPath) ? absPath : resolve(cfg.root, absPath);

  // EVERY root in the workspace, not just the one the project started in.
  //
  // A pattern is written relative to a project, and a session can hold several once
  // `/include` has added a folder. Judging only against the primary meant a rule that
  // blocked `src/legacy` in the project you opened silently did nothing in the folder
  // you added, which is the shape of failure a deny-list can least afford: the rule is
  // still listed, still shown by `/forbidden`, and simply not in force.
  //
  // Erring towards denying is deliberate and the same call made for case folding. A
  // pattern that matches something in an included folder the user did not have in mind
  // costs one refusal they can adjust; the other direction costs the protection itself.
  for (const base of [cfg.root, ...roots]) {
    const hit = matchUnderRoot(cfg, abs, base);
    if (hit) return hit;
  }
  return null;
}

/**
 * `forbiddenPathReason`, also judged by where the path really leads. A link inside the
 * project to a forbidden folder (`docs` pointing at `src/legacy`) reached it under a name
 * no pattern matched. The real path is compared with the real roots, links resolved on
 * both sides.
 */
export async function forbiddenRealPathReason(
  cfg: ForbiddenConfig | undefined,
  absPath: string,
  roots: readonly string[] = [],
): Promise<string | null> {
  const textual = forbiddenPathReason(cfg, absPath, roots);
  if (textual || !cfg || cfg.patterns.length === 0) return textual;
  const real = await realPathOf(isAbsolute(absPath) ? absPath : resolve(cfg.root, absPath));
  for (const base of [cfg.root, ...roots]) {
    const hit = matchUnderRoot(cfg, real, await realPathOf(base));
    if (hit) return hit;
  }
  return null;
}

/** Test one absolute path against the patterns, read relative to `base`. */
function matchUnderRoot(cfg: ForbiddenConfig, abs: string, base: string): string | null {
  const rel = toPosix(relative(base, abs));
  if (rel === "" || rel.startsWith("..")) return null; // the root itself / outside it

  for (const { raw, re, prefix } of compile(cfg.patterns)) {
    if (re.test(rel)) return raw;
    // A bare folder/file prefix matches the path itself and anything under it,
    // so `src/legacy` forbids `src/legacy` and `src/legacy/x.ts` alike.
    // Case-folded, matching globToRegExp: on Windows and macOS `src/Legacy` IS
    // `src/legacy`, and a sensitive compare let the other spelling through.
    const lower = prefix.toLowerCase();
    const relLower = rel.toLowerCase();
    if (prefix && (relLower === lower || relLower.startsWith(lower + "/"))) return raw;
  }
  return null;
}

/**
 * If `command` references a forbidden path, return the pattern that matched;
 * otherwise null. Best a static check can do for a shell: if a forbidden
 * pattern's literal portion appears anywhere in the command string, refuse it
 * (the chosen strict policy — better a false positive the user can adjust than a
 * silent shell bypass of a forbidden file).
 */
export function forbiddenCommandReason(cfg: ForbiddenConfig | undefined, command: string): string | null {
  if (!cfg || cfg.patterns.length === 0) return null;
  for (const { raw, prefix } of compile(cfg.patterns)) {
    // Need a meaningful literal to scan for; a pure-glob pattern like `*.pem`
    // has prefix "" and can't be located in free-form command text.
    // Case-folded like the path check. `cat SRC/LEGACY/keys` names the same file on
    // Windows as `src/legacy/keys`, and a sensitive scan is the shell bypass this
    // function exists to prevent, spelled slightly differently.
    if (prefix.length >= 2 && command.toLowerCase().includes(prefix.toLowerCase())) return raw;
  }
  return null;
}
