/**
 * terminalRestore.test.ts — the sequences, and the two callers agreeing on them.
 *
 * The defect these guard is not "the escape codes are wrong" — those were always right
 * on the path that ran. It is that the path frequently does not run, and that the repair
 * available afterwards has to send exactly what the exit path would have sent. Two
 * copies of a string that must match is how that stops being true, so the drift check
 * below matters more than any single assertion about a byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOUSE_OFF, ALT_SCREEN_OFF, SHOW_CURSOR, AUTOWRAP_ON, TERMINAL_RESTORE } from "./terminalRestore.js";
import { enterAltScreen, exitAltScreen } from "./altScreen.js";

test("the restore turns off reporting first, then the buffer, cursor and wrapping", () => {
  // Order is the point: the mode actively writing bytes into the terminal is silenced
  // before anything else, so nothing it emits lands in the middle of the rest.
  assert.equal(TERMINAL_RESTORE, MOUSE_OFF + ALT_SCREEN_OFF + SHOW_CURSOR + AUTOWRAP_ON);
  // Every mode that was turned on has to be turned off, and 1003 (all pointer motion,
  // which the row highlight needs) is one of them, as 1002 was before it. A mode left on outlives
  // the process: the shell that gets the terminal back is the one that suffers for it.
  // 1003 (all pointer movement, which the row highlight needs) joined 1002 and 1000.
  assert.equal(MOUSE_OFF, "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
  assert.equal(ALT_SCREEN_OFF, "\x1b[?1049l");
  assert.equal(SHOW_CURSOR, "\x1b[?25h");
  assert.equal(AUTOWRAP_ON, "\x1b[?7h");
});

test("every sequence restores the DEFAULT, so sending it to a healthy terminal is a no-op", () => {
  // What matters is the state each mode is left in, not the letter used to get there.
  // Most of what the app switches on is off by default and so is reset with `l`; the two
  // it switches OFF — the cursor and autowrap — are on by default and must be set back
  // with `h`. Getting either direction backwards would mean --reset-terminal broke the
  // terminal it was repairing: a stripped `?7h` leaves every long line in the next shell
  // silently truncated at the right margin, with nothing on screen to say why.
  const DEFAULT_ON = new Set(["25", "7"]);
  for (const seq of TERMINAL_RESTORE.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
    const wanted = DEFAULT_ON.has(seq[1]!) ? "h" : "l";
    assert.equal(seq[2], wanted, `mode ${seq[1]} must be left at its default`);
  }
});

/** Run `fn` with a stubbed TTY stdout, collecting everything written to it. */
function onFakeTty(fn: () => void): string {
  const out = process.stdout;
  const wasTty = out.isTTY;
  const realWrite = out.write.bind(out);
  let captured = "";
  (out as { isTTY: boolean }).isTTY = true;
  out.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof out.write;
  try {
    fn();
  } finally {
    out.write = realWrite;
    (out as { isTTY: boolean }).isTTY = wasTty;
  }
  return captured;
}

const EXIT_EVENTS = ["exit", "SIGINT", "SIGTERM", "SIGHUP", "uncaughtException"] as const;

/**
 * Run `fn`, then take back only the exit listeners it added.
 *
 * Deliberately not `removeAllListeners`: the test runner has its own `uncaughtException`
 * handler in this process, and stripping that would turn a later crash into a silent
 * pass. Only what this call installed comes off.
 */
function keepingListeners<T>(fn: () => T): { value: T; added: Map<string, number> } {
  // `exit` and the signals have separate overloads that share no common event type, so
  // the emitter is addressed through its plain string-keyed shape here.
  const emitter = process as unknown as {
    listeners(event: string): ((...args: unknown[]) => void)[];
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
  };
  const before = new Map(EXIT_EVENTS.map((e) => [e as string, emitter.listeners(e).slice()]));
  const value = fn();
  const added = new Map<string, number>();
  for (const event of EXIT_EVENTS) {
    const previous = before.get(event)!;
    const fresh = emitter.listeners(event).filter((l) => !previous.includes(l));
    added.set(event, fresh.length);
    for (const l of fresh) emitter.removeListener(event, l);
  }
  return { value, added };
}

test("the app's exit path writes exactly the canonical restore", () => {
  // The drift check. `mindweave --reset-terminal` writes TERMINAL_RESTORE; if the exit
  // path ever writes something else, the repair stops matching the damage.
  const { added } = keepingListeners(() => {
    onFakeTty(() => enterAltScreen());
    return onFakeTty(() => exitAltScreen());
  });

  // A signal or a crash skips React, so the restore has to be reachable from each of
  // these directly. SIGHUP is the terminal window closing, and it was not covered.
  for (const event of EXIT_EVENTS) {
    assert.equal(added.get(event), 1, `${event} must restore the terminal`);
  }
});

test("the exit path writes the restore to the FILE DESCRIPTOR, and survives exit", async () => {
  // Run in a child with stdout piped, because that is the only place this can honestly be
  // observed. The restore is written with writeSync deliberately: every caller is on its
  // way to process.exit, and a TTY write on Windows is asynchronous, so the queued bytes
  // were dropped and Ctrl+C left the terminal in the alternate screen — neither the app
  // nor the shell. Watching process.stdout.write cannot see the fixed version at all.
  //
  // `process.exit` immediately after, which is what the signal handlers do, so this fails
  // if the write ever goes back to being queued.
  const { execFileSync } = await import("node:child_process");
  // Import the SOURCE through tsx, not the built ./dist copy. CI runs the tests before
  // the build step and `npm ci` compiles nothing, so a child that reached for
  // dist/cli/altScreen.js found no file and exited non-zero — a green suite locally
  // (where a stale dist happened to exist) and a red one in CI. tsx transpiles the .ts
  // on the fly, the same way this parent test process is already running, so the child
  // needs no build to exist.
  const script = [
    "const { enterAltScreen, exitAltScreen } = await import('./src/cli/altScreen.ts');",
    "Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });",
    "enterAltScreen();",
    "exitAltScreen();",
    "process.exit(0);",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  assert.ok(out.endsWith(TERMINAL_RESTORE), `the restore did not reach the pipe: ${JSON.stringify(out)}`);
});

test("restoring twice writes nothing the second time", () => {
  // Several exit paths can fire at once — a SIGINT handler and the `exit` hook both run
  // on Ctrl+C — and a doubled sequence would be visible as stray bytes in the shell.
  keepingListeners(() => {
    onFakeTty(() => enterAltScreen());
    onFakeTty(() => exitAltScreen());
    assert.equal(onFakeTty(() => exitAltScreen()), "");
  });
});

test("the restore is written SYNCHRONOUSLY, enforced in source", async () => {
  // Enforced by reading the source, because the failure cannot be reproduced from a test.
  // It only happens on a real TTY: there, a write is queued and flushed on a later tick,
  // and the process.exit that every signal handler calls next throws the queue away. A
  // child process with a piped stdout — the only kind a test can create — flushes on exit
  // either way, so a behavioural test passes with the bug present. Verified: swapping
  // writeSync back for process.stdout.write leaves every other test in this file green.
  //
  // The cost of the bug is a terminal left in the alternate screen with mouse reporting
  // on, which is neither the app nor the shell and cannot be typed into.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./altScreen.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function exitAltScreen"));
  // The restore must be IN a synchronous write to fd 1. Anything else may share that
  // write — the exit-path cursor move does, deliberately, so a caller on its way out
  // makes one syscall rather than two (see exitCursor.ts) — so the match allows a
  // prefix and pins only what matters: writeSync, fd 1, carrying the restore.
  assert.match(body, /writeSync\(\s*1\s*,[^;]*TERMINAL_RESTORE/, "the restore is not written synchronously");
  assert.ok(
    !/process\.stdout\.write\([^;]*TERMINAL_RESTORE/.test(body),
    "the restore went back to an asynchronous write",
  );
});
