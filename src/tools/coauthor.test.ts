/**
 * coauthor.test.ts — the co-author line on commits the agent makes.
 *
 * The rewrite is tested on command text alone (every shape a commit can take, and the shapes that must be left
 * exactly as written), and the whole thing is tested through the real shell tool in a real git repository, so
 * what is asserted is what a commit message actually ends up holding.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTrailer,
  CO_AUTHOR_LINE,
  coauthorSetting,
  countGitCommits,
  NO_PROJECT,
  setCoauthor,
  YES_ALL,
  YES_PROJECT,
} from "./coauthor.js";
import { parseCommand } from "./commandParse.js";
import { runCommand } from "./runCommand.js";
import { APPROVAL_DISMISSED } from "./approval.js";
import type { ToolContext } from "./types.js";

const T = `--trailer "${CO_AUTHOR_LINE}"`;
const rewrite = (command: string, dialect: "posix" | "powershell" = "posix") => addTrailer(command, parseCommand(command, dialect));

// ── the rewrite, on text ─────────────────────────────────────────────────────

test("a commit gets the trailer right after `commit`, whatever else it carries", () => {
  assert.equal(rewrite('git commit -m "fix it"'), `git commit ${T} -m "fix it"`);
  assert.equal(rewrite("git commit --amend --no-edit"), `git commit ${T} --amend --no-edit`);
  assert.equal(rewrite("git commit -F msg.txt"), `git commit ${T} -F msg.txt`);
});

test("a commit after other commands is found, in both shells", () => {
  assert.equal(rewrite('git add -A && git commit -m "x"'), `git add -A && git commit ${T} -m "x"`);
  assert.equal(rewrite('git add -A; git commit -m "x"', "powershell"), `git add -A; git commit ${T} -m "x"`);
});

test("git's own options before `commit` are read past", () => {
  assert.equal(rewrite('git -C sub commit -m "x"'), `git -C sub commit ${T} -m "x"`);
  assert.equal(rewrite('git -c user.name=a -c user.email=b commit -m "x"'), `git -c user.name=a -c user.email=b commit ${T} -m "x"`);
  assert.equal(rewrite('git --no-pager commit -m "x"'), `git --no-pager commit ${T} -m "x"`);
});

test("every commit in a chain gets it", () => {
  assert.equal(rewrite("git commit -m a && git commit -m b"), `git commit ${T} -m a && git commit ${T} -m b`);
});

test("what is not a commit is left alone: other git commands, look-alikes, text that merely contains the words", () => {
  for (const c of ["git status", "git log -1", "git commit-tree abc", "git commit-graph write", 'echo "git commit -m x"', "echo git commit", "ls"]) {
    assert.equal(rewrite(c), null, c);
  }
});

test("a `git commit` inside a string is never touched, even beside a real one", () => {
  assert.equal(rewrite('git commit -m "run git commit later"'), null, "the parsed text and the raw text disagree, so nothing is rewritten");
});

test("an option this does not read leaves the command exactly as written", () => {
  assert.equal(rewrite('git --git-dir /tmp/x commit -m "x"'), null);
});

test("commits are counted from the parsed command, not the text", () => {
  assert.equal(countGitCommits(parseCommand("git commit -m a; git commit -m b", "posix")), 2);
  assert.equal(countGitCommits(parseCommand('echo "git commit"', "posix")), 0);
  assert.equal(countGitCommits(parseCommand("git.exe commit -m a", "powershell")), 1);
});

// ── the answer, remembered ───────────────────────────────────────────────────

const folder = () => realpathSync.native(mkdtempSync(join(tmpdir(), "mw-coauthor-")));

// The answer for all projects is machine-wide, so one test saying yes there would otherwise answer for every later test.
afterEach(() => setCoauthor(folder(), "global", null));

test("nothing is set until someone answers", async () => {
  assert.equal(await coauthorSetting(folder()), null);
});

test("a project's own answer beats the one for all projects, and forgetting it falls back", async () => {
  const a = folder();
  await setCoauthor(a, "global", true);
  assert.deepEqual(await coauthorSetting(a), { credit: true, from: "global" });
  await setCoauthor(a, "project", false);
  assert.deepEqual(await coauthorSetting(a), { credit: false, from: "project" });
  await setCoauthor(a, "project", null);
  assert.deepEqual(await coauthorSetting(a), { credit: true, from: "global" });
  await setCoauthor(a, "global", null);
  assert.equal(await coauthorSetting(a), null);
});

test("a project that said yes does not make another project say yes", async () => {
  const a = folder();
  const b = folder();
  await setCoauthor(a, "project", true);
  assert.equal(await coauthorSetting(b), null);
});

// ── through the real shell tool, in a real repository ────────────────────────

function repo(): string {
  const dir = folder();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  return dir;
}

function message(dir: string): string {
  return execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir }).toString();
}

function ctxFor(cwd: string, answer?: string | ((q: string) => string)): { ctx: ToolContext; asked: string[] } {
  const asked: string[] = [];
  const ctx = { cwd, reads: new Map(), todos: [] } as unknown as ToolContext;
  if (answer !== undefined) {
    ctx.requestApproval = async (question: string) => {
      asked.push(question);
      return typeof answer === "function" ? answer(question) : answer;
    };
  }
  return { ctx, asked };
}

let n = 0;
async function commit(dir: string, ctx: ToolContext, extra = ""): Promise<string> {
  writeFileSync(join(dir, `f${++n}.txt`), String(n));
  const r = await runCommand.execute({ command: `git add -A; git commit ${extra} -m "change ${n}"` }, ctx);
  assert.ok(!r.isError, r.output);
  return message(dir);
}

test("the first commit asks once; yes for this project adds the line, and the next commit does not ask", async () => {
  const dir = repo();
  const { ctx, asked } = ctxFor(dir, YES_PROJECT);
  const first = await commit(dir, ctx);
  assert.match(first, new RegExp(CO_AUTHOR_LINE.replace(/[+.<>]/g, "\\$&")), "the line is in the message");
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /co-author/i);
  const second = await commit(dir, ctx);
  assert.match(second, /Co-authored-by: mwcode </);
  assert.equal(asked.length, 1, "no second question in this project");
  assert.deepEqual(await coauthorSetting(dir), { credit: true, from: "project" });
});

test("the line is the last thing in the message, after a blank line, so git reads it as a trailer", async () => {
  const dir = repo();
  const { ctx } = ctxFor(dir, YES_PROJECT);
  const m = (await commit(dir, ctx)).trimEnd().split("\n");
  assert.equal(m.at(-1), CO_AUTHOR_LINE);
  assert.equal(m.at(-2), "", "a blank line before it");
  const parsed = execFileSync("git", ["log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly)"], { cwd: dir }).toString().trim();
  assert.match(parsed, /mwcode <344669505\+mwcode-agent@users\.noreply\.github\.com>/);
});

test("yes for all projects adds the line here and in another project without asking", async () => {
  const a = repo();
  const b = repo();
  const first = ctxFor(a, YES_ALL);
  await commit(a, first.ctx);
  assert.equal(first.asked.length, 1);
  const other = ctxFor(b, "should never be asked");
  const m = await commit(b, other.ctx);
  assert.match(m, /Co-authored-by: mwcode </);
  assert.equal(other.asked.length, 0);
});

test("no leaves the commit as it was, and the project is not asked again", async () => {
  const dir = repo();
  const { ctx, asked } = ctxFor(dir, NO_PROJECT);
  assert.doesNotMatch(await commit(dir, ctx), /Co-authored-by/);
  assert.doesNotMatch(await commit(dir, ctx), /Co-authored-by/);
  assert.equal(asked.length, 1);
  assert.deepEqual(await coauthorSetting(dir), { credit: false, from: "project" });
});

test("a project's no beats a yes for all projects", async () => {
  const dir = repo();
  await setCoauthor(dir, "global", true);
  await setCoauthor(dir, "project", false);
  const { ctx, asked } = ctxFor(dir, YES_PROJECT);
  assert.doesNotMatch(await commit(dir, ctx), /Co-authored-by/);
  assert.equal(asked.length, 0);
});

test("a dismissed question is not an answer: no line this time, nothing remembered, asked again next time", async () => {
  const dir = repo();
  const { ctx, asked } = ctxFor(dir, APPROVAL_DISMISSED);
  assert.doesNotMatch(await commit(dir, ctx), /Co-authored-by/);
  assert.equal(await coauthorSetting(dir), null);
  await commit(dir, ctx);
  assert.equal(asked.length, 2);
});

test("with nobody to ask there is no question and no line, and nothing is remembered", async () => {
  const dir = repo();
  const { ctx } = ctxFor(dir);
  assert.doesNotMatch(await commit(dir, ctx), /Co-authored-by/);
  assert.equal(await coauthorSetting(dir), null);
});

test("with nobody to ask, a project that already said yes still gets the line", async () => {
  const dir = repo();
  await setCoauthor(dir, "project", true);
  const { ctx } = ctxFor(dir);
  assert.match(await commit(dir, ctx), /Co-authored-by: mwcode </);
});

test("a commit the person typed themselves never gets the line and never asks", async () => {
  const dir = repo();
  await setCoauthor(dir, "project", true);
  const { ctx, asked } = ctxFor(dir, "should never be asked");
  ctx.userInitiated = true;
  assert.doesNotMatch(await commit(dir, ctx), /Co-authored-by/);
  assert.equal(asked.length, 0);
});

test("commands that are not commits never ask", async () => {
  const dir = repo();
  const { ctx, asked } = ctxFor(dir, YES_PROJECT);
  await runCommand.execute({ command: "git status" }, ctx);
  await runCommand.execute({ command: "git log --oneline" }, ctx);
  assert.equal(asked.length, 0);
});

test("a commit that already carries the line gets it once, not twice", async () => {
  const dir = repo();
  await setCoauthor(dir, "project", true);
  writeFileSync(join(dir, "x.txt"), "x");
  const { ctx } = ctxFor(dir);
  await runCommand.execute({ command: `git add -A; git commit -m "x" -m "${CO_AUTHOR_LINE}"` }, ctx);
  assert.equal(message(dir).split("Co-authored-by").length - 1, 1);
});

test("--amend keeps working and adds the line", async () => {
  const dir = repo();
  await setCoauthor(dir, "project", false);
  const { ctx } = ctxFor(dir);
  await commit(dir, ctx);
  await setCoauthor(dir, "project", true);
  const r = await runCommand.execute({ command: "git commit --amend --no-edit" }, ctx);
  assert.ok(!r.isError, r.output);
  assert.match(message(dir), /Co-authored-by: mwcode </);
});

test("git's own options before commit still work", async () => {
  const dir = repo();
  await setCoauthor(dir, "project", true);
  const { ctx } = ctxFor(dir);
  writeFileSync(join(dir, "y.txt"), "y");
  const r = await runCommand.execute({ command: `git add -A; git -c user.name=Other commit -m "with options"` }, ctx);
  assert.ok(!r.isError, r.output);
  assert.match(message(dir), /Co-authored-by: mwcode </);
});
