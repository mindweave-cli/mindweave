/**
 * mouse.ts — wheel scrolling in the alternate screen.
 *
 * The alternate screen has no scrollback of its own, so the terminal's own wheel
 * does nothing: the rows on screen are all there is, and reaching for the wheel
 * to look back at what scrolled away simply does not respond. Keyboard paging is
 * not a substitute either — on Windows consoles those keys are frequently
 * consumed by the console host before the app ever sees them.
 *
 * So the app asks the terminal to report wheel events, and scrolls itself.
 *
 * The catch, and it is the whole reason `stripMouse` exists: once reporting is
 * on, those reports arrive as ordinary stdin bytes. They reach the wheel reader
 * AND Ink's key parser, which has no notion of a mouse report and passes the
 * bytes along as though they had been typed — so every scroll dumped
 * `[<64;25;26M` into the prompt. Anything reading typed input must strip them
 * first.
 *
 * The trade this makes, stated plainly: while reporting is on, the terminal stops
 * selecting text for us, because it has handed the mouse to the app. That is not a
 * setting that can be had both ways — a terminal either owns the mouse or the app
 * does. So the app owns it and does the selecting itself; see selection.ts.
 */

import { MOUSE_OFF } from "./terminalRestore.js";

/**
 * Report button presses AND all pointer movement (1003), using SGR encoding (1006), the
 * only encoding that stays correct past column 223.
 *
 * Motion is needed for two things. A drag is the movement BETWEEN a press and a release, so
 * under plain 1000 a selection could only ever be told where it started and where it
 * stopped. And a row that can be pressed has to light up when the pointer is over it, which
 * is movement with NO button held. 1002 reports only the first; 1003 reports both, at the
 * price of an event for every cell the pointer crosses. That price is paid in one place:
 * App turns a burst of them into one lookup and redraws only when the row under the
 * pointer actually changes.
 */
const MOUSE_ON = "\x1b[?1003h\x1b[?1006h";

/**
 * An SGR mouse report: `ESC [ < button ; col ; row (M|m)`.
 *
 * The ESC is optional because the same bytes reach us two ways: raw off stdin
 * with the ESC intact, and again through Ink's key parser, which strips it. Both
 * spellings have to match or the stripped one lands in the input box.
 */
const SGR = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

export type WheelDirection = "up" | "down";

/**
 * Every wheel event in a chunk of terminal input, in order (pure).
 *
 * A single flick can deliver several reports in one chunk, and each is a notch
 * the user turned — dropping the extras makes scrolling feel like it is ignoring
 * you, so they are all returned rather than collapsed.
 */
export function readWheel(data: string): WheelDirection[] {
  const out: WheelDirection[] = [];
  for (const match of data.matchAll(SGR)) {
    const button = Number(match[1]);
    // Bit 6 (64) marks a wheel event; bit 0 then separates up (0) from down (1).
    if ((button & 64) === 0) continue;
    out.push((button & 1) === 0 ? "up" : "down");
  }
  return out;
}

/** What the pointer did. `drag` is movement with a button still held. */
export type MouseKind = "press" | "drag" | "release" | "move";

/** One pointer event, in ZERO-based cell coordinates — the terminal reports 1-based, and
 *  converting here means nothing downstream has to remember to. */
export interface MouseEvent {
  kind: MouseKind;
  x: number;
  y: number;
}

/**
 * Every left-button pointer event in a chunk of terminal input, in order (pure).
 *
 * Only the left button, because that is the one that selects. The wheel is read
 * separately by `readWheel`, and the two never collide: a wheel report sets bit 6, which
 * is checked for and skipped here.
 */
export function readMouse(data: string): MouseEvent[] {
  const out: MouseEvent[] = [];
  for (const match of data.matchAll(SGR)) {
    const button = Number(match[1]);
    if ((button & 64) !== 0) continue; // a wheel notch, not a button
    // Movement with NO button held: bit 5 (motion) and the "no button" code 3 in bits 0-1.
    // Only there because the pointer being over something is worth knowing (see 1003 above).
    if ((button & 35) === 35) {
      out.push({ kind: "move", x: Number(match[2]) - 1, y: Number(match[3]) - 1 });
      continue;
    }
    // Bits 0-1 name the button. A RELEASE under SGR reports the button that was let go,
    // so this stays correct for both ends of a drag.
    if ((button & 3) !== 0) continue; // middle or right button
    const x = Number(match[2]) - 1;
    const y = Number(match[3]) - 1;
    // Bit 5 marks movement; the final `m` (rather than `M`) marks a release.
    const kind: MouseKind = match[4] === "m" ? "release" : (button & 32) !== 0 ? "drag" : "press";
    out.push({ kind, x, y });
  }
  return out;
}

/**
 * The same input with every mouse report removed (pure).
 *
 * Used by anything that treats stdin as typed text. Also drops a trailing
 * fragment of a report — a chunk boundary can split one, and half a report is
 * still not something the user typed.
 */
export function stripMouse(data: string): string {
  return data.replace(SGR, "").replace(/\x1b?\[<[\d;]*$/, "");
}

/** Turn wheel reporting on, returning a function that turns it back off.
 *  A no-op off a TTY, matching how altScreen.ts gates itself. */
export function enableMouse(): () => void {
  if (!process.stdout.isTTY) return () => {};
  process.stdout.write(MOUSE_ON);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    process.stdout.write(MOUSE_OFF);
  };
}
