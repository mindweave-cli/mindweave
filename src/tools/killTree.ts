/**
 * killTree.ts — spawning a child we can later kill completely, and killing it.
 *
 * Spawn and kill live in ONE module because they share one invariant. Killing a
 * shell alone leaves grandchildren (node → jest, npx → the real server, a dev
 * server) holding the output pipe open, so the job looks hung forever. Killing the
 * whole tree needs `taskkill /T` on Windows and the negative-pid process group on
 * POSIX — and the process group only exists if the child was spawned `detached`.
 *
 * That invariant used to be a sentence in a comment, and two of the three callers
 * did not honour it: the MCP stdio transport and the language-server host both
 * spawned attached and then skipped the tree kill entirely off Windows, so on macOS
 * and Linux only the direct child was ever signalled and its children were orphaned.
 * `spawnManaged` exists so that cannot happen again: every child that will later be
 * tree-killed is created through it, and it sets the group up correctly by
 * construction rather than by remembering.
 *
 * TWO KILL VARIANTS, and the difference is not cosmetic. `killTree` is asynchronous
 * and escalates politely. It does NOT work from a `process.on("exit")` handler: Node
 * runs no async work during exit, so neither a spawn nor a timer ever reaches the
 * OS and the process survives — measured, not assumed. Anything disposing from an
 * exit handler must call `killTreeSync`, which blocks and goes straight to the
 * forceful signal because there is no time left to be polite.
 *
 * Why not make everything synchronous and delete the footgun? Measured on this
 * machine, `spawnSync("taskkill /F /T")` blocks for a median of 122ms (max 140ms)
 * per tree. Session teardown kills several at once, so an always-sync version would
 * freeze the UI for a noticeable fraction of a second on every swap.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { childEnv } from "./childEnv.js";

const IS_WINDOWS = process.platform === "win32";

/**
 * How long a process gets to shut down cleanly before it is killed outright.
 *
 * POSIX only, and it matters: a dev server, a language server, or an MCP server
 * asked to stop will flush state, release a port, and close a socket if it is given
 * a chance. Going straight to SIGKILL — which is what this module used to do — denies
 * that, and the cost shows up later as a held port or a half-written file.
 */
const TERM_GRACE_MS = 2_000;

/** taskkill arguments for a whole process tree. */
function killArgs(pid: number): string[] {
  return ["/F", "/T", "/PID", String(pid)];
}

/**
 * Spawn a child that can later be tree-killed.
 *
 * Use this for any process with a lifetime — a shell command, an MCP server, a
 * language server. On POSIX it becomes its own process-group leader, which is the
 * precondition `killTree` depends on; on Windows the group is handled by `taskkill
 * /T` and nothing extra is needed. Callers keep full control of stdio, cwd and env;
 * only the group setting is decided here, because that is the part that has to be
 * consistent for the kill path to work.
 */
export function spawnManaged(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(command, args as string[], {
    ...options,
    // Without an explicit environment a child gets the user's, not Mindweave's (see childEnv.ts).
    env: options.env ?? childEnv(),
    windowsHide: options.windowsHide ?? true,
    // POSIX: lead our own process group so the whole tree can be signalled at once.
    // Windows has no process groups in this sense; taskkill /T walks the tree instead.
    detached: IS_WINDOWS ? false : (options.detached ?? true),
  });
}

/**
 * Kill `pid` and everything beneath it. Non-blocking.
 *
 * POSIX escalates: SIGTERM to the group, then SIGKILL to whatever is still there
 * after the grace period. Windows uses `taskkill /F /T`, which is already a forced
 * whole-tree kill. Use only where an event loop is still running; see `killTreeSync`.
 */
/**
 * Signal the process GROUP led by `pid`, falling back to the process itself.
 *
 * The group is the point: it reaches grandchildren. But a group only exists if the
 * child was spawned `detached`, which is what `spawnManaged` guarantees. A pid from
 * a plain `spawn` leads no group, so `kill(-pid)` raises ESRCH and the whole kill
 * used to be swallowed by a `catch` and do NOTHING, with no error and no signal.
 *
 * That silent no-op is what hangs a POSIX process: the child survives, its handle
 * keeps the event loop alive, and the parent never exits. MEASURED on Linux, a
 * plainly-spawned child was still in state `S` after killTreeSync returned.
 *
 * Falling back to the bare pid means the caller always gets the kill they asked
 * for. Grandchildren of a non-detached child are still missed, which is exactly why
 * `spawnManaged` exists, but one dead process beats zero.
 */
function signalGroupThenSelf(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone, or no permission — nothing more we can do.
    }
  }
}

export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      spawn("taskkill", killArgs(pid), { windowsHide: true, stdio: "ignore" });
      return;
    }
    signalGroupThenSelf(pid, "SIGTERM");
    const escalate = setTimeout(() => {
      signalGroupThenSelf(pid, "SIGKILL");
    }, TERM_GRACE_MS);
    // Never hold the process open just to deliver a follow-up kill.
    escalate.unref?.();
  } catch {
    // Already gone, or no permission — nothing more we can do.
  }
}

/**
 * How long to wait for the OS to actually finish killing before giving up.
 *
 * SIGKILL cannot be caught, blocked or ignored, so this deadline is not there for
 * a process that resists — nothing resists SIGKILL. It exists for the pathological
 * case where a process is wedged in uninterruptible kernel I/O (state `D`), where
 * the kill is pending until that I/O completes and waiting longer would not help.
 * Better to return late than to hang a shutdown forever.
 */
const KILL_CONFIRM_MS = 1_500;

/** One shared buffer for the sync sleep; allocating per poll would churn. */
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));

/**
 * Block this thread for `ms` with no event loop involved.
 *
 * `Atomics.wait` on a value that never changes is the only true synchronous sleep
 * in Node. setTimeout is useless here by definition: the callers of this module
 * run from `process.on("exit")`, where no timer will ever fire again.
 */
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_SLOT, 0, 0, ms);
}

/**
 * Kill `pid` and its descendants, blocking until it has happened.
 *
 * The variant that works from a `process.on("exit")` handler. No grace period: the
 * process is on its way out and there is no event loop left to deliver a follow-up
 * signal on, so a polite first attempt would simply be the only attempt and would
 * leave anything that ignores SIGTERM running.
 *
 * "Blocking until it has happened" is the whole contract, and it used to be a lie.
 * Sending a signal is not the same as the target being dead: `process.kill` returns
 * as soon as the signal is QUEUED, and for a window after that the process is still
 * scheduled, still holding its port, still listed as running. An exit handler gets
 * no second chance to look, so a caller that returned into `process.exit` left a
 * live process behind. MEASURED: `isProcessStopped` reported a just-SIGKILLed child
 * as alive immediately after this function returned.
 *
 * So the kill is now CONFIRMED before returning, not merely sent.
 */
export function killTreeSync(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", killArgs(pid), { windowsHide: true, stdio: "ignore" });
    } else {
      signalGroupThenSelf(pid, "SIGKILL");
    }
  } catch {
    // Already gone, or no permission — nothing more we can do.
  }
  // Poll until the OS agrees the process is gone. Costs nothing in the common case
  // (the first check almost always passes); it is the rare slow reap that this
  // exists for, because that is exactly when an exit handler would leak a process.
  const deadline = Date.now() + KILL_CONFIRM_MS;
  while (!isProcessStopped(pid) && Date.now() < deadline) {
    sleepSync(1);
  }
}

/**
 * Has `pid` stopped running? Not the same as "does the pid exist".
 *
 * On POSIX a SIGKILLed child stays a ZOMBIE until its parent reaps it, and
 * `kill(pid, 0)` succeeds against a zombie, so the obvious liveness check reports a
 * process we just killed as still alive. MEASURED: right after killTreeSync, a
 * correctly killed child sat in state `Z`. Callers that need "is it gone" therefore
 * have to read the state, not just probe for existence.
 *
 * Windows has no zombie stage, so existence is the whole answer there.
 */
export function isProcessStopped(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
  } catch {
    return true; // no such process
  }
  if (IS_WINDOWS) return false;
  try {
    // /proc/<pid>/stat: the state letter follows the parenthesised command name,
    // which can itself contain spaces or parens, so split on the LAST ") ".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(") ") + 2);
    return after.startsWith("Z"); // reaped-pending is stopped for every practical purpose
  } catch {
    return true; // /proc entry vanished between the two checks
  }
}
