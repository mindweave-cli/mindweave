/**
 * backgroundShells.test.ts — the background-shell lifecycle: adopt → buffer →
 * complete → one-shot notify (no repeat), incremental reads, and kill. Plus
 * run_command auto-backgrounding on a short timeout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  BackgroundShells,
  isInteractiveServerCommand,
  findRunningDuplicate,
  findRecentUserClose,
  REOPEN_COOLDOWN_MS,
  shouldWakeOnEnd,
  guessNotifyPolicy,
  detectPort,
  looksLikePrompt,
} from "./backgroundShells.js";
import type { ShellInfo } from "./backgroundShells.js";
import { runCommand } from "./runCommand.js";
import { shellsTool, killShell } from "./shellTools.js";
import type { ToolContext } from "./types.js";
import { isProcessStopped } from "./killTree.js";

const NODE = process.execPath;
const IS_WIN = process.platform === "win32";
const DETACH = !IS_WIN;

/**
 * A shell command that runs a node `-e` script, valid in the active shell
 * runCommand uses. PowerShell needs the call operator (`&`) to invoke a quoted
 * executable path; POSIX sh runs the quoted path directly. The script is kept
 * free of quote characters so neither shell mangles it.
 */
function nodeCmd(script: string): string {
  return `${IS_WIN ? "& " : ""}"${NODE}" -e "${script}"`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitUntil(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await sleep(20);
  }
}

test("adopt → complete → one-shot notifications (model + UI), no repeat", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('hello'); console.error('world')"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node -e print", cwd: process.cwd() });
  assert.equal(info.status, "running");

  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.status, "exited");
  assert.equal(mgr.list()[0]!.exitCode, 0);

  // Model drain: once, with a tail, then never again.
  const drained = await mgr.drainEvents();
  assert.equal(drained.length, 1);
  assert.match(drained[0]!.tail, /hello/);
  assert.equal((await mgr.drainEvents()).length, 0);
  assert.equal(mgr.pendingCount(), 0);

  // UI drain: once, then never again.
  assert.equal(mgr.takeUiEvents().length, 1);
  assert.equal(mgr.takeUiEvents().length, 0);
  mgr.dispose();
});

test("read returns only NEW output each time", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('first')"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const a = await mgr.read(info.id);
  assert.match(a!.chunk, /first/);
  const b = await mgr.read(info.id); // nothing new since last read
  assert.equal(b!.chunk, "");
  mgr.dispose();
});

test("kill stops a running shell", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "node sleep", cwd: process.cwd() });
  assert.equal(mgr.runningCount(), 1);
  assert.equal(mgr.kill(info.id), true);
  assert.equal(mgr.list()[0]!.status, "killed");
  assert.equal(mgr.kill(info.id), false); // already stopped
  mgr.dispose();
});

test("isInteractiveServerCommand: dev servers vs finite tasks", () => {
  for (const c of ["npm run dev", "pnpm start", "yarn serve", "tauri dev", "npm run tauri dev", "vite", "next dev", "nodemon server.js"]) {
    assert.equal(isInteractiveServerCommand(c), true, `${c} should be interactive`);
  }
  for (const c of ["npm run build", "npm test", "tsc", "vite build", "tauri build", "cargo build", "npm run lint", "git status"]) {
    assert.equal(isInteractiveServerCommand(c), false, `${c} should NOT be interactive`);
  }
});

test("a dev server that exits instantly never came up, so it DOES interrupt", async () => {
  // Exit code 0, but in a few milliseconds: a dev script that quits immediately did
  // not start a server, and the user never saw one. The old rule read the zero and
  // stayed silent, which hid a broken script.
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('vite ready')"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.exitCode, 0);
  assert.equal(mgr.list()[0]!.ready, false, "it never came up");
  assert.equal(mgr.pendingCount(), 1);

  const events = await mgr.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.wake, true);
  // And the stop is visible in the chat either way.
  assert.equal(mgr.takeUiEvents().length, 1);
  mgr.dispose();
});

test("a killed dev server does NOT wake the model", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "tauri dev", cwd: process.cwd() });
  assert.equal(mgr.kill(info.id), true);
  assert.equal(mgr.list()[0]!.status, "killed");
  assert.equal(mgr.pendingCount(), 0);
  mgr.dispose();
});

test("a dev server that CRASHES (non-zero) still wakes the model", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.exitCode, 1);
  assert.equal(mgr.pendingCount(), 1);
  assert.equal((await mgr.drainEvents()).length, 1);
  mgr.dispose();
});

// ── How a shell ENDED decides whether the model hears about it ───────────────
//
// These pin the measured behaviour of a real close. On Windows `taskkill /T` (what
// /shells, killTree and closing a console app all amount to) reports code 1, and
// SIGTERM/SIGINT report code null. The old `code === 0` rule missed all three, so
// closing your app told the model it had crashed and the model reopened it.

const SERVER = { notify: "on_failure", killed: false } as const;

test("closing an app you had running does NOT interrupt, however it ends", () => {
  // It came up, so the user watched it run and then stopped it. Nothing to break in
  // for, whichever way the process actually died.
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: null, cameUp: true }), false);
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: "SIGTERM", cameUp: true }), false);
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: "SIGINT", cameUp: true }), false);
});

test("a signal ends a server quietly even if it never came up", () => {
  // Ctrl+C two seconds after launching is still someone stopping it.
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: "SIGTERM", cameUp: false }), false);
});

test("a server that never came up DOES interrupt", () => {
  // The user never saw it running, so they cannot know it failed. This is the one
  // case where breaking in is the point.
  assert.equal(shouldWakeOnEnd({ ...SERVER, signal: null, cameUp: false }), true);
});

test("we killed it ourselves, so there is nothing to interrupt about", () => {
  assert.equal(shouldWakeOnEnd({ notify: "on_failure", killed: true, signal: null, cameUp: false }), false);
  assert.equal(shouldWakeOnEnd({ notify: "on_finish", killed: true, signal: null, cameUp: true }), false);
});

test("a finite task always interrupts, however it ended", () => {
  const task = { notify: "on_finish", killed: false } as const;
  assert.equal(shouldWakeOnEnd({ ...task, signal: null, cameUp: true }), true);
  assert.equal(shouldWakeOnEnd({ ...task, signal: "SIGTERM", cameUp: false }), true);
});

test("the exit code is deliberately not part of the decision", () => {
  // Measured: a closed app and a port conflict BOTH report code 1 on Windows, and a
  // signalled process reports none. Whether it came up is what separates them, so the
  // rule takes no exit code at all. If one reappears in this signature, that lesson
  // is being relearned.
  const keys = Object.keys({ notify: 0, killed: 0, signal: 0, cameUp: 0 });
  assert.ok(!keys.includes("code"), "shouldWakeOnEnd must not consult an exit code");
  assert.ok(!keys.includes("ranForMs"), "duration lives in the readiness timer, not here");
});

test("a dev server stopped from OUTSIDE does not wake the model", async () => {
  // The real scenario end to end: the process is ended by something that is not our
  // kill(), so `killed` is false and only the signal/exit tells us what happened.
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run tauri dev", cwd: process.cwd() });
  child.kill(); // the user closes the window
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.pendingCount(), 0, "closing the app must not queue a wake-up");
  // Delivered, but as background fact rather than news. Deleting it was the defect.
  const events = await mgr.drainEvents();
  assert.equal(events.length, 1, "the model must still learn it stopped");
  assert.equal(events[0]!.wake, false);
  assert.equal(mgr.takeUiEvents().length, 1, "the user should still SEE that it stopped");
  mgr.dispose();
});

test("a finite task (build) exiting cleanly still wakes the model to report", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('built ok')"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run build", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.pendingCount(), 1);
  assert.equal((await mgr.drainEvents()).length, 1);
  mgr.dispose();
});

test("run_command moves a slow command to the background instead of killing it", async () => {
  const mgr = new BackgroundShells();
  const ctx: ToolContext = { cwd: process.cwd(), reads: new Map(), todos: [], backgroundShells: mgr };
  // Sleeps ~3s, but we only wait 1s inline → it should background, not die.
  const res = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 3000)"), timeout: 1000 },
    ctx,
  );
  assert.ok(!res.isError);
  assert.match(res.output, /moved to the background as shell #\d+/);
  assert.equal(mgr.runningCount(), 1); // still alive

  // And it finishes on its own, then notifies once. The wait is generous on purpose:
  // the command sleeps 3s, but a shared CI runner also has to start a shell and a
  // node process first, and this failed once at 8s while the identical job on a less
  // busy runner passed. What is being tested is that it backgrounds rather than dies,
  // not how fast a loaded machine can spawn a process.
  await waitUntil(() => mgr.running().length === 0, 30_000);
  const drained = await mgr.drainEvents();
  assert.equal(drained.length, 1);
  mgr.dispose();
});

// ── Fix C: don't launch a server that's already running ──

function shell(id: number, command: string): ShellInfo {
  return {
    id,
    command,
    cwd: "/p",
    status: "running",
    exitCode: null,
    startedAt: 0,
    finishedAt: null,
    notify: "on_finish",
    ready: false,
  };
}

test("a shell finalizes even when a surviving grandchild holds the pipe open", { timeout: 30_000 }, async (t) => {
  if (!IS_WIN) {
    t.skip("the orphaned-grandchild pipe hold is the Windows shell-spawn shape");
    return;
  }
  // `close` fires only once every stdio stream closes. Kill the shell wrapper and the
  // grandchild keeps the pipe open, so `close` never arrives and the entry used to sit
  // at "running" for the rest of the session. The `exit` backstop has to finalize it.
  const mgr = new BackgroundShells(FAST_STARTUP_MS, FAST_EXIT_MS);
  const wrapper = spawn(`node -e "setInterval(()=>{},1000)"`, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });
  mgr.adopt(wrapper, { command: "npm run dev", cwd: process.cwd() });
  await sleep(800);

  const { execSync } = await import("node:child_process");
  const kids = execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${wrapper.pid} } | Select-Object -ExpandProperty ProcessId"`,
    { encoding: "utf8" },
  )
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);

  wrapper.kill(); // only the wrapper — the grandchild survives, still holding stdout
  await waitUntil(() => mgr.list()[0]!.status !== "running", 15_000);
  assert.notEqual(mgr.list()[0]!.status, "running", "the entry must not be stranded as running");

  mgr.dispose();
  for (const pid of kids) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
});

test("an interrupted turn does not leave a background process running", async () => {
  // run_command's background branch returns BEFORE the abort listener is wired, so it
  // has to check the signal itself. Without that, Esc still launches a dev server that
  // outlives the turn — exactly what backgrounding is designed to do.
  const mgr = new BackgroundShells();
  const controller = new AbortController();
  controller.abort();
  const ctx = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    reads: new Map(),
    backgroundShells: mgr,
    abortSignal: controller.signal,
  } as unknown as Parameters<typeof runCommand.execute>[1];

  const result = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 100000)"), run_in_background: true },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.match(result.output, /interrupt/i);
  assert.equal(mgr.list().length, 0, "nothing should have been adopted after an abort");
  mgr.dispose();
});

test("findRunningDuplicate: matches the same server command (ignoring whitespace/case)", () => {
  const running = [shell(2, "npm run tauri dev")];
  assert.equal(findRunningDuplicate(running, "npm  run   tauri dev")?.id, 2);
  assert.equal(findRunningDuplicate(running, "NPM RUN TAURI DEV")?.id, 2);
});

test("findRunningDuplicate: distinct servers do not collide", () => {
  const running = [shell(2, "npm run dev"), shell(3, "cargo run")];
  assert.equal(findRunningDuplicate(running, "npm run build"), undefined);
  assert.equal(findRunningDuplicate(running, "vite preview"), undefined);
  // But an exact repeat of one of them is caught.
  assert.equal(findRunningDuplicate(running, "cargo run")?.id, 3);
});

test("findRunningDuplicate: nothing running means nothing to collide with", () => {
  assert.equal(findRunningDuplicate([], "npm run tauri dev"), undefined);
});

// ── The reopen guard: don't relaunch an app the user just closed ─────────────

function closed(
  id: number,
  command: string,
  opts: { finishedAt: number; ready?: boolean; stoppedBy?: "user" | "agent"; status?: "exited" | "killed" },
): ShellInfo {
  return {
    id,
    command,
    cwd: "/p",
    status: opts.status ?? "exited",
    exitCode: 0,
    startedAt: 0,
    finishedAt: opts.finishedAt,
    notify: "on_failure",
    ready: opts.ready ?? true,
    ...(opts.stoppedBy ? { stoppedBy: opts.stoppedBy } : {}),
  };
}

test("findRecentUserClose: an app that came up and was closed (no kill) is a recent user-close", () => {
  const now = 1_000_000;
  const shells = [closed(5, "npm run start", { finishedAt: now - 3000 })];
  assert.equal(findRecentUserClose(shells, "npm run start", now)?.id, 5);
  // Normalized like the duplicate check: whitespace and case don't matter.
  assert.equal(findRecentUserClose(shells, "NPM  run   start", now)?.id, 5);
});

test("findRecentUserClose: an explicit user stop counts too", () => {
  const now = 1_000_000;
  const shells = [closed(5, "npm run start", { finishedAt: now - 3000, stoppedBy: "user", status: "killed" })];
  assert.equal(findRecentUserClose(shells, "npm run start", now)?.id, 5);
});

test("findRecentUserClose: an app the AGENT killed is NOT a user-close (its own restart is fine)", () => {
  const now = 1_000_000;
  const shells = [closed(5, "npm run start", { finishedAt: now - 3000, stoppedBy: "agent", status: "killed" })];
  assert.equal(findRecentUserClose(shells, "npm run start", now), undefined);
});

test("findRecentUserClose: a server that never came up is NOT blocked (the agent should be free to fix it)", () => {
  const now = 1_000_000;
  const shells = [closed(5, "npm run start", { finishedAt: now - 3000, ready: false })];
  assert.equal(findRecentUserClose(shells, "npm run start", now), undefined);
});

test("findRecentUserClose: outside the cooldown it no longer blocks (a later restart is allowed)", () => {
  const now = 1_000_000;
  const shells = [closed(5, "npm run start", { finishedAt: now - REOPEN_COOLDOWN_MS - 1 })];
  assert.equal(findRecentUserClose(shells, "npm run start", now), undefined);
});

test("findRecentUserClose: a still-running shell and a different command do not match", () => {
  const now = 1_000_000;
  assert.equal(findRecentUserClose([shell(5, "npm run start")], "npm run start", now), undefined, "running is caught by the duplicate guard, not this one");
  assert.equal(findRecentUserClose([closed(5, "npm run start", { finishedAt: now - 3000 })], "npm run build", now), undefined);
});

test("run_command refuses to reopen an app the user just closed, then allows it once the agent kills its own restart", async () => {
  // Short startup grace so "it came up" fires fast instead of after the 10s default.
  const mgr = new BackgroundShells(50, 2_000);
  const ctx = { cwd: process.cwd(), roots: [process.cwd()], reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;

  // 1. A server the agent started comes up.
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "npm run start", cwd: process.cwd(), notify: "on_failure" });
  await waitUntil(() => mgr.list().find((s) => s.id === info.id)!.ready, 10_000);

  // 2. The USER closes it themselves — the process ends without a kill_shell.
  const proc = (mgr as unknown as { shells: Map<number, { child: { kill(): void } | null }> }).shells.get(info.id)!;
  proc.child!.kill();
  await waitUntil(() => mgr.list().find((s) => s.id === info.id)!.status !== "running");

  // 3. The agent tries to reopen the same command — refused, not relaunched.
  const reopen = await runCommand.execute({ command: "npm run start", run_in_background: true }, ctx);
  assert.equal(reopen.isError, true, `reopening a user-closed app must be refused, got: ${reopen.output}`);
  assert.match(reopen.output, /not reopening|closed .* themselves/i, `got: ${reopen.output}`);
  assert.equal(mgr.running().length, 0, "nothing should have been relaunched");

  mgr.dispose();
});

// ── The policy is DECLARED, not guessed ─────────────────────────────────────

test("the decision is keyed on the declared policy", () => {
  const ended = { killed: false, signal: null, cameUp: true };
  // The same ending, three different answers, decided by what the caller asked for.
  assert.equal(shouldWakeOnEnd({ ...ended, notify: "on_finish" }), true);
  assert.equal(shouldWakeOnEnd({ ...ended, notify: "on_failure" }), false);
  assert.equal(shouldWakeOnEnd({ ...ended, notify: "never" }), false);
});

test("never means never, even for a task that failed on startup", () => {
  assert.equal(
    shouldWakeOnEnd({ notify: "never", killed: false, signal: null, cameUp: false }),
    false,
  );
});

test("a declared policy beats the name guess", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('done')"], { detached: DETACH });
  // `npm run dev` would be guessed as a server; the caller says it is a task.
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_finish" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");
  assert.equal(mgr.list()[0]!.notify, "on_finish");
  assert.equal(mgr.pendingCount(), 1, "a declared task must report even though it looks like a server");
  mgr.dispose();
});

test("guessNotifyPolicy is only a fallback, and is honest about what it knows", () => {
  assert.equal(guessNotifyPolicy("npm run dev"), "on_failure");
  assert.equal(guessNotifyPolicy("npm run build"), "on_finish");
  // The cases the name list cannot see. These are why the caller should declare.
  assert.equal(guessNotifyPolicy("cargo run"), "on_finish");
  assert.equal(guessNotifyPolicy("docker compose up"), "on_finish");
});

/**
 * Grace periods short enough to test in milliseconds.
 *
 * The shipped values are 10s and 2s, and waiting them out per case made this file 73%
 * of the whole suite's wall time. What these tests check is the MECHANISM — that a
 * process surviving its grace reports ready exactly once, that a stop is still
 * delivered — and none of that depends on the number being ten seconds.
 */
const FAST_STARTUP_MS = 250;
const FAST_EXIT_MS = 100;

// ── Readiness: the event a server actually has ──────────────────────────────

test("a server that stays up reports READY, once, and not as a failure", { timeout: 30_000 }, async () => {
  const mgr = new BackgroundShells(FAST_STARTUP_MS, FAST_EXIT_MS);
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });

  assert.equal(mgr.pendingCount(), 0, "nothing to say the instant it spawns");
  await waitUntil(() => mgr.list()[0]!.ready, 25_000);

  const events = await mgr.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "ready");
  // One-shot: the property that stops background jobs eating the context window.
  assert.equal((await mgr.drainEvents()).length, 0);
  assert.equal(mgr.pendingCount(), 0);

  mgr.kill(events[0]!.info.id, "user");
  mgr.dispose();
});

test("a server that dies before the grace never reports ready", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const events = await mgr.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "ended", "a failed start is an ending, not a readiness");
  assert.equal(mgr.list()[0]!.ready, false);
  mgr.dispose();
});

// ── Who stopped it ──────────────────────────────────────────────────────────

test("a shell records who stopped it, and tells neither of them", async () => {
  const mgr = new BackgroundShells();
  const a = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const b = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const first = mgr.adopt(a, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  const second = mgr.adopt(b, { command: "npm test", cwd: process.cwd(), notify: "on_finish" });

  mgr.kill(first.id, "user");
  mgr.kill(second.id, "agent");

  const byId = new Map(mgr.list().map((s) => [s.id, s]));
  assert.equal(byId.get(first.id)!.stoppedBy, "user");
  assert.equal(byId.get(second.id)!.stoppedBy, "agent");
  // Whoever pressed the button already knows, so neither wakes the model.
  assert.equal(mgr.pendingCount(), 0);
  mgr.dispose();
});

// ── Told, but not interrupted ────────────────────────────────────────────────
//
// The defect this fixes: a stop that wasn't worth interrupting for was DELETED, so
// the model could never say the app had stopped, and had no answer when asked why it
// was down. It must now always arrive, just without breaking into the session.

test("a stop the user caused is still DELIVERED, it just doesn't interrupt", { timeout: 30_000 }, async () => {
  const mgr = new BackgroundShells(FAST_STARTUP_MS, FAST_EXIT_MS);
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });

  // Let it come up, so this is a real "the user watched it run" stop.
  await waitUntil(() => mgr.list()[0]!.ready, 25_000);
  await mgr.drainEvents(); // clear the readiness event

  child.kill(); // the user closes the window, from outside
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  assert.equal(mgr.pendingCount(), 0, "a stop the user caused must NOT interrupt");

  const events = await mgr.drainEvents();
  assert.equal(events.length, 1, "but it must still be delivered");
  assert.equal(events[0]!.kind, "ended");
  assert.equal(events[0]!.wake, false, "delivered as background fact, not as news");
  assert.equal(events[0]!.info.id, info.id);

  // Still one-shot: delivered exactly once, never again.
  assert.equal((await mgr.drainEvents()).length, 0);
  mgr.dispose();
});

test("a server that never came up both interrupts AND is delivered", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.error('EADDRINUSE'); process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  assert.equal(mgr.pendingCount(), 1, "the user never saw it, so this must interrupt");
  const events = await mgr.drainEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.wake, true);
  assert.match(events[0]!.tail, /EADDRINUSE/, "the error output rides along");
  mgr.dispose();
});

test("a shell told to say nothing is delivered without interrupting", async () => {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "some-daemon", cwd: process.cwd(), notify: "never" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  assert.equal(mgr.pendingCount(), 0, "never means never interrupt");
  const events = await mgr.drainEvents();
  assert.equal(events.length, 1, "the model still learns it is gone");
  assert.equal(events[0]!.wake, false);
  mgr.dispose();
});

// ── End to end, through the real tools ──────────────────────────────────────
//
// The reported scenario, driven the way the model drives it: run_command starts a
// server, shell_output is consulted while it starts, the user closes it, and
// list_shells is asked what happened. Every assertion here is something that was
// wrong in at least one build.

test("the whole reported scenario, through run_command / shell_output / list_shells", { timeout: 60_000 }, async () => {
  const mgr = new BackgroundShells();
  const ctx = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    reads: new Map(),
    todos: [],
    backgroundShells: mgr,
  } as unknown as ToolContext;

  // 1. The model starts a dev server. It must be told it will hear about READINESS,
  //    and must NOT be promised a report when it finishes.
  const started = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 100000)"), run_in_background: true, notify: "on_failure" },
    ctx,
  );
  assert.match(started.output, /WILL be told once it has come up/);
  assert.doesNotMatch(started.output, /notified AUTOMATICALLY the moment it finishes/);
  const id = mgr.running()[0]!.id;

  // 2. It peeks while the thing is still starting. Same rule: no false promise.
  const early = await shellsTool.execute({ id }, ctx);
  assert.match(early.output, /Still starting/);
  assert.match(early.output, /will NOT be told when it later stops/);
  assert.doesNotMatch(early.output, /when it finishes/);

  // 3. It comes up. That is the one positive event, and it interrupts exactly once.
  await waitUntil(() => mgr.list().find((s) => s.id === id)!.ready, 25_000);
  assert.equal(mgr.pendingCount(), 1, "coming up should interrupt so the model can report it");
  const ready = await mgr.drainEvents();
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.kind, "ready");

  const upList = await shellsTool.execute({}, ctx);
  assert.match(upList.output, /#\d+ up \(/, `list_shells should say it is up, got: ${upList.output}`);

  // 4. The user closes it themselves, from outside.
  mgr.list().find((s) => s.id === id); // sanity
  const proc = (mgr as unknown as { shells: Map<number, { child: { kill(): void } | null }> }).shells.get(id)!;
  proc.child!.kill();
  await waitUntil(() => mgr.list().find((s) => s.id === id)!.status !== "running");

  // 5. THE BUG: this must not interrupt, and must not be swallowed either.
  assert.equal(mgr.pendingCount(), 0, "closing your own app must not interrupt");
  const ended = await mgr.drainEvents();
  assert.equal(ended.length, 1, "but the model must still be told it stopped");
  assert.equal(ended[0]!.kind, "ended");
  assert.equal(ended[0]!.wake, false);

  // 6. And afterwards the model can answer "why is my app down?" from list_shells.
  const afterList = await shellsTool.execute({}, ctx);
  assert.match(afterList.output, /after it had come up|stopped by/, `list_shells must explain the stop, got: ${afterList.output}`);

  mgr.dispose();
});

test("listing shells while one is running nudges against the poll loop and the never-finishes trap", async () => {
  // The bug this closes: a model that checks "what's running" on a loop was never told to
  // stop, and kept waiting for a dev server to "finish" — which never happens. The read
  // path (by id) already nudges; the list path did not, so a poll via the list looped.
  const mgr = new BackgroundShells();
  const ctx = { cwd: process.cwd(), roots: [process.cwd()], reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run start", cwd: process.cwd(), notify: "on_failure" });
  await waitUntil(() => mgr.runningCount() === 1);

  const listed = await shellsTool.execute({}, ctx);
  assert.match(listed.output, /do NOT list this on a loop/i, `list must nudge against polling, got: ${listed.output}`);
  assert.match(listed.output, /end your turn/i, `got: ${listed.output}`);
  assert.match(listed.output, /never wait for one to "finish/i, `got: ${listed.output}`);
  mgr.dispose();
});

test("listing shells with nothing running does not nudge — a finished list is a fact, not a poll", async () => {
  const mgr = new BackgroundShells();
  const ctx = { cwd: process.cwd(), roots: [process.cwd()], reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const child = spawn(NODE, ["-e", "process.exit(0)"], { detached: DETACH });
  mgr.adopt(child, { command: "echo done", cwd: process.cwd(), notify: "on_finish" });
  await waitUntil(() => mgr.runningCount() === 0);

  const listed = await shellsTool.execute({}, ctx);
  assert.doesNotMatch(listed.output, /do NOT list this on a loop/i, `a settled list must not nudge, got: ${listed.output}`);
  mgr.dispose();
});

test("a server that never comes up is described as such, not as a bare exit code", async () => {
  const mgr = new BackgroundShells();
  const ctx = { cwd: process.cwd(), roots: [process.cwd()], reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const child = spawn(NODE, ["-e", "console.error('EADDRINUSE: port taken'); process.exit(1)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const listed = await shellsTool.execute({}, ctx);
  assert.match(listed.output, /never came up/, `got: ${listed.output}`);
  assert.equal(mgr.pendingCount(), 1, "the user never saw it, so this interrupts");
  mgr.dispose();
});

test("a signalled shell never describes itself as 'exited null'", async () => {
  const mgr = new BackgroundShells();
  const ctx = { cwd: process.cwd(), roots: [process.cwd()], reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const child = spawn(NODE, ["-e", "setTimeout(()=>{}, 100000)"], { detached: DETACH });
  mgr.adopt(child, { command: "npm run dev", cwd: process.cwd(), notify: "on_failure" });
  child.kill(); // ends by signal, so there IS no exit code
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  assert.equal(mgr.list()[0]!.exitCode, null, "a signalled process has no exit code");
  const listed = await shellsTool.execute({}, ctx);
  assert.doesNotMatch(listed.output, /exited null/, `got: ${listed.output}`);
  assert.match(listed.output, /stopped \(SIG/, `got: ${listed.output}`);
  mgr.dispose();
});

// ── the shell trio's claims, pinned ──────────────────────────────────────────

test("a rolled buffer is REPORTED, not silently incomplete", async () => {
  // entry.truncated was set on overflow and then read by nothing, so a log missing
  // megabytes of output looked identical to a complete one. A real child writes past
  // the cap, which is the only way to exercise the roll through the public surface.
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "process.stdout.write('x'.repeat(5200000))"], { detached: DETACH });
  const info = mgr.adopt(child, { command: "noisy", cwd: process.cwd() });
  await waitUntil(() => mgr.list()[0]!.status !== "running");

  const shown = (await mgr.read(info.id))!;
  assert.equal(shown.info.truncated, true, "the roll must be visible on the public view");
  // …and it must reach the model, through the tool it actually calls.
  const ctx = { cwd: process.cwd(), reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const listed = await shellsTool.execute({}, ctx);
  assert.match(listed.output, /this log is incomplete/i);
  mgr.dispose();
});

test("kill_shell reports a non-running shell plainly, not as a failure", async () => {
  const mgr = new BackgroundShells();
  const ctx = { cwd: process.cwd(), reads: new Map(), todos: [], backgroundShells: mgr } as unknown as ToolContext;
  const r = await killShell.execute({ id: 999 }, ctx);
  assert.match(r.output, /wasn't running/i);
  assert.notEqual(r.isError, true, "nothing went wrong; there was simply nothing to stop");
  assert.match(killShell.description, /not an error/i);
  mgr.dispose();
});

test("list_shells' description names the two questions its output answers", () => {
  assert.match(shellsTool.description, /IS IT UP/i);
  assert.match(shellsTool.description, /WHY DID IT STOP/i);
});

test("shell_output's stated read cap is the real one", () => {
  assert.match(shellsTool.description, /at most 30,000 characters/i);
});

test("disposing kills a shell's descendants even after the wrapper has exited", async () => {
  // The POSIX leak, isolated. Killing the `sh -c` wrapper does NOT kill what it
  // started: the program is orphaned, keeps running, and keeps the stdio pipes open,
  // so the owning process can never exit. dispose() used to skip any shell it had
  // already marked "ended", which is exactly this case, so the orphan was never
  // reaped. Measured on Linux: it outlived the entire test run.
  const mgr = new BackgroundShells();
  const ctx = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    reads: new Map(),
    todos: [],
    backgroundShells: mgr,
  } as unknown as ToolContext;

  await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{}, 100000)"), run_in_background: true },
    ctx,
  );
  const id = mgr.running()[0]!.id;
  const entry = (mgr as unknown as { shells: Map<number, { child: { pid?: number; kill(): void } | null }> }).shells.get(id)!;
  const wrapperPid = entry.child!.pid!;

  // The wrapper dies; whatever it started does not.
  entry.child!.kill();
  await waitUntil(() => mgr.list().find((s) => s.id === id)!.status !== "running");

  mgr.dispose();
  await new Promise((r) => setTimeout(r, 1200)); // killTree escalates asynchronously

  assert.equal(
    isProcessStopped(wrapperPid),
    true,
    "the shell's process group must be gone after dispose, wrapper and descendants alike",
  );
});

test("a dev server's own startup URL is where the port comes from", () => {
  // Read from the process's output, never from inspecting sockets: no privileges
  // needed, and it cannot report a port that belongs to some other process.
  assert.equal(detectPort("  ➜  Local:   http://localhost:5173/"), 5173);
  assert.equal(detectPort("Server running at http://127.0.0.1:8080"), 8080);
  assert.equal(detectPort("listening on port 3000"), 3000);
});

test("the FIRST announcement wins when a server prints several", () => {
  // Vite prints Local then Network for the same port, and some tools print a proxy
  // target after that. The first line describes the server that just came up.
  const out = ["  Local:   http://localhost:5173/", "  Network: http://192.168.1.9:5173/", "proxy -> port 9000"].join("\n");
  assert.equal(detectPort(out), 5173);
});

test("output with no port announcement yields nothing, not a guess", () => {
  assert.equal(detectPort("building...\ncompiled successfully"), undefined);
  assert.equal(detectPort(""), undefined);
});

test("a number that cannot be a port is rejected", () => {
  assert.equal(detectPort("http://localhost:999999"), undefined);
});

// ── the stall watchdog ───────────────────────────────────────────────────────
//
// A backgrounded command is told to end its turn, so nothing watches it while it
// runs. These check that a shell which goes quiet in an actionable way is surfaced
// exactly once, and that the healthy quiet of a server is left alone.

test("looksLikePrompt spots the lines that mean 'waiting for the keyboard'", () => {
  assert.equal(looksLikePrompt("Delete everything? (y/n) "), true);
  assert.equal(looksLikePrompt("Overwrite? [y/N]"), true);
  assert.equal(looksLikePrompt("Are you sure you want to continue?"), true);
  assert.equal(looksLikePrompt("Press ENTER to continue"), true);
  assert.equal(looksLikePrompt("Password:"), true);
  // Not prompts: ordinary build/test chatter must never trip it.
  assert.equal(looksLikePrompt("Compiling foo v0.1.0"), false);
  assert.equal(looksLikePrompt("test result: ok. 12 passed; 0 failed"), false);
  assert.equal(looksLikePrompt("Is this the real life? Is this just fantasy"), false);
});

/** Spawn a child that prints `line` (no newline) then stays alive doing nothing. */
/**
 * A fake RUNNING child for the watchdog tests. An EventEmitter with stdout/stderr and no
 * OS process behind it, so its output is delivered SYNCHRONOUSLY (no flaky pipe timing on
 * a slow CI) and nothing is left hanging to leak or time the suite out — the earlier
 * version spawned real processes that did both. The watchdog only reads the buffered
 * output and the running status, which this supplies.
 */
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  // A pid that names no process, so the group-kill on dispose is a harmless no-op.
  (child as unknown as { pid: number }).pid = 2_147_483_646;
  return child;
}
/** Deliver a line of output to an adopted fake child, synchronously. */
function emit(child: ChildProcess, s: string): void {
  (child as unknown as { stdout: EventEmitter }).stdout.emit("data", s);
}

test("a shell blocked on a prompt is flagged once, with the prompt reason", async () => {
  // prompt threshold 200ms, silent threshold effectively off (60s) so only the prompt path can fire.
  const mgr = new BackgroundShells(50, 50, 200, 60_000);
  const child = fakeChild();
  mgr.adopt(child, { command: "risky-thing", cwd: process.cwd(), notify: "on_finish" });
  emit(child, "Delete everything? (y/n) ");
  const t0 = Date.now();
  assert.equal(mgr.pendingCount(), 0, "not flagged before the threshold");
  mgr.checkStalls(t0 + 1000); // idle well past 200ms
  assert.equal(mgr.pendingCount(), 1, "flagged once past the threshold");
  const drained = await mgr.drainEvents();
  const stalls = drained.filter((e) => e.kind === "stalled");
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0]!.info.stallReason, "prompt");
  assert.match(stalls[0]!.tail, /y\/n/);
  // One-shot: it never fires again.
  mgr.checkStalls(t0 + 5000);
  assert.equal((await mgr.drainEvents()).filter((e) => e.kind === "stalled").length, 0);
  assert.equal(mgr.takeUiEvents().filter((e) => e.kind === "stalled").length, 1);
  assert.equal(mgr.takeUiEvents().filter((e) => e.kind === "stalled").length, 0);
  mgr.dispose();
});

test("a finish-expecting command gone silent is flagged, even with no prompt", async () => {
  // Silent threshold 200ms; prompt path off. The Cutio case: output froze mid-run.
  const mgr = new BackgroundShells(50, 50, 60_000, 200);
  const child = fakeChild();
  mgr.adopt(child, { command: "cargo run --release", cwd: process.cwd(), notify: "on_finish" });
  emit(child, "[decode] frame 12 ...");
  const t0 = Date.now();
  mgr.checkStalls(t0 + 20); // still within 200ms of last output
  assert.equal(mgr.pendingCount(), 0, "a brief quiet is not a stall");
  mgr.checkStalls(t0 + 1000);
  const stalls = (await mgr.drainEvents()).filter((e) => e.kind === "stalled");
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0]!.info.stallReason, "silent");
  mgr.dispose();
});

test("a server going quiet is NOT a stall — that is its resting state", async () => {
  // A server (on_failure) with the silent threshold at 200ms must never be flagged for
  // silence; only a prompt would ever flag it.
  const mgr = new BackgroundShells(50, 50, 60_000, 200);
  const child = fakeChild();
  mgr.adopt(child, { command: "node server.js", cwd: process.cwd(), notify: "on_failure" });
  emit(child, "Listening on http://localhost:3000");
  mgr.checkStalls(Date.now() + 5000);
  assert.equal(mgr.list()[0]!.stallReason, undefined, "a quiet server was wrongly flagged as stuck");
  assert.equal((await mgr.drainEvents()).filter((e) => e.kind === "stalled").length, 0);
  mgr.dispose();
});

test("a `never` shell is never flagged, however long it sits", async () => {
  const mgr = new BackgroundShells(50, 50, 200, 200);
  const child = fakeChild();
  mgr.adopt(child, { command: "fire-and-forget", cwd: process.cwd(), notify: "never" });
  emit(child, "Delete everything? (y/n) "); // even a prompt
  mgr.checkStalls(Date.now() + 5000);
  assert.equal(mgr.list()[0]!.stallReason, undefined, "a 'never' shell must stay silent");
  mgr.dispose();
});

test("a second note carries only what is NEW — never the output already sent", async () => {
  // The offset that makes a note a delta. A shell can produce several events in its life
  // (it came up, then it ended), and each one carries a tail. Cut from the end of
  // everything each time, the second note repeats what the first already showed.
  // The second line is emitted WHEN THIS TEST SAYS SO, not on a timer the machine has to
  // beat. Two earlier versions used a delay (400ms, then 3s) and both were coin flips on
  // a CI runner: if the polled output file was read late, the first drain swallowed both
  // lines and the second note was legitimately empty. Waiting on the child's stdin makes
  // the ordering a fact rather than a race.
  const mgr = new BackgroundShells(50, 2_000);
  const child = spawn(
    NODE,
    ["-e", "console.log('FIRST'); process.stdin.once('data', () => { console.log('SECOND'); process.exit(0); });"],
    { detached: DETACH, stdio: ["pipe", "pipe", "pipe"] },
  );
  const info = mgr.adopt(child, { command: "node -e two-phase", cwd: process.cwd(), notify: "on_failure" });

  // EVERY wait here is on a real precondition, never on a clock. Output reaches `seen`
  // through a polled file, so "the grace period has elapsed" does NOT imply "the first
  // line has been read" — on a CI runner it frequently does not, and an earlier version
  // of this test drained before either line had landed and asserted against an empty tail.
  const entryOf = () =>
    (mgr as unknown as { shells: Map<number, { seen: string }> }).shells.get(info.id)!;

  // First note: it came up, and carries what it had actually said by then.
  await waitUntil(() => entryOf().seen.includes("FIRST"), 15_000);
  await waitUntil(() => mgr.list()[0]!.ready === true, 15_000);
  const first = await mgr.drainEvents();
  assert.equal(first.length, 1, "the ready event");
  assert.match(first[0]!.tail, /FIRST/, "the first note should carry the output it had seen");
  assert.ok(!entryOf().seen.includes("SECOND"), "premise: the second line must not have been said yet");

  // NOW release the second line. Nothing before this point could have produced it.
  child.stdin?.write("go\n");

  // Second note: only what has been said SINCE.
  await waitUntil(() => entryOf().seen.includes("SECOND"), 15_000);
  await waitUntil(() => mgr.list()[0]!.status !== "running", 15_000);
  const second = await mgr.drainEvents();
  assert.equal(second.length, 1, "the ended event");
  assert.match(second[0]!.tail, /SECOND/, "the new output is reported");
  assert.doesNotMatch(second[0]!.tail, /FIRST/, "output already sent must not be sent again");

  mgr.dispose(true);
});

test("two events in ONE drain do not print the same output twice", async () => {
  // A server that comes up and immediately dies produces both events in a single pass.
  // Handing the same delta to each would print it twice in one breath.
  // A very short startup grace, so "it came up" fires before the process exits and both
  // events land in the same drain.
  const mgr = new BackgroundShells(20, 2_000);
  const child = spawn(NODE, ["-e", "console.log('ONLYONCE'); setTimeout(()=>{}, 120)"], { detached: DETACH });
  mgr.adopt(child, { command: "node -e blip", cwd: process.cwd(), notify: "on_failure" });

  await waitUntil(() => mgr.list()[0]!.status !== "running", 4000);
  const events = await mgr.drainEvents();
  const withOutput = events.filter((e) => /ONLYONCE/.test(e.tail));
  assert.equal(withOutput.length, 1, `output appeared in ${withOutput.length} notes of the same drain`);

  mgr.dispose(true);
});

test("a command started in the background has its output read, so a prompt it stops on is caught", async () => {
  // The explicit background path handed the manager the process but not the file the
  // process writes into, so from 2.4.0 on every `run_in_background` command was silent:
  // `shells` read nothing, every note said "(no output)", and the stall watchdog never saw
  // the prompt it exists for. Only commands moved to the background after a timeout worked.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "mw-bgout-"));
  writeFileSync(join(dir, "asks.js"), 'process.stdout.write("Overwrite existing config? [y/N] "); setInterval(() => {}, 1000);\n');
  const mgr = new BackgroundShells();
  const ctx = { cwd: dir, roots: [dir], reads: new Map(), backgroundShells: mgr } as unknown as Parameters<typeof runCommand.execute>[1];
  try {
    const started = await runCommand.execute({ command: `node asks.js`, run_in_background: true, notify: "on_finish" }, ctx);
    assert.match(started.output, /background as shell #1/);
    let seen = "";
    for (let i = 0; i < 100 && !seen.includes("[y/N]"); i++) {
      await sleep(50);
      seen += (await mgr.read(1))?.chunk ?? "";
    }
    assert.match(seen, /Overwrite existing config\? \[y\/N\]/, "the background command's output never reached the manager");
    mgr.checkStalls(Date.now() + 10 * 60_000);
    const stalled = (await mgr.drainEvents()).find((e) => e.kind === "stalled");
    assert.ok(stalled, "a command waiting on a prompt was not flagged");
    assert.match(stalled.tail, /\[y\/N\]/);
  } finally {
    mgr.dispose(true);
  }
});
