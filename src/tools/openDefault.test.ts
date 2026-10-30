/**
 * openDefault.test.ts — a named browser becomes the user's own browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultOpenRewrite } from "./openDefault.js";

const win = (c: string) => defaultOpenRewrite(c, "win32");

test("the exact command that kept opening Edge is rewritten", () => {
  // Verbatim from a real run, twice, after a description telling it not to.
  const out = win("Start-Process msedge file:///C:/Projects/myapp/mockup1.html");
  assert.ok(out, "the command was left alone");
  assert.equal(out.browser, "msedge");
  assert.equal(out.target, "file:///C:/Projects/myapp/mockup1.html");
  assert.equal(out.command, 'Start-Process "file:///C:/Projects/myapp/mockup1.html"');
});

test("every browser a model reaches for is caught", () => {
  for (const name of ["msedge", "chrome", "firefox", "brave", "opera", "vivaldi", "chromium", "iexplore"]) {
    assert.ok(win(`Start-Process ${name} https://example.com`), `${name} was not caught`);
  }
});

test("it is caught however the command is spelled", () => {
  const shapes = [
    "Start-Process msedge page.html",
    "start msedge page.html",
    'start "" msedge page.html',
    "msedge page.html",
    "& msedge page.html",
    "msedge.exe page.html",
    'Start-Process "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" page.html',
    "Start-Process -FilePath chrome -ArgumentList page.html",
  ];
  for (const shape of shapes) {
    const out = win(shape);
    assert.ok(out, `not rewritten: ${shape}`);
    assert.equal(out.target, "page.html", `wrong target for: ${shape}`);
    assert.equal(out.command, 'Start-Process "page.html"');
  }
});

test("a quoted path with spaces survives intact", () => {
  const out = win('Start-Process msedge "C:\\My Projects\\mock up.html"');
  assert.equal(out?.target, "C:\\My Projects\\mock up.html");
  assert.equal(out?.command, 'Start-Process "C:\\My Projects\\mock up.html"');
});

test("automation is left alone: flags mean the binary is the point", () => {
  // Headless renders, profiles, remote debugging — real work that names a browser on
  // purpose. Rewriting these would break it to fix a presentation problem.
  for (const cmd of [
    "chrome --headless --screenshot=out.png page.html",
    "Start-Process msedge --headless page.html",
    "chrome --user-data-dir=/tmp/p page.html",
    "chrome --remote-debugging-port=9222",
  ]) {
    assert.equal(win(cmd), null, `should have been left alone: ${cmd}`);
  }
});

test("anything that is not a browser launch is untouched", () => {
  for (const cmd of [
    "npm run build",
    "node server.js",
    "Start-Process notepad file.txt",
    "git status",
    "start .",
  ]) {
    assert.equal(win(cmd), null, `should have been left alone: ${cmd}`);
  }
});

test("a CHAIN is rewritten link by link, and the rest is left exactly as written", () => {
  // The shape the model actually writes, and the one the first version of this skipped:
  //
  //     Start-Process msedge file:///…/mockup.html; Start-Sleep -Seconds 3
  //
  // Launch, then wait for the window. Declining to touch chains meant declining to
  // touch the only form that ever turned up, so it never fired once in real use.
  const out = win("Start-Process msedge file:///C:/x/mockup1.html; Start-Sleep -Seconds 3");
  assert.ok(out, "the chained form was skipped");
  assert.equal(out.command, 'Start-Process "file:///C:/x/mockup1.html"; Start-Sleep -Seconds 3');
  assert.equal(out.browser, "msedge");

  // Other links are untouched, wherever the browser sits in the chain.
  assert.equal(
    win("npm run build; Start-Process msedge page.html")?.command,
    'npm run build; Start-Process "page.html"',
  );
  assert.equal(
    win("Start-Process msedge page.html && echo done")?.command,
    'Start-Process "page.html" && echo done',
  );
});

test("a chain with no browser in it is not rewritten at all", () => {
  assert.equal(win("npm run build; npm test"), null);
  assert.equal(win("git add -A && git commit -m 'x'"), null);
});

test("a semicolon inside a quoted path does not split the command", () => {
  // Splitting on a separator inside quotes would cut a path in half and rewrite a
  // fragment, which is worse than not rewriting at all.
  const out = win('Start-Process msedge "C:\\odd;name\\page.html"');
  assert.equal(out?.target, "C:\\odd;name\\page.html");
  assert.equal(out?.command, 'Start-Process "C:\\odd;name\\page.html"');
});

test("a browser with no target is not a page being opened", () => {
  assert.equal(win("Start-Process msedge"), null);
  assert.equal(win("chrome"), null);
});

test("the replacement fits the platform", () => {
  assert.equal(defaultOpenRewrite("chrome page.html", "darwin")?.command, 'open "page.html"');
  assert.equal(defaultOpenRewrite("chrome page.html", "linux")?.command, 'xdg-open "page.html"');
});

// ── The interception, not just the rule ──────────────────────────────────────
// A description asking the model not to name a browser was already in place when a real
// run launched Edge by name anyway. These assert the mechanical version: run_command
// rewrites the command itself, so there is nothing left for the model to remember.

test("run_command runs the DEFAULT-browser command, not the one it was given", async () => {
  const { runCommand } = await import("./runCommand.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const cwd = await mkdtemp(join(tmpdir(), "mw-open-"));
  const ctx = { cwd, reads: new Map(), checkpoints: undefined } as never;

  // `--%` is not needed: what matters is which command string reached the shell, and the
  // summary reports it verbatim.
  const result = await runCommand.execute(
    { command: "Start-Process msedge file:///C:/nope/page.html" },
    ctx,
  );

  assert.ok(!/msedge/i.test(result.summary ?? ""), `msedge still ran: ${result.summary}`);
  assert.match(result.output, /DEFAULT browser/);
  assert.match(result.output, /do not\s+name one/i);
});

test("a command with no browser in it is passed through untouched", async () => {
  const { runCommand } = await import("./runCommand.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const cwd = await mkdtemp(join(tmpdir(), "mw-open-"));
  const ctx = { cwd, reads: new Map(), checkpoints: undefined } as never;
  const result = await runCommand.execute({ command: "echo hello" }, ctx);
  assert.match(result.summary ?? "", /echo hello/);
  assert.ok(!/DEFAULT browser/.test(result.output), "an unrelated command was annotated");
});
