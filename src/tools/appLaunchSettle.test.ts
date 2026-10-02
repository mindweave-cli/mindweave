/**
 * appLaunchSettle.test.ts — launching an app or a server answers with how the launch went.
 *
 * Reported from a real session: the agent said "the app is starting" the moment it launched an app,
 * then ten seconds later, woken by "it came up", said "it's running" and repeated the same advice, while
 * the window had been open in front of the user for a while. The launch now waits a few seconds inside
 * the call that starts it and reports the outcome once.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BackgroundShells } from "./backgroundShells.js";
import { runCommand } from "./runCommand.js";
import type { ToolContext } from "./types.js";

const NODE = process.execPath;
const IS_WIN = process.platform === "win32";
const nodeCmd = (script: string) => `${IS_WIN ? "& " : ""}"${NODE}" -e "${script}"`;

function rig(controller?: AbortController) {
  const mgr = new BackgroundShells();
  const ctx = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    reads: new Map(),
    todos: [],
    backgroundShells: mgr,
    abortSignal: controller?.signal,
  } as unknown as ToolContext;
  return { mgr, ctx };
}

const saved = process.env.MINDWEAVE_READY_WINDOW_MS;
afterEach(() => {
  if (saved === undefined) delete process.env.MINDWEAVE_READY_WINDOW_MS;
  else process.env.MINDWEAVE_READY_WINDOW_MS = saved;
});

test("an app that stays up is reported as running, once, with no second note to follow", { timeout: 30_000 }, async () => {
  process.env.MINDWEAVE_READY_WINDOW_MS = "700";
  const { mgr, ctx } = rig();
  const t0 = Date.now();
  const r = await runCommand.execute(
    { command: nodeCmd("console.log(String(/window open/));setTimeout(()=>{},100000)"), run_in_background: true, notify: "on_failure" },
    ctx,
  );
  assert.ok(Date.now() - t0 >= 600, "it waited out its window before answering");
  assert.notEqual(r.isError, true);
  assert.match(r.output, /still running after/);
  assert.match(r.output, /window open/, "the output so far rides along");
  assert.match(r.output, /ONE short line/);
  assert.doesNotMatch(r.output, /WILL be told once it has come up/, "no promise of a later note");
  assert.match(r.summary ?? "", /Running as shell/);
  const id = mgr.running()[0]!.id;
  assert.equal(mgr.list().find((s) => s.id === id)!.ready, true);
  // The model was told here, so it must not be woken again for the same fact.
  assert.equal(mgr.pendingCount(), 0, "nothing is left to wake the model for");
  assert.deepEqual(await mgr.drainEvents(), []);
  mgr.kill(id);
  mgr.dispose();
});

test("an app that dies at launch fails the call, with the output that says why, and wakes nobody", { timeout: 30_000 }, async () => {
  process.env.MINDWEAVE_READY_WINDOW_MS = "3000";
  const { mgr, ctx } = rig();
  const t0 = Date.now();
  const r = await runCommand.execute(
    { command: nodeCmd("console.error(String(/port 3000 is already in use/));process.exit(3)"), run_in_background: true, notify: "on_failure" },
    ctx,
  );
  assert.ok(Date.now() - t0 < 2800, "it did not sit out the whole window for a process that was already gone");
  assert.equal(r.isError, true);
  assert.match(r.output, /exited with code 3/);
  assert.match(r.output, /never came up/);
  assert.match(r.output, /port 3000 is already in use/);
  assert.equal(mgr.pendingCount(), 0, "the failure was delivered in the result, not again as a wake");
  assert.deepEqual(await mgr.drainEvents(), []);
  mgr.dispose();
});

test("with the wait switched off a launch hands back at once and promises the later note, as before", { timeout: 30_000 }, async () => {
  process.env.MINDWEAVE_READY_WINDOW_MS = "0";
  const { mgr, ctx } = rig();
  const t0 = Date.now();
  const r = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{},100000)"), run_in_background: true, notify: "on_failure" },
    ctx,
  );
  assert.ok(Date.now() - t0 < 2000);
  assert.match(r.output, /WILL be told once it has come up/);
  mgr.kill(mgr.running()[0]!.id);
  mgr.dispose();
});

test("a finite task is never held: its result is the point and it arrives on its own", { timeout: 30_000 }, async () => {
  process.env.MINDWEAVE_READY_WINDOW_MS = "3000";
  const { mgr, ctx } = rig();
  const t0 = Date.now();
  const r = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{},100000)"), run_in_background: true, notify: "on_finish" },
    ctx,
  );
  assert.ok(Date.now() - t0 < 2000, "no waiting for a task");
  assert.match(r.output, /notified AUTOMATICALLY the moment it finishes/);
  mgr.kill(mgr.running()[0]!.id);
  mgr.dispose();
});

test("Esc while the launch is being watched stops the app instead of leaving it running", { timeout: 30_000 }, async () => {
  process.env.MINDWEAVE_READY_WINDOW_MS = "5000";
  const ac = new AbortController();
  const { mgr, ctx } = rig(ac);
  // Esc once the app is really running. A fixed delay raced the spawn under load: the abort
  // landed before the command started, which is a different (and already covered) path.
  void (async () => {
    while (mgr.running().length === 0) await new Promise((res) => setTimeout(res, 10));
    ac.abort();
  })();
  const r = await runCommand.execute(
    { command: nodeCmd("setTimeout(()=>{},100000)"), run_in_background: true, notify: "on_failure" },
    ctx,
  );
  assert.equal(r.isError, true);
  assert.match(r.output, /Interrupted/);
  const deadline = Date.now() + 5000;
  while (mgr.running().length > 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  assert.equal(mgr.running().length, 0, "the app the user cancelled is not left running");
  mgr.dispose();
});
