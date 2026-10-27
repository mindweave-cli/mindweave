/**
 * coauthor.ts — the "Co-authored-by: mwcode" line on commits the agent makes.
 *
 * Only a commit the AGENT runs through `run_command` gets it. A commit the person types (`!git commit`) never
 * does, and neither does one the agent has not been allowed to credit: the first time the agent commits in a
 * project it asks once, and the answer is remembered for that project (or for every project, if the person said
 * so). After that there is no question. Where nobody can be asked (a headless run, a sub-agent) there is no
 * question either, and the line is added only when the person already said yes.
 *
 * The line goes in with git's own `--trailer` option, so it lands in the trailer block whatever else the message
 * holds, and it works with `-m`, `-F` and `--amend`. The command is rewritten only when its text can be read
 * with certainty: the places `git commit` appears in the parsed command and in the raw text have to agree,
 * so a `git commit` inside a quoted string is never touched.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { governanceDir, type GovernanceScope } from "../governor/index.js";
import { verbOf, type ParsedCommand } from "./commandParse.js";
import type { ToolContext } from "./types.js";

/** The line, as it appears at the end of a commit message. The address is the account's private GitHub address. */
export const CO_AUTHOR_LINE = "Co-authored-by: mwcode <344669505+mwcode-agent@users.noreply.github.com>";

/** What identifies the line inside a command, so one that already carries it is left alone. */
const MARK = "mwcode-agent@users.noreply.github.com";

const FILE = "coauthor.json";

export const YES_PROJECT = "Yes, for this project";
export const YES_ALL = "Yes, for all my projects";
export const NO_PROJECT = "No, not in this project";

export const COAUTHOR_QUESTION = "Credit mwcode as a co-author on the commits I make?";
export const COAUTHOR_DETAIL =
  `It adds one line to the end of each commit message I make:\n${CO_AUTHOR_LINE}\n` +
  "Commits you make yourself never get it. You will not be asked again in this project; /coauthor changes it.";

export interface CoauthorSetting {
  credit: boolean;
  /** Which answer decided it. */
  from: GovernanceScope;
}

async function readFile(dir: string): Promise<boolean | null> {
  try {
    const raw = JSON.parse(await fs.readFile(join(dir, FILE), "utf8")) as { credit?: unknown };
    return typeof raw.credit === "boolean" ? raw.credit : null;
  } catch {
    return null;
  }
}

/** The answer in force for a project: its own, else the one for all projects, else none yet. */
export async function coauthorSetting(cwd: string): Promise<CoauthorSetting | null> {
  const project = await readFile(governanceDir(cwd, "project"));
  if (project !== null) return { credit: project, from: "project" };
  const global = await readFile(governanceDir(cwd, "global"));
  return global === null ? null : { credit: global, from: "global" };
}

/** Record an answer for one scope, or (null) forget it so the next commit asks again. */
export async function setCoauthor(cwd: string, scope: GovernanceScope, credit: boolean | null): Promise<void> {
  const dir = governanceDir(cwd, scope);
  const file = join(dir, FILE);
  if (credit === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ credit }, null, 2), "utf8");
}

/** Git's global options that take the next word as their value. */
const OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Whether this simple command is `git commit`, past git's own options (`git -C dir commit`). */
function isGitCommit(words: string[]): boolean {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (OPTIONS_WITH_VALUE.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    return w === "commit";
  }
  return false;
}

/** How many real `git commit` commands the parsed text runs. */
export function countGitCommits(parsed: ParsedCommand): number {
  return parsed.commands.filter((c) => verbOf(c) === "git" && isGitCommit(c.words)).length;
}

/** `git`, git's own options, then `commit`, in the raw text. Each option is one word or an option with its value. */
const COMMIT_IN_TEXT =
  /\bgit(?:\.exe)?(?:\s+(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--?[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S+))?)*\s+commit(?=\s|$|;|&|\|)/gi;

/**
 * The command with the trailer added to every `git commit` in it, or null when that cannot be done with
 * certainty: the raw text and the parsed command must find the same number of commits, so a `git commit` inside
 * a string, or an option this does not read, leaves the command exactly as written.
 */
export function addTrailer(command: string, parsed: ParsedCommand): string | null {
  const real = countGitCommits(parsed);
  if (real === 0 || parsed.unreadable) return null;
  const found = command.match(COMMIT_IN_TEXT)?.length ?? 0;
  if (found !== real) return null;
  return command.replace(COMMIT_IN_TEXT, (m) => `${m} --trailer "${CO_AUTHOR_LINE}"`);
}

/** `--trailer` arrived in git 2.32. */
let trailerSupport: Promise<boolean> | undefined;

export function gitSupportsTrailer(): Promise<boolean> {
  trailerSupport ??= new Promise<boolean>((resolve) => {
    execFile("git", ["--version"], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      const m = /(\d+)\.(\d+)/.exec(String(stdout));
      if (error || !m) return resolve(false);
      const major = Number(m[1]);
      const minor = Number(m[2]);
      resolve(major > 2 || (major === 2 && minor >= 32));
    });
  });
  return trailerSupport;
}

/** For tests: forget the cached git version. */
export function resetGitVersionForTests(): void {
  trailerSupport = undefined;
}

/**
 * The command to run: the same text, with the trailer added when the agent is committing and the project has
 * said yes. Asks once when it has not been asked. Anything unclear leaves the command unchanged.
 */
export async function withCoauthor(command: string, parsed: ParsedCommand, ctx: ToolContext): Promise<string> {
  // The person's own commands are theirs. A commit that already carries the line needs nothing.
  if (ctx.userInitiated || command.includes(MARK)) return command;
  if (countGitCommits(parsed) === 0) return command;

  const root = ctx.governance?.forbidden.root ?? ctx.cwd;
  let setting = await coauthorSetting(root);
  if (!setting) {
    // Nobody to ask (a headless run, a sub-agent): no question, and no credit until the person has said yes.
    if (!ctx.requestApproval) return command;
    const choice = await ctx.requestApproval(COAUTHOR_QUESTION, [YES_PROJECT, YES_ALL, NO_PROJECT], COAUTHOR_DETAIL);
    if (choice === YES_PROJECT) {
      await setCoauthor(root, "project", true);
      setting = { credit: true, from: "project" };
    } else if (choice === YES_ALL) {
      await setCoauthor(root, "global", true);
      setting = { credit: true, from: "global" };
    } else if (choice === NO_PROJECT) {
      await setCoauthor(root, "project", false);
      return command;
    } else {
      // Dismissed, or an answer that is none of the options: not an answer. Commit without the line, ask next time.
      return command;
    }
  }
  if (!setting.credit) return command;
  if (!(await gitSupportsTrailer())) return command;
  return addTrailer(command, parsed) ?? command;
}
