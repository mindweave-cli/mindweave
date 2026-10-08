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
  // Long enough that a slow machine, which can take a second or more just to start node, still gets its first
  // line of output inside the window; the program stays up, so the wait is the whole window either way.
  process.env.MINDWEAVE_READY_WINDOW_MS = "2500";
  const { mgr, ctx } = rig();
  const t0 = Date.now();
  const r = await runCommand.execute(
    { command: nodeCmd("console.log(String(/window open/));setTimeout(()=>{},100000)"), run_in_background: true, notify: "on_failure" },
    ctx,
  );
  assert.ok(Date.now() - t0 >= 2400, "it waited out its window before answering");
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
  // A long window, and a limit well under it: what is checked is that the call returns when the program ends rather
  // than waiting out the window, not how fast this machine starts node.
  process.env.MINDWEAVE_READY_WINDOW_MS = "20000";
  const { mgr, ctx } = rig();
  const t0 = Date.now();
  const r = await runCommand.execute(
    { command: nodeCmd("console.error(String(/port 3000 is already in use/));process.exit(3)"), run_in_background: true, notify: "on_failure" },
    ctx,
  );
  assert.ok(Date.now() - t0 < 15000, "it did not sit out the whole window for a process that was already gone");
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

test("a launch that dies at once always reports its output, however the final read and the report interleave", { timeout: 110_000 }, async () => {
  // The last read of a finished shell's output file and the report that quotes it ran side by side on one reader,
  // and the report sometimes won: "It has printed nothing so far" for an app that had printed the reason. It showed
  // up as about one failure in thirty on the test above, so this runs a run of them and wants every one.
  //
  // The window is long on purpose: the call returns the moment the program ends, so a long window costs nothing,
  // and a slow machine that takes seconds just to start node is still inside it. (A first version used 3 seconds
  // and 40 launches, and on a shared CI runner one start took longer than that, which says nothing about the race.)
  process.env.MINDWEAVE_READY_WINDOW_MS = "30000";
  const { mgr, ctx } = rig();
  for (let i = 0; i < 25; i++) {
    const r = await runCommand.execute(
      { command: nodeCmd(`console.error('reason-${i}');process.exit(3)`), run_in_background: true, notify: "on_failure" },
      ctx,
    );
    assert.match(r.output, new RegExp(`reason-${i}`), `launch ${i} lost its output: ${r.output.slice(0, 160)}`);
  }
  mgr.dispose();
});
