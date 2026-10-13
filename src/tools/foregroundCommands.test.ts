/**
 * foregroundCommands.test.ts — moving a running command to the background yourself.
 *
 * Until ctrl+X only the agent (run_in_background) or the clock (two minutes) could do it.
 * The process needs no change for the move, since a foreground command already writes into
 * a file the background-shell manager can take over; what these pin is the handle the
 * keyboard uses, and that the handover keeps the process alive and tells the model the
 * truth about who did it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ForegroundCommands } from "./foregroundCommands.js";
import { runCommand } from "./runCommand.js";
import { BackgroundShells } from "./backgroundShells.js";
import type { ToolContext } from "./types.js";

const SLEEP = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";

async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function ctxWith(extra: Partial<ToolContext>): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [], ...extra } as unknown as ToolContext;
}

test("the registry lists what runs, oldest first, and forgets what ends", () => {
  const reg = new ForegroundCommands();
  const seen: number[] = [];
  reg.setOnChange(() => seen.push(reg.running().length));
  const a = reg.register({ id: "a", command: "one", startedAt: 200, promote: () => true });
  const b = reg.register({ id: "b", command: "two", startedAt: 100, promote: () => true });
  assert.deepEqual(reg.running().map((c) => c.id), ["a", "b"]);
  assert.equal(reg.oldestStart(), 100, "the hint counts from the one that has waited longest");
  a();
  a(); // a command can settle by more than one road
  b();
  assert.equal(reg.oldestStart(), null);
  assert.deepEqual(seen, [1, 2, 1, 0], "listeners hear every real change and nothing else");
});

test("promoteAll moves every command and survives one that cannot move", () => {
  const reg = new ForegroundCommands();
  const moved: string[] = [];
  reg.register({ id: "a", command: "a", startedAt: 1, promote: () => (moved.push("a"), true) });
  reg.register({ id: "boom", command: "b", startedAt: 1, promote: () => { throw new Error("nope"); } });
  reg.register({ id: "c", command: "c", startedAt: 1, promote: () => (moved.push("c"), true) });
  reg.register({ id: "d", command: "d", startedAt: 1, promote: () => false });
  assert.equal(reg.promoteAll("user"), 2);
  assert.deepEqual(moved, ["a", "c"]);
});

test("a running command is moved to the background by the user, and keeps running", async () => {
  const mgr = new BackgroundShells();
  const fg = new ForegroundCommands();
  const ctx = ctxWith({ backgroundShells: mgr, foregroundCommands: fg });
  try {
    // `sleep` is a pure delay, which the CLOCK never backgrounds (neverBackground). A
    // person who asks is not the clock, so this also proves the request overrides it.
    const run = runCommand.execute({ command: SLEEP, timeout: 120_000 }, ctx, { id: "call-1", progress() {} });
    await waitFor(() => fg.running().length === 1, "the command to register");
    assert.equal(fg.running()[0]!.id, "call-1", "the row can be tied to the command");

    assert.equal(fg.promoteAll("user"), 1);
    const r = await run;

    assert.match(r.output, /The user moved this command to the background/);
    assert.match(r.output, /shell #1/);
    assert.match(r.output, /Do not kill it or start it again/, "the model is told it is the user's to stop");
    assert.doesNotMatch(r.output, /Still running after/, "it must not read like the timeout fired");
    assert.notEqual(r.isError, true);
    assert.equal(fg.running().length, 0, "once moved it is no longer a foreground command");

    const shell = mgr.list()[0]!;
    assert.equal(shell.status, "running", "the same process carries on");
    assert.match(shell.command, /sleep/i);
  } finally {
    for (const s of mgr.list()) mgr.kill(s.id, "user");
    mgr.dispose();
  }
});

test("Esc after the move does not kill it", async () => {
  // The abort listener belongs to the foreground wait. Once the command is somebody
  // else's (a background shell) the turn ending must not take it down.
  const mgr = new BackgroundShells();
  const fg = new ForegroundCommands();
  const abort = new AbortController();
  const ctx = ctxWith({ backgroundShells: mgr, foregroundCommands: fg, abortSignal: abort.signal });
  try {
    const run = runCommand.execute({ command: SLEEP, timeout: 120_000 }, ctx, { id: "call-2", progress() {} });
    await waitFor(() => fg.running().length === 1, "the command to register");
    fg.promoteAll("user");
    await run;
    abort.abort();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mgr.list()[0]!.status, "running", "interrupting the turn must not kill the moved command");
  } finally {
    for (const s of mgr.list()) mgr.kill(s.id, "user");
    mgr.dispose();
  }
});

test("with no manager to take it, nothing moves and the command carries on", async () => {
  const fg = new ForegroundCommands();
  const ctx = ctxWith({ foregroundCommands: fg }); // no backgroundShells
  const command = process.platform === "win32" ? "Start-Sleep -Milliseconds 700; Write-Output done" : "sleep 0.7; echo done";
  const run = runCommand.execute({ command }, ctx, { id: "call-3", progress() {} });
  await waitFor(() => fg.running().length === 1, "the command to register");
  assert.equal(fg.promoteAll("user"), 0, "no manager, no move");
  const r = await run;
  assert.match(r.output, /done/);
  assert.doesNotMatch(r.output, /background/i);
});

test("a command that ends on its own leaves the registry empty", async () => {
  const mgr = new BackgroundShells();
  const fg = new ForegroundCommands();
  try {
    const r = await runCommand.execute({ command: "echo hi" }, ctxWith({ backgroundShells: mgr, foregroundCommands: fg }), {
      id: "call-4",
      progress() {},
    });
    assert.match(r.output, /hi/);
    assert.equal(fg.running().length, 0);
    assert.equal(fg.promoteAll("user"), 0, "a press with nothing running moves nothing");
  } finally {
    mgr.dispose();
  }
});

test("an interrupted command leaves the registry empty", async () => {
  const mgr = new BackgroundShells();
  const fg = new ForegroundCommands();
  const abort = new AbortController();
  try {
    const run = runCommand.execute(
      { command: SLEEP, timeout: 120_000 },
      ctxWith({ backgroundShells: mgr, foregroundCommands: fg, abortSignal: abort.signal }),
      { id: "call-5", progress() {} },
    );
    await waitFor(() => fg.running().length === 1, "the command to register");
    abort.abort();
    const r = await run;
    assert.match(r.output, /interrupted/i);
    assert.equal(fg.running().length, 0);
  } finally {
    mgr.dispose();
  }
});
