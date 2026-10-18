/**
 * screenMode.ts — which shell the app is wearing.
 *
 * The same transcript, the same blocks, the same streaming. Two ways of putting them on
 * a terminal, and they are opposites about one thing: who owns the screen.
 *
 * ## fullscreen
 *
 * We do. The alternate screen buffer, every cell ours to paint, the input pinned to the
 * bottom, our own scrolling, our own selection, our own cursor. Nothing leaks into the
 * user's scrollback. The cost is that every one of those is something we have to be good
 * at, and the bill grows with the length of the session: a frame costs what is on screen,
 * and scrolling means rebuilding it.
 *
 * ## inline
 *
 * The terminal does. Finished blocks are printed ONCE, into the terminal's own
 * scrollback, and never touched again; only the live tail is re-rendered. Scrolling is
 * the terminal's scrollbar. Selecting and copying is the terminal's selection. Both are
 * native, instant, and cost us nothing at all — and a frame costs what is happening now
 * rather than what has happened all session, so a four-hour conversation renders exactly
 * as fast as a four-minute one.
 *
 * What is given up is everything that needs the screen back: the pinned prompt scrolls
 * away like a shell prompt, there is no mouse, no click-to-place-caret, no drag-select of
 * our own, and a row that has been printed is final. It also works in places fullscreen
 * cannot — over a poor ssh link, inside a multiplexer that eats mouse reporting, in a
 * terminal with no alternate screen at all.
 *
 * Neither is the "real" one. `/screen` switches, and the choice is remembered for the
 * project, so it is made once rather than at the start of every session.
 */

export type ScreenMode = "fullscreen" | "inline";

/**
 * Which shell a session opens in.
 *
 * The env var wins, so a single laggy ssh session can be started inline without changing
 * anything the project keeps. Below it is the saved choice: the shell is a decision about
 * how you want to work, not about one sitting, and having to make it again at the start
 * of every session is the same decision being asked repeatedly. Neither present means
 * fullscreen.
 */
export function startupMode(env = process.env["MINDWEAVE_SCREEN"], saved?: ScreenMode | null): ScreenMode {
  const fromEnv = env?.trim().toLowerCase();
  if (fromEnv === "inline") return "inline";
  if (fromEnv === "fullscreen") return "fullscreen";
  return saved ?? "fullscreen";
}

/** A stored value read back off disk, which may be anything at all. */
export function parseSavedMode(raw: unknown): ScreenMode | null {
  return raw === "inline" || raw === "fullscreen" ? raw : null;
}

/**
 * What `/screen <arg>` names: an explicit mode, or nothing it can act on.
 *
 * `full` and `fs` are here because they are what people type, and a command that only
 * accepts its own formal spelling is a command that fails for the reason least worth
 * failing for. Anything unrecognised returns undefined so the caller can say what it
 * accepts rather than silently picking a mode that was not asked for.
 *
 * An EMPTY argument is undefined too, not a toggle. Bare `/screen` opens the chooser,
 * which is the caller's business and happens before this is reached — the two shells
 * are not equals any more, and swapping between them without showing what each takes
 * from the terminal is the thing the chooser exists to stop.
 */
export function parseScreenArg(arg: string | undefined): ScreenMode | undefined {
  const word = arg?.trim().toLowerCase() ?? "";
  if (word === "inline" || word === "normal" || word === "plain") return "inline";
  if (word === "fullscreen" || word === "full" || word === "fs") return "fullscreen";
  return undefined;
}

/** One line naming the mode and what it means, for the transcript after a switch. */
export function screenNotice(mode: ScreenMode): string {
  return mode === "inline"
    ? "inline — the terminal scrolls and selects, and the prompt scrolls with it"
    : "fullscreen — the prompt is pinned, and scrolling and selection are the app's";
}

/**
 * The inline shell is BETA, and the label is not a disclaimer for its own sake.
 *
 * Keeping the prompt pinned while the terminal scrolls means taking the mouse, and a
 * terminal hands over the whole mouse or none of it. So while an inline session runs,
 * the terminal's own wheel, scrollbar and drag-to-select all stop responding — the app
 * is holding them. Fullscreen makes the same trade, but there it is the point: the app
 * owns the screen and does the scrolling and selecting itself. Inline is meant to be the
 * shell that leaves those to the terminal, so here the same trade is a real loss, and
 * one a chooser deserves to be told about before picking rather than after.
 */
export const SCREEN_BETA: ScreenMode = "inline";

/** A mode as it appears in the `/screen` chooser: what it is, and what it costs. */
export interface ScreenChoice {
  mode: ScreenMode;
  label: string;
  description: string;
}

/**
 * Both shells, for the chooser (pure).
 *
 * Fullscreen is listed FIRST and that is deliberate: a list is read top down, and the
 * settled shell belongs above the one still being worked on.
 *
 * `current` only marks which is in use. It does not reorder them — a menu whose entries
 * move depending on where you already are is a menu you have to read every time instead
 * of learning once.
 */
export function screenChoices(current: ScreenMode): ScreenChoice[] {
  const tick = (mode: ScreenMode): string => (mode === current ? "  ✓" : "");
  return [
    {
      mode: "fullscreen",
      label: `Fullscreen${tick("fullscreen")}`,
      description: "the app owns the screen; pinned prompt, its own scrolling and selection",
    },
    {
      mode: "inline",
      label: `Inline (beta)${tick("inline")}`,
      description: INLINE_UNAVAILABLE,
    },
  ];
}

/**
 * Whether the inline shell can be chosen. It cannot, for now: it has too many bugs to hand
 * to anyone. The row stays in the chooser so it is clear the shell exists and is coming;
 * choosing it, in the list or with `/screen inline`, only says so.
 */
export const INLINE_AVAILABLE = false;

export const INLINE_UNAVAILABLE = "not available yet — we are working on it, it has too many bugs to use for now";
