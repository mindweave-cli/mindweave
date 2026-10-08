/**
 * commandPolicy.ts — decisions about a shell command, made from the commands it contains.
 *
 * Built on commandParse.ts. Three things, each of which regular expressions over the raw
 * text could not do:
 *
 *   1. Which commands are plainly harmless, so Sentinel mode does not ask about them.
 *      Every run_command was a question, which teaches people to answer "yes" without
 *      reading. A command is waved through only when EVERY part of it is a known
 *      read-only command with arguments that cannot write or run anything, nothing in it
 *      is expanded or unreadable, and it writes no file. Anything else keeps its question.
 *   2. The user's own rules by command prefix: allow, prompt or forbid, with a reason the
 *      model is shown ("use X instead").
 *   3. Which protected file a command NAMES, whatever it does with it. The old check only
 *      knew the verbs `cat` and `type`, so `cp .env notes.txt` followed by reading the copy,
 *      or `curl -F f=@key.pem`, got a secret out. Naming a protected path as something to
 *      read, copy out or send is refused; naming it as a destination, or as the target of
 *      a listing or a deletion, is not.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseCommand, verbOf, type Dialect, type ParsedCommand, type SimpleCommand } from "./commandParse.js";
import { expandHomeWords, guardedPathReason, protectedPathReason } from "./guard.js";

// ── the user's rules ────────────────────────────────────────────────────────

export type RuleDecision = "allow" | "prompt" | "forbid";

/** One line of command-rules.md: `<allow|prompt|forbid> <words…> [:: why]`. */
export interface CommandRule {
  decision: RuleDecision;
  /** The command prefix: `git push` matches `git push origin main`. */
  words: string[];
  /** Shown to the model when a forbidden command is refused, to steer it elsewhere. */
  justification?: string;
}

/** Parse command-rules.md (pure). Lines starting with # and malformed lines are ignored. */
export function parseCommandRules(text: string): CommandRule[] {
  const rules: CommandRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [head, ...why] = line.split("::");
    const parts = head!.trim().split(/\s+/);
    const decision = parts.shift()?.toLowerCase();
    const alias = decision === "forbidden" ? "forbid" : decision === "ask" ? "prompt" : decision;
    if (alias !== "allow" && alias !== "prompt" && alias !== "forbid") continue;
    if (parts.length === 0) continue;
    const justification = why.join("::").trim();
    rules.push({ decision: alias, words: parts, ...(justification ? { justification } : {}) });
  }
  return rules;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Does `rule` apply to `cmd`? The program must match, and then the next words in order. */
export function ruleMatches(rule: CommandRule, cmd: SimpleCommand): boolean {
  if (rule.words.length === 0 || cmd.words.length < rule.words.length) return false;
  if (!same(verbOf({ ...cmd, words: [rule.words[0]!] }), verbOf(cmd))) return false;
  return rule.words.slice(1).every((w, i) => same(w, cmd.words[i + 1] ?? ""));
}

export interface RuleVerdict {
  /** The first forbid rule any part of the command matches. */
  forbid?: CommandRule;
  /** The first prompt rule any part matches. */
  prompt?: CommandRule;
  /** Every part of the command is covered by an allow rule. */
  allAllowed: boolean;
}

export function ruleVerdict(parsed: ParsedCommand, rules: readonly CommandRule[]): RuleVerdict {
  let forbid: CommandRule | undefined;
  let prompt: CommandRule | undefined;
  let allAllowed = parsed.commands.length > 0;
  for (const cmd of parsed.commands) {
    const hits = rules.filter((r) => ruleMatches(r, cmd));
    forbid ??= hits.find((r) => r.decision === "forbid");
    prompt ??= hits.find((r) => r.decision === "prompt");
    // A prompt or forbid rule on the same command beats an allow.
    if (!hits.some((r) => r.decision === "allow") || hits.some((r) => r.decision !== "allow")) allAllowed = false;
  }
  return { ...(forbid ? { forbid } : {}), ...(prompt ? { prompt } : {}), allAllowed };
}

// ── what is plainly harmless ───────────────────────────────────────────────

type ArgCheck = (args: string[]) => boolean;
const anyArgs: ArgCheck = () => true;
/** True when no argument is one of `bad` (also as `--flag=value`). */
const without =
  (...bad: string[]): ArgCheck =>
  (args) =>
    !args.some((a) => bad.some((b) => a.toLowerCase() === b || a.toLowerCase().startsWith(`${b}=`)));
/** At most `n` words that are not options: `uniq in out` would write `out`. */
const positionalsAtMost =
  (n: number): ArgCheck =>
  (args) =>
    args.filter((a) => !a.startsWith("-")).length <= n;

const READ_ONLY: Record<string, ArgCheck> = {
  // listing and printing
  ls: anyArgs, dir: anyArgs, pwd: anyArgs, echo: anyArgs, printf: anyArgs, cat: anyArgs, type: anyArgs,
  head: anyArgs, tail: anyArgs, wc: anyArgs, nl: anyArgs, cut: anyArgs, tr: anyArgs, stat: anyArgs, file: anyArgs,
  du: anyArgs, df: anyArgs, tree: anyArgs, which: anyArgs, where: anyArgs, whoami: anyArgs, hostname: anyArgs,
  uname: anyArgs, id: anyArgs, ps: anyArgs, basename: anyArgs, dirname: anyArgs, realpath: anyArgs, readlink: anyArgs,
  cmp: anyArgs, diff: anyArgs, jq: anyArgs,
  uniq: positionalsAtMost(1),
  sort: without("-o", "--output"),
  date: without("-s", "--set"),
  grep: anyArgs, egrep: anyArgs, fgrep: anyArgs,
  rg: without("--pre", "--hostname-bin"),
  find: without("-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"),
  // PowerShell
  "get-childitem": noEnvDrive, gci: noEnvDrive,
  "get-content": anyArgs, gc: anyArgs,
  "get-location": anyArgs, gl: anyArgs,
  "get-item": noEnvDrive, gi: noEnvDrive, "get-itemproperty": noEnvDrive, gp: noEnvDrive,
  "test-path": anyArgs, "resolve-path": anyArgs, rvpa: anyArgs,
  "select-string": anyArgs, sls: anyArgs,
  "measure-object": anyArgs, measure: anyArgs, "select-object": anyArgs, select: anyArgs,
  "sort-object": anyArgs, "group-object": anyArgs, group: anyArgs,
  "format-list": anyArgs, fl: anyArgs, "format-table": anyArgs, ft: anyArgs, "out-string": anyArgs,
  "get-process": anyArgs, gps: anyArgs, "get-service": anyArgs, "get-command": anyArgs, gcm: anyArgs,
  "get-date": anyArgs, "get-help": anyArgs, "get-filehash": anyArgs,
  "write-output": anyArgs, "write-host": anyArgs, write: anyArgs,
  "split-path": anyArgs, "join-path": anyArgs, "compare-object": anyArgs,
  "convertto-json": anyArgs, "convertfrom-json": anyArgs, "where-object": anyArgs,
};

/** `Get-ChildItem Env:` lists the environment. */
function noEnvDrive(args: string[]): boolean {
  return !args.some((a) => /^(env|variable|function|alias):?/i.test(a.replace(/^-(path|literalpath)[:=]?/i, "")));
}

/** git subcommands that only read, with the options each must not be given. */
const GIT_READ_ONLY: Record<string, ArgCheck> = {
  status: anyArgs, log: anyArgs, diff: anyArgs, show: anyArgs, "ls-files": anyArgs, "ls-tree": anyArgs,
  "rev-parse": anyArgs, "rev-list": anyArgs, describe: anyArgs, blame: anyArgs, shortlog: anyArgs,
  "cat-file": anyArgs, grep: anyArgs, "name-rev": anyArgs, "merge-base": anyArgs, "diff-tree": anyArgs,
  "show-ref": anyArgs, "check-ignore": anyArgs, "count-objects": anyArgs, whatchanged: anyArgs,
  reflog: (args) => !args.some((a) => /^(expire|delete)$/.test(a)),
  remote: (args) => args.length === 0 || args.every((a) => a === "-v" || a === "--verbose") || /^(show|get-url)$/.test(args[0] ?? ""),
  branch: (args) => args.every((a) => /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose|--merged|--no-merged|--contains)$/.test(a)),
  tag: (args) => args.every((a) => /^(-l|--list|-n\d*|--sort=.*)$/.test(a)),
  stash: (args) => /^(list|show)$/.test(args[0] ?? ""),
  worktree: (args) => args[0] === "list",
};
/** Options that make an otherwise read-only git command write or run a program. */
const GIT_BAD_OPTIONS = ["--output", "--ext-diff", "--textconv", "--exec", "--upload-pack", "--receive-pack", "--open-files-in-pager"];

function gitReadOnly(cmd: SimpleCommand, gitConfigSafe: boolean): boolean {
  if (!gitConfigSafe) return false;
  const [, sub, ...args] = cmd.words;
  if (sub === "--version" || sub === "version") return args.length === 0;
  const check = sub ? GIT_READ_ONLY[sub] : undefined;
  return !!check && without(...GIT_BAD_OPTIONS)(args) && check(args);
}

/** Is this one command a known read-only command, given what it is passed? */
export function isReadOnly(cmd: SimpleCommand, gitConfigSafe: boolean): boolean {
  if (cmd.writes.length > 0 || cmd.expands || cmd.words.length === 0) return false;
  const verb = verbOf(cmd);
  if (verb === "git") return gitReadOnly(cmd, gitConfigSafe);
  const check = READ_ONLY[verb];
  return !!check && check(cmd.words.slice(1));
}

/**
 * Whether git in `cwd` would run a program from the repository's own config just to answer a
 * read-only question (fsmonitor, a pager, an external diff or textconv, a filter). A repo that
 * arrived with such a config makes even `git status` a way to run code, so its git commands keep
 * their question. True when it cannot be told: a worktree file, an unreadable config.
 */
export function gitConfigRunsPrograms(cwd: string): boolean {
  const dotGit = join(cwd, ".git");
  if (!existsSync(dotGit)) return false; // not a repository: git reads only the user's own config
  try {
    const text = readFileSync(join(dotGit, "config"), "utf8");
    return /^\s*(fsmonitor|pager|sshcommand|editor|askpass|external|textconv|command|clean|smudge|process|program|hookspath|path)\s*=|^\s*\[(include|includeIf)\b/im.test(text);
  } catch {
    return true;
  }
}

/**
 * Sentinel's question can be skipped: every part of the command is read-only or allowed by
 * a user rule, and nothing in it is unreadable. Never true for a command this reader cannot
 * fully read.
 */
export function needsNoQuestion(parsed: ParsedCommand, rules: readonly CommandRule[], cwd: string): boolean {
  if (parsed.unreadable || parsed.commands.length === 0) return false;
  const verdict = ruleVerdict(parsed, rules);
  if (verdict.forbid || verdict.prompt) return false;
  const gitSafe = !gitConfigRunsPrograms(cwd);
  return parsed.commands.every(
    (cmd) => isReadOnly(cmd, gitSafe) || (cmd.writes.length === 0 && rules.some((r) => r.decision === "allow" && ruleMatches(r, cmd))),
  );
}

/**
 * Programs that run whatever they are handed next: an interpreter, a shell, a launcher, a downloader. A rule on
 * one of these ("allow node") would approve every command that begins with it, so no prefix is ever suggested.
 */
const TOO_BROAD = new Set([
  "node", "nodejs", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php", "lua", "java", "dotnet",
  "bash", "sh", "zsh", "fish", "dash", "pwsh", "powershell", "cmd", "npx", "pnpx", "bunx", "uvx", "pipx", "sudo", "doas",
  "env", "xargs", "nohup", "time", "timeout", "start", "ssh", "scp", "sftp", "curl", "wget", "iwr", "irm", "nc", "ncat",
  "rm", "rmdir", "rd", "del", "erase", "remove-item", "ri", "mv", "move", "cp", "copy", "dd", "format", "chmod", "chown",
  "kill", "taskkill", "pkill", "make", "gmake", "find", "awk", "sed",
]);
/** Tools whose first word is a program and whose second is the action: the prefix takes both. */
const TWO_WORD = new Set([
  "git", "npm", "pnpm", "yarn", "cargo", "go", "docker", "podman", "kubectl", "gh", "pip", "pip3", "uv", "poetry",
  "composer", "gradle", "mvn", "terraform", "helm", "rustup", "brew", "apt", "apt-get", "winget", "choco", "flutter", "swift",
]);

/**
 * The prefix a "don't ask again" answer would save for this command, or null when none is safe to offer.
 *
 * Only a single, fully readable command that writes no file qualifies. `npm test` becomes `npm test`; a bare
 * `cargo build --release` becomes `cargo build`. A shell, interpreter or launcher, and a command that is itself
 * one of the risky ones, get nothing: the person can still answer yes for this one command.
 */
export function suggestAllowPrefix(parsed: ParsedCommand): string | null {
  if (parsed.unreadable || parsed.commands.length !== 1) return null;
  const cmd = parsed.commands[0]!;
  if (cmd.writes.length > 0 || cmd.expands) return null;
  const verb = verbOf(cmd);
  if (!verb || TOO_BROAD.has(verb)) return null;
  const second = cmd.words[1];
  if (TWO_WORD.has(verb)) {
    if (!second || second.startsWith("-") || /[\\/$%*?]/.test(second)) return null;
    // `npm run build` is a script name, and `npm run` alone would allow every script in the file.
    if (second.toLowerCase() === "run" || second.toLowerCase() === "exec" || second.toLowerCase() === "x") {
      const third = cmd.words[2];
      return third && !third.startsWith("-") && !/[\\/$%*?]/.test(third) ? `${verb} ${second} ${third}` : null;
    }
    return `${verb} ${second}`;
  }
  return verb;
}

// ── protected paths named in a command ──────────────────────────────────────

/** Verbs that do not read what they are pointed at: a listing, a deletion, a directory change. */
const NEVER_READS = new Set([
  "ls", "dir", "get-childitem", "gci", "test-path", "mkdir", "md", "new-item", "ni", "touch", "rm", "del", "erase",
  "remove-item", "ri", "rmdir", "rd", "echo", "write-output", "write-host", "write", "pwd", "cd", "chdir",
  "set-location", "sl", "pushd", "popd", "stat", "file", "basename", "dirname",
]);
/** Verbs that copy or move: their LAST path is where it goes, which may be a protected file. */
const COPIES = new Set(["cp", "copy", "copy-item", "cpi", "mv", "move", "move-item", "mi", "ren", "rename", "rename-item", "rni"]);

/** The candidate paths inside one word: itself, the value of `--flag=value`, and `@file`. */
function pathCandidates(word: string): string[] {
  const out = new Set<string>([word]);
  const eq = word.indexOf("=");
  if (eq > 0) out.add(word.slice(eq + 1).replace(/^@/, ""));
  if (word.startsWith("@")) out.add(word.slice(1));
  const at = word.lastIndexOf("@");
  if (at > 0 && word[at + 1] !== undefined) out.add(word.slice(at + 1));
  return [...out].filter((c) => c.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(c));
}

/**
 * The protected file this command names as something to read, copy out or send, as a reason
 * ("`.env` is an environment/secrets file"), or null. Judges what the paths lead to (links
 * and stream spellings resolved), not just the text.
 */
export async function protectedArgsReason(parsed: ParsedCommand, cwd: string): Promise<string | null> {
  for (const cmd of parsed.commands) {
    const verb = verbOf(cmd);
    if (NEVER_READS.has(verb)) continue;
    let args = cmd.words.slice(1).filter((w) => !(w.startsWith("-") && !w.includes("=")));
    if (COPIES.has(verb) && args.length >= 2) args = args.slice(0, -1);
    const inputs = [...args, ...cmd.words.slice(1).filter((w) => w.startsWith("-") && w.includes("=")), ...cmd.reads];
    for (const word of inputs) {
      for (const candidate of pathCandidates(word)) {
        const text = protectedPathReason(candidate.replace(/\\/g, "/"));
        if (text) return `\`${candidate}\` is ${text}`;
        const abs = resolveWord(candidate, cwd);
        if (!abs || !(/[\\/]/.test(candidate) || /^[.~]/.test(candidate) || existsSync(abs))) continue;
        const real = await guardedPathReason(abs);
        if (real) return `\`${candidate}\` is ${real}`;
      }
    }
  }
  return null;
}

function resolveWord(word: string, cwd: string): string | null {
  const expanded = expandHomeWords(word.startsWith("~") ? word.replace(/^~/, homedir()) : word);
  if (/[$%*?<>|"]/.test(expanded)) return null;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

// ── the entry points the tools use ───────────────────────────────────────────

/** Which shell dialect a run_command call uses. */
export function dialectFor(args: Record<string, unknown>): Dialect {
  if (process.platform !== "win32") return "posix";
  return args.shell === "cmd" ? "cmd" : "powershell";
}

export { parseCommand };
