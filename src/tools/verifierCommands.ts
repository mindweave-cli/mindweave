/**
 * verifierCommands.ts — what a verifier may run.
 *
 * A verifier has to run things to check them, so it has a command tool. A command can do far more than
 * check: delete, move, install, publish, rewrite history, download and run something, write over a source
 * file. The after-the-fact look at the project's files (treeGuard.ts) catches a change to the project, but
 * only a change to the project and only afterwards, and some of these cannot be put back.
 *
 * So the verifier gets a narrow set of commands rather than a broad one: builds, tests, the typechecker,
 * scripts that call the code, the app itself, and anything that only reads. What it is refused is named
 * in words it can act on, together with what to do instead, because a refusal that only says "no" sends a
 * model round in circles. What cannot be seen from the command line (a script that deletes a file itself)
 * is left to the look at the files afterwards, and is not claimed to be covered here.
 *
 * Applies only to a verifier. The agent a person is working with is not narrowed by any of this.
 */
import { tmpdir } from "node:os";

/** One kind of thing a verifier does not do, how it is spotted, and what to say about it. */
interface Rule {
  test: RegExp;
  /** What it is, in the sentence "a verifier does not <what>". */
  what: string;
}

/**
 * The start of a command: the beginning of the text, or after a separator, an opening bracket or an opening
 * quote. The quote is there so `powershell -Command "Remove-Item src"` is read as the command it carries.
 */
const AT = String.raw`(?:^|[;&|({"'\x60]\s*|\bthen\s+|\bdo\s+)`;

const RULES: Rule[] = [
  {
    // Delete, move, rename, copy over: the verbs of every shell. A path is the thing deleted or replaced.
    test: new RegExp(`${AT}(?:rm|rmdir|rd|del|erase|remove-item|ri|mv|move|move-item|mi|ren|rename|rename-item|rni|cp|copy|copy-item|cpi|xcopy|robocopy|ln|mklink|chmod|chown|icacls|takeown|truncate|shred|rimraf)(?:\\.exe)?\\b`, "i"),
    what: "delete, move, rename or copy files",
  },
  {
    // Deleting through a package, wherever it sits in the command.
    test: /\b(?:rimraf|del-cli|trash-cli)\b/i,
    what: "delete, move, rename or copy files",
  },
  {
    // Changing a repository: the read-only git commands (status, log, diff, show, blame, ls-files) stay.
    test: /\bgit(?:\.exe)?\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*(?:add|commit|checkout|switch|restore|reset|clean|stash|merge|rebase|cherry-pick|revert|push|pull|fetch|apply|am|rm|mv|tag|config|init|clone|worktree|submodule|update-index|gc|prune|branch\s+-[dDmM])\b/i,
    what: "change a git repository",
  },
  {
    // Installing or removing packages changes what the project runs on, and publishing sends it out.
    test: /\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:install|i|ci|add|remove|rm|uninstall|update|upgrade|link|unlink|publish|dlx|create|init)\b|\b(?:pip3?|pipx|gem|cargo|go|dotnet|poetry|uv)\s+(?:install|uninstall|add|remove|get|publish|new|tool\s+install)\b|\b(?:winget|choco|scoop|apt|apt-get|brew|dnf|yum|snap)\s+(?:install|uninstall|remove|upgrade)\b/i,
    what: "install, remove or publish packages",
  },
  {
    // A program that is not the project's own, fetched and run, or data sent out.
    test: /\b(?:scp|sftp|ftp|ssh|nc|ncat|netcat|telnet|rsync)\b/i,
    what: "connect to other machines",
  },
  {
    // Stopping processes: what a verifier starts is stopped for it when it ends, and it has no business
    // stopping what the session or the user has running.
    test: /\b(?:stop-process|spps|taskkill|pkill|killall)\b|(?:^|[;&|({"'\x60]\s*)kill\b/i,
    what: "stop processes",
  },
  {
    // The machine's own settings.
    test: /\b(?:reg(?:\.exe)?\s+(?:add|delete|import)|schtasks|netsh|setx|set-itemproperty|new-itemproperty|remove-itemproperty|set-executionpolicy|diskpart|format-volume|bcdedit|shutdown|restart-computer|stop-computer|net\s+user|net\s+localgroup|sc(?:\.exe)?\s+(?:create|delete|config|start|stop))\b/i,
    what: "change the machine's settings",
  },
];

/** A URL's host, when it is one this machine is: a debugging port, a dev server. */
function isLocalHost(host: string): boolean {
  return /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i.test(host);
}

/** Every address in the text that is not this machine's own (pure). */
export function outsideAddresses(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/(\[[^\]]+\]|[^\s/:'"`]+)/gi)) if (!isLocalHost(m[1]!)) out.push(m[0]);
  return out;
}

/**
 * The files a command redirects output into (pure). Read the way a shell reads it: a `>` inside quotes is
 * part of a string and not a redirect (`node -e "a => b > 1"`), `2>&1` joins two streams and names no file,
 * and `=>` is an arrow. The target is the next word, quoted or not.
 */
function redirectTargets(command: string): string[] {
  const out: string[] = [];
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== ">") continue;
    const before = command[i - 1] ?? "";
    if (before === "=" || before === "-") continue; // an arrow, or a flag such as ->
    let j = i + 1;
    if (command[j] === ">") j++; // >>
    while (command[j] === " " || command[j] === "\t") j++;
    if (command[j] === "&") continue; // 2>&1
    let target = "";
    if (command[j] === '"' || command[j] === "'") {
      const q = command[j]!;
      const end = command.indexOf(q, j + 1);
      target = command.slice(j + 1, end < 0 ? command.length : end);
    } else {
      let k = j;
      while (k < command.length && !/[\s;|&)<>]/.test(command[k]!)) k++;
      target = command.slice(j, k);
    }
    if (target) out.push(target);
  }
  return out;
}

/** Where a path says it is in the system's temporary files: the one place a verifier may write. */
function isTempPath(raw: string, temp: string): boolean {
  const p = raw.replace(/^["']|["']$/g, "").trim();
  if (p === "") return false;
  const low = p.toLowerCase().split("\\").join("/");
  const tmp = temp.toLowerCase().split("\\").join("/").replace(/\/+$/, "");
  return (
    low === "nul" ||
    low === "/dev/null" ||
    low === "$null" ||
    low.startsWith(`${tmp}/`) ||
    low.startsWith("/tmp/") ||
    low.startsWith("$env:temp") ||
    low.startsWith("$env:tmp") ||
    low.startsWith("%temp%") ||
    low.startsWith("%tmp%") ||
    low.startsWith("$tmpdir") ||
    low.startsWith("${tmpdir") ||
    low.startsWith("$tmp/") ||
    low.startsWith("[system.io.path]::gettemppath()") ||
    low.startsWith("[io.path]::gettemppath()") ||
    low.startsWith("(join-path $env:temp") ||
    low.startsWith("join-path $env:temp")
  );
}

/** Paths a command writes to by redirection, or by the cmdlets and programs that write a file (pure). */
export function writeTargets(command: string): string[] {
  const targets: string[] = redirectTargets(command);
  // Cmdlets and programs that write: the first path after the verb, or after -Path / -FilePath / -LiteralPath.
  const writers = /\b(?:out-file|set-content|add-content|tee-object|tee|export-csv|export-clixml|new-item|clear-content|set-clipboard)\b([^;|&\n]*)/gi;
  for (const m of command.matchAll(writers)) {
    const args = m[1]!.trim();
    const named = /-(?:file)?path\s+("[^"]+"|'[^']+'|\S+)|-literalpath\s+("[^"]+"|'[^']+'|\S+)|-name\s+("[^"]+"|'[^']+'|\S+)/i.exec(args);
    const first = named ? (named[1] ?? named[2] ?? named[3]!) : /^(?:-\S+\s+)*("[^"]+"|'[^']+'|\S+)/.exec(args)?.[1];
    if (first && !first.startsWith("-")) targets.push(first);
  }
  return targets;
}

/**
 * Why a command may not be run by a verifier, in words it can act on, or null when it may (pure).
 *
 * `temp` is the system's temporary directory, passed in so a test does not depend on the machine.
 */
export function verifierCommandReason(command: string, temp: string = tmpdir()): string | null {
  const text = command.trim();
  if (text === "") return null;
  const refusal = (what: string, instead: string): string =>
    `Refused: a verifier does not ${what}. A verifier runs builds, tests, the typechecker, scripts that call the code, ` +
    `the app, and commands that only read. ${instead} If a check cannot be made without it, report that check as one you could not make, and say why.`;

  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return refusal(rule.what, "What you start in the background is stopped for you when you finish.");
    }
  }
  const outside = outsideAddresses(text);
  if (outside.length > 0 && /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|certutil)\b/i.test(text)) {
    return refusal(`fetch from outside this machine (${outside[0]})`, "Local addresses (localhost, 127.0.0.1) are fine: a debugging port, a dev server.");
  }
  for (const target of writeTargets(text)) {
    if (!isTempPath(target, temp)) {
      return refusal(`write to ${target.replace(/^["']|["']$/g, "")}`, `Write what you need under the temporary directory (${temp}), which is the only place a verifier writes.`);
    }
  }
  return null;
}
