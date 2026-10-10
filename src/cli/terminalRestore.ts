/**
 * terminalRestore.ts — the escape sequences that put a terminal back the way we found it.
 *
 * Owned in one place because two callers write them and they must not drift: the app's
 * own exit path (`altScreen.ts`), and `mindweave --reset-terminal`, which exists for the
 * case where that exit path never ran.
 *
 * That case is real, and it cannot be handled from inside the process it happens to. A
 * V8 fatal out-of-memory calls `abort()`, and `abort` runs no exit handler, no signal
 * handler and no `finally` block; the same is true of SIGKILL and of a force-quit from
 * the task manager. The process simply stops, mid-frame, with wheel reporting still
 * switched on. From then on every scroll and click writes `^[[<64;36;23M` into whichever
 * shell comes next, and closing the app does not help because the app is already gone.
 * The terminal is waiting for a byte that nobody is left to send, so it has to be sent
 * later, by hand.
 */

/** Wheel reporting off: the SGR encoding (1006) first, then reporting itself (1000). */
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

/** Leave the alternate screen buffer, revealing the shell scrollback underneath. */
export const ALT_SCREEN_OFF = "\x1b[?1049l";

/** Show the cursor again. */
export const SHOW_CURSOR = "\x1b[?25h";

/**
 * Autowrap back on (DECAWM), the default every shell expects.
 *
 * The app turns it OFF while it owns the screen, because it addresses the terminal as a
 * grid of cells and a row that wraps is a row in a place nothing knows about. Leaving it
 * off afterwards would truncate every long line in the shell that follows.
 */
export const AUTOWRAP_ON = "\x1b[?7h";

/**
 * Everything the app switches on, switched back off, in the order a half-dead terminal
 * wants it: stop the reporting that is actively producing garbage, then restore the
 * screen buffer, then the cursor.
 *
 * Every sequence here is idempotent, so sending the lot to a terminal that was never
 * broken costs three dozen bytes and changes nothing. That is what makes it safe to send
 * without first working out which parts are actually needed — and there is no way to
 * work that out anyway, since the terminal will not tell us what modes it is in.
 */
export const TERMINAL_RESTORE = MOUSE_OFF + ALT_SCREEN_OFF + SHOW_CURSOR + AUTOWRAP_ON;
