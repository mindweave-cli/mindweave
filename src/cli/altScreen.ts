/**
 * altScreen.ts — enter/exit the terminal's alternate screen buffer by hand.
 *
 * Ink has an `alternateScreen` render option, but the sequences are owned here instead:
 * they have to be paired with the wheel-reporting teardown and written from signal
 * handlers Ink knows nothing about, so a second owner of the same modes would only
 * create a way for the two to disagree. They are three lines and stable across every
 * VT100-descended terminal.
 *
 * Must always be paired with `exitAltScreen()` before the process actually dies, or the
 * user's shell is left showing a blank alternate-screen buffer. Covers the ways this
 * process ends that still run code: a clean exit, a signal (Ctrl+C, kill, or the
 * terminal window closing), and an uncaught exception — each calls the same idempotent
 * restore.
 *
 * The ways it ends that do NOT run code — a V8 fatal out-of-memory, SIGKILL, a
 * force-quit — cannot be covered from in here at all. That is what
 * `mindweave --reset-terminal` is for; see `terminalRestore.ts`.
 */
// Imported as a namespace so the call is a property lookup at call time, which is what
// lets a test observe the restore. A named import is bound at load and cannot be seen.
import * as nodeFs from "node:fs";
import { SHOW_CURSOR, TERMINAL_RESTORE } from "./terminalRestore.js";
import { caretToOutputEnd } from "./exitCursor.js";
import { setFramebufferClosed } from "./framebuffer/writer.js";

const ENTER = "\x1b[?1049h";
const HIDE_CURSOR = "\x1b[?25l";

/**
 * Autowrap off (DECAWM).
 *
 * With it on, a row one column too long does not fail visibly — the terminal quietly
 * continues it on the next row and pushes everything below it down, and on the bottom
 * row it scrolls the whole screen. The renderer addresses the terminal as a fixed grid
 * and writes only the cells it believes changed (see `framebuffer/`), so a row that
 * moved is a row nothing will ever correct: the text stays on screen, in the wrong
 * place, for the rest of the session.
 *
 * Off, an over-long row is clipped at the right margin instead. Losing a character at
 * the edge is a visible, local, self-correcting fault; a wrap is an invisible one that
 * spreads. The layout still aims to fit every row, and this is what makes a miss cost
 * one character rather than the screen.
 */
const AUTOWRAP_OFF = "\x1b[?7l";

let active = false;
/** Whether the process-level restore hooks are installed. Separate from `active`, so
 *  leaving the alternate screen for the inline shell does not unregister them and
 *  re-entering does not register a second copy of every signal handler — `enterAltScreen`
 *  is called again on every switch back, and each call used to add another SIGINT,
 *  SIGTERM, SIGHUP and uncaughtException listener. */
let guarded = false;

/**
 * Show or hide the terminal's own cursor.
 *
 * Hidden in BOTH shells, for opposite reasons. Fullscreen parks it deliberately as the
 * caret and hides it the rest of the time; the inline shell draws its caret as a cell,
 * and the real cursor would otherwise sit wherever Ink's output happened to end — a
 * second, stranded caret on a line of its own below the input.
 */
export function setCursorVisible(on: boolean): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(on ? SHOW_CURSOR : HIDE_CURSOR);
}

/**
 * Enter or leave the alternate screen at runtime, in either direction.
 *
 * The switch `/screen` makes, and the reason it is separate from `enterAltScreen`: that
 * one is the once-per-process setup, this one is the part that can happen many times.
 *
 * An ordinary async write, not `writeSync`, because nobody is exiting — the process
 * carries on rendering into whichever screen this leaves it on.
 */
export function setAltScreen(on: boolean): void {
  if (!process.stdout.isTTY || on === active) return;
  active = on;
  // Leaving restores the whole terminal, not just the buffer: autowrap back on so the
  // terminal wraps its own scrollback, the cursor visible because Ink owns it in the
  // inline shell, and mouse reporting off because nothing is reading it there.
  process.stdout.write(on ? ENTER + HIDE_CURSOR + AUTOWRAP_OFF : TERMINAL_RESTORE);
}

/**
 * Registers the restore-on-exit hooks, and by default switches to the alternate screen.
 *
 * No-op outside a real TTY (piped output, CI) — same rule Ink itself uses for every
 * terminal-control feature. Once per process: `setAltScreen` is the one that can be
 * called again.
 *
 * @param buffer Whether to switch to the alternate screen as well as installing the
 *   hooks. False for a session starting in the inline shell: it owns no screen, but it
 *   still wants the restore — bracketed paste and the cursor are turned on there too,
 *   and a signal that skipped the restore would leave the terminal swallowing pastes.
 */
export function enterAltScreen(options: { buffer?: boolean } = {}): void {
  if (guarded || !process.stdout.isTTY) return;
  guarded = true;
  if (options.buffer !== false) setAltScreen(true);
  process.on("exit", exitAltScreen);
  process.on("SIGINT", () => {
    exitAltScreen();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    exitAltScreen();
    process.exit(143);
  });
  // The terminal window being closed. Node raises this on Windows too, and without a
  // listener the default action kills the process outright, skipping the restore — which
  // matters because the same terminal program is usually reopened onto the same profile.
  process.on("SIGHUP", () => {
    exitAltScreen();
    process.exit(129);
  });
  process.on("uncaughtException", (err) => {
    exitAltScreen();
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

/** Restores the primary screen buffer, the cursor, and wheel reporting. Idempotent —
 *  safe to call from multiple exit paths without double-writing escape codes.
 *
 *  Wheel reporting is turned on separately (see mouse.ts) and has its own cleanup on
 *  unmount, but a signal or a crash skips React entirely, so it is turned off here
 *  unconditionally rather than being left to a component that may never unmount. */
export function exitAltScreen(): void {
  if (!guarded && !active) return;
  // The full-screen shell is the one that owns a buffer of its own; once it is left, anything
  // still drawn would land in the user's terminal (see setFramebufferClosed).
  const leftOwnScreen = active;
  guarded = false;
  active = false;
  // writeSync, NOT process.stdout.write, because every caller of this is on its way out.
  //
  // A write to a TTY is ASYNCHRONOUS on Windows: the bytes are queued and flushed on a
  // later tick. Every path here — SIGINT, SIGTERM, SIGHUP, uncaughtException — calls
  // process.exit immediately afterwards, and exit does not wait for that queue. So the
  // restore was written and then discarded, and Ctrl+C left the terminal still in the
  // alternate screen with mouse reporting on: a window that is neither the app nor the
  // shell, and cannot be typed into. Writing to the file descriptor returns only once the
  // bytes are gone, which is the whole difference.
  try {
    // The cursor move goes FIRST and in the same write. It has to precede the restore
    // because it is about where the NEXT program prints, and it has to share the write
    // because every caller here is on its way out — a second writeSync is a second chance
    // to be cut off half way. See exitCursor.ts for what is being corrected.
    nodeFs.writeSync(1, caretToOutputEnd() + TERMINAL_RESTORE);
  } catch {
    // A closed or redirected stdout. Nothing to restore and nothing to report.
  }
  if (leftOwnScreen) setFramebufferClosed(true);
}
