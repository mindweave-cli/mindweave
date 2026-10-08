/**
 * guard.ts — the mechanical safety floor for the mutating tools.
 *
 * Two deterministic checks, no model judgment and no prompt rules (keeping the
 * "how to behave safely" decision out of the prompt is deliberate — the wall is
 * physical, the model is simply told why and adapts):
 *
 *  1. `protectedPathReason` — some files must never be read or written by the
 *     agent regardless of what it's asked: secrets (`.env`), keys (`.ssh`,
 *     `*.pem`, `id_rsa`), and the git internals (`.git/`) whose corruption would
 *     wreck the repo. This mirrors the deny-lists every serious coding agent
 *     ships; user-configurable rules can layer on later.
 *
 *  2. `catastrophicCommandReason` — a tiny, high-confidence blocklist of shell
 *     commands that are essentially never a legitimate coding action and are
 *     irreversible (wipe the disk, fork-bomb, reformat). This is NOT a sandbox
 *     or an injection parser — a single-user local tool doesn't need a heavyweight
 *     shell analyzer. It's a seatbelt against the few commands that turn a model
 *     mistake into a destroyed machine.
 *
 * Both return a human reason string when they fire, or `null` to allow. Fail
 * open by design: anything not explicitly matched is allowed.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stateRoot } from "../memory/store.js";

/**
 * Whether two spellings of a path that differ only in case are the same file. True on Windows and on macOS, whose
 * default volumes are case-insensitive; a Linux volume is not. Where it is true, protected-folder checks compare
 * lower-cased paths, so `~/.Mindweave/mcp-auth.json` is the file `~/.mindweave/mcp-auth.json` is. (On a case-sensitive
 * macOS volume this errs the safe way: a few more paths count as protected.)
 */
export function foldsCase(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}

// Path segments / names that are off-limits. Matched against the POSIX-style
// path so it works the same on Windows and Unix.
const PROTECTED_PATTERNS: { test: RegExp; what: string }[] = [
  // Three spellings, because two of them were getting through. `.env` and `.env.local`
  // were covered; `prod.env`, `staging.env` and `production.env` were NOT, and a
  // per-environment file is one of the commonest places a real secret actually lives.
  // `.envrc` (direnv) was not covered either, and it routinely holds exported keys.
  //
  // The suffix form is anchored to the end of the BASENAME rather than matched loosely,
  // which is what keeps ordinary code out of the net: `src/environment.ts` and
  // `src/env.ts` must stay readable, and a floor that blocked those would be worked
  // around rather than obeyed.
  { test: /(^|\/)\.env(\.|$|\/)/i, what: "an environment/secrets file" },
  { test: /(^|\/)[^/]*\.env$/i, what: "an environment/secrets file" },
  { test: /(^|\/)\.envrc$/i, what: "an environment/secrets file" },
  { test: /(^|\/)\.git(\/|$)/i, what: "the git internals directory" },
  { test: /(^|\/)\.ssh(\/|$)/i, what: "an SSH key directory" },
  { test: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/i, what: "a private SSH key" },
  { test: /\.pem$/i, what: "a private key file" },
  { test: /(^|\/)(secrets?|credentials)(\/|\.|$)/i, what: "a secrets/credentials file" },
  // Files that routinely hold a token or a private key under an ordinary-looking name.
  // Each is matched by its exact name or a key-file extension, so source code stays
  // readable: a model debugging `npm install` reads .npmrc, and that is where the token is.
  { test: /(^|\/)(\.npmrc|\.yarnrc\.yml|\.netrc|_netrc|\.git-credentials|\.pypirc)$/i, what: "a file holding login tokens" },
  { test: /(^|\/)\.docker\/config\.json$/i, what: "a file holding login tokens" },
  { test: /(^|\/)\.kube\/config$/i, what: "a file holding login tokens" },
  { test: /(^|\/)\.config\/gh\/hosts\.yml$/i, what: "a file holding login tokens" },
  { test: /(^|\/)(\.config\/gcloud|\.azure|\.aws|\.gnupg)(\/|$)/i, what: "a cloud or signing credentials directory" },
  // Each system's own place for saved passwords and keys.
  { test: /(^|\/)(Library\/Keychains|\.local\/share\/keyrings|\.password-store|AppData\/Roaming\/Microsoft\/(Credentials|Protect|Vault))(\/|$)/i, what: "the system's saved passwords and keys" },
  { test: /\.(key|p12|pfx|jks|keystore|kdbx)$/i, what: "a private key or keystore" },
  { test: /(^|\/)terraform\.tfstate(\.backup)?$|\.tfvars$/i, what: "an infrastructure state or variables file" },
  { test: /(^|\/)service-account[^/]*\.json$/i, what: "a cloud service-account key" },
];

/**
 * The example counterpart of an env file, which is the opposite of a secret.
 *
 * `.env.example` and its spellings are committed to repositories on purpose: they list
 * the variable NAMES a project needs, with the values left blank or filled with obvious
 * placeholders, and they are the file a newcomer is told to copy. Refusing them withholds
 * a project's own documentation about its configuration while protecting nothing —
 * anything a real key sits in (`.env`, `.env.local`, `.env.production`, `prod.env`) is
 * still matched by the patterns above.
 *
 * Anchored to the end of the name, so `.env.example.local` — a real file in some setups,
 * holding real values — is not exempted by starting the same way.
 */
const ENV_EXAMPLE = /(^|\/)\.?env\.(example|sample|template|defaults|dist)$/i;

/**
 * If `absPath` is a file the agent must never touch, return a short reason;
 * otherwise null. `absPath` may use either slash style.
 *
 * This reads the path TEXT. A tool that is about to open a file uses
 * `guardedPathReason`, which judges the file the text leads to.
 */
export function protectedPathReason(absPath: string): string | null {
  const posix = absPath.split("\\").join("/");
  if (ENV_EXAMPLE.test(posix)) return null;
  for (const { test, what } of PROTECTED_PATTERNS) {
    if (test.test(posix)) return what;
  }
  return stateFileReason(posix);
}

/**
 * The protected-file check for a path a tool is about to open: the file, not the string.
 *
 * Text patterns alone let the same file through under another spelling, all proven:
 * `.env::$DATA` (the NTFS default stream of .env itself), `.env.` and `.env ` (Windows
 * drops trailing dots and spaces), a short 8.3 name, and a link inside the project that
 * points at .git or ~/.ssh. So a Windows stream spelling is refused outright, the
 * trailing dots and spaces are removed, links are resolved, and the patterns run on the
 * spelled path AND the real one. Every tool that takes a path asks this before opening it.
 */
export async function guardedPathReason(absPath: string): Promise<string | null> {
  const textual = protectedPathReason(absPath);
  if (textual) return textual;
  let path = absPath;
  if (process.platform === "win32") {
    path = path.replace(/^\\\\\?\\/, "");
    // A colon anywhere but after the drive letter is an alternate data stream.
    if (path.slice(2).includes(":")) return "a Windows stream spelling of a file";
    path = path
      .split(/[\\/]/)
      .map((segment, i) => (i === 0 ? segment : segment.replace(/[. ]+$/, "")))
      .join("\\");
  }
  return protectedPathReason(path) ?? protectedPathReason(await realPathOf(path));
}

/**
 * The real location of `path` with links, junctions and short names resolved, for a path
 * that may not exist yet: the nearest existing ancestor is resolved and the rest
 * appended. Lower-cased on Windows, where two spellings of a path name the same file.
 */
export async function realPathOf(path: string): Promise<string> {
  const fold = (p: string) => (foldsCase() ? p.toLowerCase() : p);
  const tail: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return fold(join(await realpath(head), ...tail.reverse()));
    } catch {
      const parent = dirname(head);
      if (parent === head) return fold(resolve(path));
      tail.push(basename(head));
      head = parent;
    }
  }
}

/** Is `path` the folder `root` or inside it? Pass real paths from realPathOf. */
export function withinFolder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Mindweave's own state folder (~/.mindweave) is off-limits too, with three exceptions
 * the agent is pointed at by design: a project's `memory/` folder, where it keeps its
 * notes, `mcp-results/`, where a large MCP result is saved for it to read, and
 * `cleared/`, where the originals of cleared tool results are kept for it to read.
 *
 * Everything else there is Mindweave's, not the project's: sign-ins to MCP servers
 * (access and refresh tokens), key labels, the permission and rule files, past sessions,
 * the undo history, and the programs it installed for code intelligence. Read, they leak;
 * written, they change what Mindweave allows or runs in every later session.
 */
function stateFileReason(posix: string): string | null {
  const fold = (p: string) => (foldsCase() ? p.toLowerCase() : p);
  const root = fold(stateRoot().split("\\").join("/").replace(/\/+$/, ""));
  const path = fold(posix);
  if (path !== root && !path.startsWith(root + "/")) return null;
  const rel = path.slice(root.length + 1);
  if (/^projects\/[^/]+\/(memory|mcp-results|cleared)(\/|$)/.test(rel)) return null;
  return "Mindweave's own settings, sign-ins and state";
}

// Another coding agent's private working data: its saved sessions, its memory of
// past conversations, its rules and skills. A project that has been worked on by
// more than one tool carries several of these side by side.
//
// This is NOT the same thing as a secret, and it is deliberately a separate list.
// A secret must never be read at all. This data is simply not ours: it belongs to
// a different tool and a different set of conversations, and helping ourselves to
// it means presenting someone else's history as if it were our own, or inheriting
// stale decisions the user never made with us. So the rule is "ask first", not
// "never" — the user can always say yes.
//
// Deliberately absent from this list: our own directory. Our sessions and memory
// live under the user's home directory rather than in the project, but a project
// may still hold our own notes, and reading our own work is the entire point.
const AGENT_PATTERNS: { test: RegExp; what: string }[] = [
  { test: /(^|\/)\.claude(\/|$)/i, what: "Claude Code" },
  { test: /(^|\/)CLAUDE\.md$/i, what: "Claude Code" },
  { test: /(^|\/)\.cursor(\/|$)/i, what: "Cursor" },
  { test: /(^|\/)\.cursorrules$/i, what: "Cursor" },
  { test: /(^|\/)\.aider[^/]*$/i, what: "Aider" },
  { test: /(^|\/)\.aider(\/|$)/i, what: "Aider" },
  { test: /(^|\/)\.continue(\/|$)/i, what: "Continue" },
  { test: /(^|\/)\.windsurf(\/|$)/i, what: "Windsurf" },
  { test: /(^|\/)\.codeium(\/|$)/i, what: "Codeium" },
  { test: /(^|\/)AGENTS\.md$/i, what: "another coding agent" },
];

/**
 * If `absPath` belongs to a DIFFERENT coding agent, return that tool's name;
 * otherwise null. Callers use this to ask the user before touching it, never to
 * refuse outright — see `requestAgentDataAccess`.
 */
export function foreignAgentReason(absPath: string): string | null {
  const posix = absPath.split("\\").join("/");
  for (const { test, what } of AGENT_PATTERNS) {
    if (test.test(posix)) return what;
  }
  return null;
}

/** Directory names belonging to other coding agents, for skipping during a walk
 *  or search. Files that are not directories (CLAUDE.md, .cursorrules) are matched
 *  by `foreignAgentReason` instead. */
export const AGENT_DIRS: readonly string[] = [
  ".claude",
  ".cursor",
  ".aider",
  ".continue",
  ".windsurf",
  ".codeium",
];

/**
 * Glob patterns a CONTENT SEARCH must never look inside.
 *
 * Search is the quiet way past a per-file gate: `read_file` refuses to open
 * `.env`, but an unfiltered `grep -r "KEY" .` prints the matching lines anyway,
 * and the same trick would surface another agent's saved conversations without
 * ever opening a file. Secrets are excluded outright; another agent's data is
 * excluded because a search is a poor place to ask a question — the model can
 * still read those files deliberately, which is where the user gets asked.
 */
export const SEARCH_EXCLUDE_GLOBS: readonly string[] = [
  ".env",
  ".env.*",
  ".ssh",
  "*.pem",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "secrets",
  "secret",
  "credentials",
  ...AGENT_DIRS,
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".aider*",
];

/** True if a search result from `absPath` must be withheld — a secret, or another
 *  coding agent's data. The counterpart to SEARCH_EXCLUDE_GLOBS for the built-in
 *  walker, which filters after walking rather than excluding at the source. */
export function excludedFromSearch(absPath: string): boolean {
  return protectedPathReason(absPath) !== null || foreignAgentReason(absPath) !== null;
}

// Paths a shell command must not PRINT the contents of.
const COMMAND_SENSITIVE: { needle: RegExp; what: string }[] = [
  // The lookahead is the same exemption `ENV_EXAMPLE` makes for a path: printing
  // `.env.example` is reading a project's own template, and a command that names it
  // alongside ordinary files was being refused whole.
  { needle: /(^|[\s"'`/\\=<])\.env\b(?!\.(example|sample|template|defaults|dist)\b)/i, what: "an environment/secrets file" },
  { needle: /(^|[\s"'`/\\=<])\.ssh\b/i, what: "an SSH key directory" },
  { needle: /\bid_(rsa|ed25519|ecdsa|dsa)\b/i, what: "a private SSH key" },
  { needle: /\.pem\b/i, what: "a private key file" },
  { needle: /(^|[\s"'`/\\=<])\.claude\b/i, what: "Claude Code's data" },
  { needle: /(^|[\s"'`/\\=<])\.cursor(rules)?\b/i, what: "Cursor's data" },
  { needle: /(^|[\s"'`/\\=<])\.aider/i, what: "Aider's data" },
  { needle: /(^|[\s"'`/\\=<])\.continue\b/i, what: "Continue's data" },
  { needle: /(^|[\s"'`/\\=<])\.windsurf\b/i, what: "Windsurf's data" },
  { needle: /(^|[\s"'`/\\=<])\.codeium\b/i, what: "Codeium's data" },
];

// Commands whose OUTPUT is the contents of a file. This is the thing that matters:
// the harm is a secret being printed into the model's context (and from there into
// a saved transcript, and into the next request to a provider). Copying, moving,
// listing, or testing for a file does none of that, so none of them belong here.
//
// Matched in COMMAND POSITION only — start of the command, or after a pipe,
// semicolon, `&&`, or a subshell opener. Without that anchor, ordinary words like
// `type` in `npm run typecheck` or a `--head` flag would trip it.
//
// PowerShell shares this list: `cat`, `type`, and `gc` are all aliases for
// Get-Content there, so the same names cover both shells.
const CONTENT_READERS =
  /(^|[|;&]|&&|\$\(|\bthen\b|\bdo\b)\s*(sudo\s+)?(cat|type|more|less|head|tail|strings|xxd|od|base64|gc|Get-Content|sls|Select-String|findstr|grep|rg|ack|awk|sed|nl|tac|Format-Hex)\b/i;

// `< file` feeds a file's contents in, which can print it just as directly.
const INPUT_REDIRECT = /<\s*[^\s|;&]+/;

/**
 * If `command` would PRINT the contents of a secret or another agent's data,
 * return what it is reaching for; otherwise null.
 *
 * Two conditions, both required: the command reads file content, AND it names one
 * of the sensitive paths. That pairing is what keeps this useful rather than
 * merely irritating: `Test-Path .env` (does it exist?), `ls .claude`, and
 * `cp .env.example .env` all pass, while `cat .env` and `Get-Content .env` do not.
 *
 * This is deliberately not adversarial defense. A model set on evading a string
 * check can always do so, and no amount of pattern-matching a shell fixes that.
 * It is here to stop the accidental `cat .env` that would drop live credentials
 * into the transcript, which is a mistake rather than an attack. The caller points
 * the model at `read_file`, which asks the user properly.
 */
export function sensitiveCommandReason(command: string): string | null {
  const reads = CONTENT_READERS.test(command) || INPUT_REDIRECT.test(command);
  if (!reads) return null;
  for (const { needle, what } of COMMAND_SENSITIVE) {
    if (needle.test(command)) return what;
  }
  return null;
}

// Irreversible, essentially-never-legitimate commands. Patterns are intentionally
// narrow (high precision) so they don't get in the way of real work — the goal is
// to catch the catastrophic mistake, not to police the shell.
const CATASTROPHIC_PATTERNS: { test: RegExp; what: string }[] = [
  { test: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]+\s+)*(\/|~|\$HOME)(\s|$)/i, what: "recursively deleting the filesystem root or home directory" },
  // Real disk-format commands only. `\bformat\b` matched the word anywhere, so every
  // benign PowerShell display cmdlet — `Format-Table`, `Format-List`, `Format-Hex` — and
  // even `git log --format=…` was refused as "reformatting a disk", blocking ordinary
  // work. Now it catches `mkfs`, the CMD `format <drive>:` / `format /switch`, and the
  // PowerShell cmdlets that actually erase a volume (`Format-Volume`, `Format-Disk`).
  { test: /\bmkfs\b|\bformat\s+(?:[a-z]:|\/)|\bformat-(?:volume|disk)\b/i, what: "reformatting a disk" },
  { test: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/i, what: "overwriting a raw disk device" },
  { test: />\s*\/dev\/(sd|nvme|disk|hd)/i, what: "writing to a raw disk device" },
  { test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, what: "a fork bomb" },
];

/**
 * If `command` is an irreversible, catastrophic action, return a short reason;
 * otherwise null.
 */
export function catastrophicCommandReason(command: string): string | null {
  for (const { test, what } of CATASTROPHIC_PATTERNS) {
    if (test.test(command)) return what;
  }
  return destructiveDeleteReason(command);
}

/**
 * Commands a coding agent does run, but that throw work away, rewrite shared history,
 * skip the project's own checks, publish, or run code straight from the internet. Not a
 * floor: each asks the user first (see run_command), in every mode, with this as the
 * warning. A short list on purpose; a long one would be clicked through.
 */
const RISKY_COMMANDS: { test: RegExp; what: string }[] = [
  { test: /\bgit\s+push\b[^\n;|&]*\s(-f|--force)\b(?!-with-lease)/i, what: "force-pushes, which overwrites history others may have" },
  { test: /\bgit\s+push\b[^\n;|&]*\s(--delete|-d)\b|\bgit\s+push\b[^\n;|&]*\s:[\w./-]+/i, what: "deletes a branch or tag on the remote" },
  { test: /\bgit\s+push\b[^\n;|&]*\s\+[\w./-]+/i, what: "force-pushes, which overwrites history others may have" },
  { test: /\bgit\s+reset\b[^\n;|&]*\s--hard\b/i, what: "discards uncommitted changes for good (git reset --hard)" },
  { test: /\bgit\s+clean\b[^\n;|&]*\s-[a-z]*f/i, what: "deletes untracked files for good (git clean)" },
  { test: /\bgit\s+branch\b[^\n;|&]*\s-D\b/, what: "deletes a branch even if it was never merged (git branch -D)" },
  { test: /\bgit\s+(checkout|restore)\b[^\n;|&]*\s(--\s+)?\.(\s|$)/i, what: "discards every uncommitted change in the folder" },
  { test: /\bgit\s+stash\s+(drop|clear)\b/i, what: "deletes stashed work for good" },
  { test: /\bgit\s+(commit|push|merge|rebase)\b[^\n;|&]*\s--no-verify\b/i, what: "skips the project's own git hooks (--no-verify)" },
  { test: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n;]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|python3?|node)\b/i, what: "runs code downloaded from the internet" },
  { test: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b/i, what: "publishes a package or release" },
];

/** Why `command` should ask the user first even when nothing else does, or null (pure). */
export function riskyCommandReason(command: string): string | null {
  for (const { test, what } of RISKY_COMMANDS) if (test.test(command)) return what;
  return null;
}

/** Commands that delete, in the shells run_command uses (aliases included). */
const DELETE_VERBS = /^(rm|rmdir|rd|del|erase|remove-item|ri|rimraf)(\.exe)?$/i;
/** cmd.exe spells its switches /s /q; for its verbs those are flags, not the root. */
const CMD_DELETE_VERBS = /^(rmdir|rd|del|erase)(\.exe)?$/i;

/**
 * Deleting a drive root, the home folder, a folder above it, a system folder, or a
 * key or settings folder, decided by what the command names rather than how it is
 * spelled.
 *
 * This replaced a PowerShell pattern that could never match (`\b` before `-Recurse`
 * needs a word character beside the hyphen, and there never is one), so
 * `Remove-Item -Recurse -Force C:\\` was allowed in every mode. Spelling-based rules miss
 * argument order, aliases (`ri`, `rd`), named parameters (`-Path`) and variables
 * (`$env:USERPROFILE`); reading the words does not. Deleting something INSIDE those
 * folders (a cache, a temp file) is left alone: this is the floor, and it must only ever
 * fire on what is never a coding action.
 */
export function destructiveDeleteReason(command: string): string | null {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = shellWords(segment);
    let at = words.findIndex((w) => w !== "&" && w !== ".");
    // Look through what only starts another shell or raises privilege: `cmd /c rd ...`,
    // `powershell -Command Remove-Item ...`, `sudo rm ...` delete just the same.
    for (;;) {
      const w = words[at] ?? "";
      if (/^(sudo|doas)$/i.test(w)) at++;
      else if (/^cmd(\.exe)?$/i.test(w) && /^\/[ck]$/i.test(words[at + 1] ?? "")) at += 2;
      else if (/^(powershell|pwsh)(\.exe)?$/i.test(w)) {
        const c = words.findIndex((x, i) => i > at && /^-(c|command)$/i.test(x));
        if (c < 0) break;
        at = c + 1;
      } else break;
    }
    const verb = words[at];
    if (!verb || !DELETE_VERBS.test(verb)) continue;
    const cmdStyle = CMD_DELETE_VERBS.test(verb);
    for (const word of words.slice(at + 1)) {
      if (word.startsWith("-")) continue;
      if (cmdStyle && /^\/[a-z?]$/i.test(word)) continue;
      const target = expandHomeWords(word).replace(/[\\/]\*(\.\*)?$/, "/").replace(/^\*$/, "");
      if (!target || !(isAbsolute(target) || /^[a-z]:$/i.test(target))) continue;
      const why = vitalFolderReason(target);
      if (why) return `deleting ${why}`;
    }
  }
  return null;
}

/** Split one command into words, keeping quoted text together (quotes removed). */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  for (const m of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3] ?? "");
  return words;
}

/** Replace the spellings of the home folder and the Windows folders with real paths. */
export function expandHomeWords(word: string): string {
  const env = process.env;
  const home = homedir();
  const pairs: [RegExp, string | undefined][] = [
    [/^~(?=$|[\\/])/, home],
    [/^\$\{?HOME\}?(?=$|[\\/])/i, home],
    [/^\$env:(USERPROFILE|HOME)(?=$|[\\/])/i, home],
    [/^%USERPROFILE%/i, home],
    [/^%HOMEDRIVE%%HOMEPATH%/i, home],
    [/^(\$env:SystemDrive|%SystemDrive%)(?=$|[\\/])/i, env.SystemDrive ?? "C:"],
    [/^(\$env:(windir|SystemRoot)|%(windir|SystemRoot)%)(?=$|[\\/])/i, env.SystemRoot ?? env.windir],
    [/^(\$env:ProgramFiles|%ProgramFiles%)(?=$|[\\/])/i, env.ProgramFiles],
  ];
  for (const [re, value] of pairs) if (value && re.test(word)) return word.replace(re, () => value);
  return word;
}

/**
 * Why deleting `target` would wreck the machine, or null. Exact matches and ancestors
 * only: a drive or filesystem root, the home folder or one above it, a system folder or
 * one containing one, and the key and settings folders themselves.
 */
function vitalFolderReason(target: string): string | null {
  const win = process.platform === "win32";
  const fold = (p: string) => {
    const r = resolve(/^[a-z]:$/i.test(p) ? p + "\\" : p);
    return foldsCase() ? r.toLowerCase() : r;
  };
  const t = fold(target);
  const isOrAbove = (dir: string | undefined) => {
    if (!dir) return false;
    const rel = relative(t, fold(dir));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (dirname(t) === t) return "a drive or filesystem root";
  const home = homedir();
  if (isOrAbove(home)) return "the home folder or a folder that contains it";
  const env = process.env;
  const system = win
    ? [env.SystemRoot, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData]
    : ["/etc", "/usr", "/bin", "/sbin", "/boot", "/lib", "/System", "/Library", "/Applications", "/var"];
  if (system.some(isOrAbove)) return "a system folder";
  const vital = [join(home, ".ssh"), join(home, ".gnupg"), join(home, ".mindweave"), ...(win ? [env.APPDATA, env.LOCALAPPDATA, join(home, "AppData")] : [])];
  if (vital.some((d) => d !== undefined && fold(d) === t)) return "a folder that holds keys or settings";
  return null;
}
