/**
 * writer.ts — sits between Ink and the terminal, and writes only what changed.
 *
 * Ink's contract with the terminal is "erase everything I drew last time, then draw
 * all of it again", on every render. That is tens of kilobytes per frame on a large
 * terminal, pushed through a write that blocks the event loop on Windows — which is
 * why typing and scrolling lag in proportion to how much is on screen rather than
 * how much actually changed.
 *
 * This replaces that contract with a framebuffer:
 *
 *     Ink renders a frame  ->  parse it into a cell grid  ->  diff against the grid
 *     already on screen  ->  emit only the cells that differ  ->  keep the new grid
 *
 * Ink is untouched, and so is every component. The interception is a PROXY STDOUT
 * handed to `render()`, not a patch of `process.stdout`: everything arriving here is
 * therefore known to be Ink's renderer output, where a global patch would also catch
 * unrelated writes and have to guess which was which.
 *
 * ## Why it also writes the whole screen from time to time
 *
 * Diffing against a model of the terminal is only correct while the model is right, and
 * a wrong cell is never revisited, because as far as a diff can see nothing about it
 * changed. So the model is thrown away and the screen written in full on a schedule —
 * see `invalidate()`. That is what keeps a single stray row from becoming a session of
 * interleaved text, and it costs one Ink-sized frame every few seconds.
 *
 * ## What is passed through untouched
 *
 * Only frame CONTENT can be diffed. Control sequences that are not a frame — entering
 * the alternate screen, hiding the cursor, the synchronized-update markers Ink wraps
 * frames in — carry no cells and are forwarded exactly as sent. The test is whether a
 * write contains anything printable once its escape sequences are removed.
 */
import { Screen } from "./screen.js";
import { applyFrameOverlay, hasFrameOverlay, publishScreen, setOverlayRepaint } from "./overlay.js";
import { parseFrame } from "./parse.js";
import { paint } from "./paint.js";
import { caretCell, onCaretMoved, parkAt, HIDE } from "../caretPark.js";

/**
 * Synchronized output (DECSET 2026): hold the frame back until it is complete.
 *
 * The painter walks the cursor across the screen laying its runs down, and a terminal
 * draws every intermediate state — including the cursor at each stop. The first attempt
 * at hiding that streak HID THE CURSOR around each paint, which meant switching it off
 * and on again on every keystroke: the caret visibly blinked out whenever anything was
 * typed. This is the mechanism meant for the job. The terminal buffers between the two
 * markers and presents once, so nothing intermediate is ever shown and the cursor never
 * has to be taken away.
 *
 * Unsupported terminals ignore both as unknown modes and simply paint as they used to.
 */
const SYNC_START = "[?2026h";
const SYNC_END = "[?2026l";

/**
 * The prefix Ink puts before a frame to remove the previous one:
 * `\x1b[2K` (erase line) and `\x1b[1A` (cursor up) repeated, then `\x1b[G`.
 *
 * We drop it. The whole point of the framebuffer is that the previous frame is NOT
 * erased — the parts of it that are still correct stay on screen untouched, which is
 * exactly the work being saved.
 */
const ERASE_PREFIX = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/;

/**
 * A write with nothing in it but erasing — Ink clearing the screen on a narrowing resize.
 *
 * Every alternative matched is an erase, or the cursor move that walks between the rows
 * being erased. A sequence that also DRAWS cannot match: painted output carries absolute
 * cursor positioning and text, and neither is in this set.
 */
const ERASE_ONLY = /^(?:\x1b\[2K|\x1b\[1A|\x1b\[G)+$/;

/** Any escape sequence, for deciding whether a write carries visible content. */
const ANY_ESCAPE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[\]()#;?]*[0-9;]*[A-Za-z]|\x1b./g;

/**
 * How long the model and the real terminal may disagree during continuous work, in
 * milliseconds.
 *
 * Writing every cell costs about what Ink's own renderer cost on EVERY frame, so paying
 * it once every few seconds gives back almost none of the saving and puts a ceiling on
 * how wrong the screen can get. `0` writes in full every frame, which is Ink's original
 * behaviour and the thing to compare against when this is suspected.
 *
 * Read per wrapper rather than once at module load, so it is a property of the stream
 * being wrapped instead of of whichever import happened first.
 */
function fullRepaintMs(): number {
  const raw = Number(process.env["MINDWEAVE_FB_REPAINT_MS"]);
  return Number.isFinite(raw) && raw >= 0 ? raw : 4000;
}

/**
 * How long after the last frame of a burst the screen is written in full.
 *
 * Short enough that a glitch is gone before it can be read, long enough that it never
 * lands mid-burst: every frame cancels and re-arms it.
 */
const IDLE_REPAINT_MS = 400;

/**
 * Whether the framebuffer is doing anything at all.
 *
 * Module level rather than per wrapper, because there is exactly one wrapper in a
 * process (index.ts hands it to `render()`) and the switch is reached from the command
 * that flips screen modes, which has no access to it.
 */
let enabled = true;
/**
 * Set to force the NEXT frame to repaint every cell, not just the diff.
 *
 * For a moment where the model may have desynced from the terminal in a way the diff
 * cannot see — chiefly a scroll, where the terminal can move a row out from under the
 * model (a stray newline reaching the bottom, an auto-scroll on the last cell) and leave
 * a stale cell the diff then skips forever because "nothing changed". A scroll already
 * repaints almost every visible row, so redrawing the few stable ones (the pinned banner)
 * on top costs almost nothing and is what stops a transcript row surviving on the header.
 */
let repaintRequested = false;

/** Ask the framebuffer to redraw the whole next frame — see `repaintRequested`. */
export function requestFullRepaint(): void {
  repaintRequested = true;
}

/** Called when the framebuffer is switched back on, so it forgets the screen. */
let onReenable: (() => void) | null = null;
/** Called when the framebuffer stands down, so nothing it armed can still fire. */
let onDisable: (() => void) | null = null;

/**
 * Turn the diffing renderer on or off.
 *
 * Switching ON throws away the model of the screen, and that is not optional: while it
 * was off the terminal was scrolling and printing on its own, so every cell the model
 * remembers is a guess about a screen that has moved. Without this the first frame after
 * a switch back would diff against a fiction and paint almost nothing.
 */
export function setFramebufferEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  if (on) onReenable?.();
  else onDisable?.();
}

/** Whether frames are currently being diffed. */
export function framebufferEnabled(): boolean {
  return enabled;
}

/** A stream Ink can render into. Structural, so the real `process.stdout` satisfies it. */
export interface OutputStream {
  columns?: number;
  rows?: number;
  write(data: string, callback?: (err?: Error | null) => void): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** How the framebuffer performed, for the perf log. */
export interface FrameStats {
  /** Bytes Ink asked to write. */
  inBytes: number;
  /** Bytes actually sent to the terminal. */
  outBytes: number;
}

/**
 * Wrap `real` so Ink's frames are diffed before they reach it.
 *
 * `onFrame` is called after each frame with what it cost, so the perf log can report
 * the saving without this module knowing anything about logging.
 */
/**
 * The cursor instruction to append to a frame: parked at the caret, or hidden.
 *
 * The position comes from the LAYOUT (see caretPark.ts), not from the painted cells, so
 * it does not depend on the frame at all — only on the layout the frame was built from.
 * Hidden when nothing declares a caret, which is every screen that is not an input.
 */
function caretTail(): string {
  // Nothing at all while stood down, and this is the invariant rather than a tidy-up.
  //
  // `parkAt` is an ABSOLUTE move — row N of the viewport. That is right when the app
  // owns the screen and catastrophic when it does not: in the inline shell the caret's
  // measured y is its row within the LIVE REGION, a handful of rows tall at the bottom
  // of a terminal full of scrollback, so row N addresses somewhere near the top of the
  // window, in the middle of the conversation. The cursor lands there, and everything
  // that follows — the shell's own prompt after the process exits, most visibly — is
  // printed over the transcript.
  //
  // Stated here, at the single point the absolute move is produced, so no future caller
  // has to remember it. Empty and NOT `HIDE`: while stood down the caret belongs to Ink,
  // which shows the terminal's real cursor at the input, and hiding it would take away
  // the caret the inline shell types with.
  if (!enabled) return "";
  const cell = caretCell();
  return cell ? parkAt(cell) : HIDE;
}

export function framebufferStdout<T extends OutputStream>(real: T, onFrame?: (stats: FrameStats) => void): T {
  // The grid currently on the terminal, and the one being built for this frame. Two
  // long-lived buffers, swapped — never reallocated per frame, which is the whole
  // reason the cell data is in typed arrays.
  let onScreen = new Screen(real.columns ?? 80, real.rows ?? 24);
  let pending = new Screen(onScreen.width, onScreen.height);
  // The last frame as it was BEFORE any overlay tinted it. Only kept up to date while an
  // overlay is installed, which is what lets a highlight move without a new frame: the
  // clean copy is re-tinted at the new position rather than the tinted one being undone.
  const clean = new Screen(onScreen.width, onScreen.height);
  /** Whether `clean` actually holds the frame that is on screen. False until a frame has
   *  been drawn WITH an overlay installed — which is the usual state, since an overlay is
   *  installed long after the first frame. Re-tinting from a `clean` that was never filled
   *  would repaint the screen as blanks. */
  let cleanValid = false;
  /**
   * The last write that carried a frame, kept whether or not the framebuffer is on.
   *
   * Recorded while STOOD DOWN too, and that is the point: a shell switch renders the new
   * shell before the effect that moves the terminal runs, so the frame for the shell
   * being entered is written while this is still standing aside. It is the only copy of
   * that frame anyone has — Ink will not write it again, having already written it — so
   *  paints from here. See there.
   */
  let lastFrameData = "";
  /** The cursor instruction already on the terminal. Re-sending an identical one would
   *  put bytes on the wire for a frame where nothing changed, which is the one thing this
   *  renderer promises never to do. */
  let lastCursor = "";
  /** The cursor instruction the terminal is actually showing, for the change check. */
  let lastShown = "";

  const repaintEvery = fullRepaintMs();
  /** When every cell was last written, which is what bounds how long a disagreement
   *  with the real terminal can survive. */
  let lastFull = 0;
  /** The pending after-the-burst repaint, cancelled and re-armed by each frame. */
  let idle: ReturnType<typeof setTimeout> | undefined;

  /**
   * Match the grids to the terminal. Returns true when the size changed, which the
   * caller answers with a full write.
   *
   * Resizing used to reset `onScreen` to blanks, on the reasoning that a blank model
   * would make every cell differ and force a full repaint. It does the opposite: the new
   * frame's blank regions are also blanks, so the diff finds them identical and writes
   * nothing for them, while the real terminal still holds whatever was in those cells
   * before. That is what fused an old line onto a new one, leaving rows like
   * `Tools(session)s, ask_user, skill,`.
   */
  function syncSize(): boolean {
    // A LIVE query where the platform has one (`getWindowSize`), because `real.rows` /
    // `real.columns` are getters that on Windows can return a size cached at the last
    // resize event — an event that frequently never fires. Sized from the cached getter,
    // the grid stayed small while the frame above it grew, so the paint clipped to the
    // old height and the bottom of the screen went stale.
    const win = (real as { getWindowSize?: () => [number, number] }).getWindowSize?.();
    const w = win ? win[0] : real.columns ?? onScreen.width;
    const h = win ? win[1] : real.rows ?? onScreen.height;
    if (w === onScreen.width && h === onScreen.height) return false;
    onScreen.resize(w, h);
    pending.resize(w, h);
    return true;
  }

  /**
   * Forget what is on the terminal, so the next paint writes every cell.
   *
   * THIS IS THE RENDERER'S ONLY WAY BACK, and it is the reason the rest of the file is
   * safe. Everything here writes just the cells that changed between two frames, which
   * is correct exactly as long as the model and the terminal agree. When they stop
   * agreeing the error is PERMANENT: a cell the model has right but the terminal has
   * wrong is never rewritten, because as far as the diff can see nothing about it
   * changed. One stray row is enough to end a long session in interleaved text.
   *
   * There are several ways to lose that agreement — a row the terminal wrapped, a scroll
   * it performed, a write from outside this proxy — and no way to detect any of them
   * from in here. So this does not try to detect them. It gives a disagreement a
   * LIFETIME instead: on a resize, once every `FULL_REPAINT_MS` of continuous work, and
   * `IDLE_REPAINT_MS` after the last frame of a burst.
   *
   * Sentinel rather than an erase sequence. Filling the previous grid with a value no
   * real cell can equal makes every cell differ, so the paint that follows covers the
   * screen on its own. Erasing first would reach the same place with a blank flash in
   * between, and would depend on the terminal's erase honouring the current background.
   */
  function invalidate(): void {
    onScreen.invalidate();
    lastFull = Date.now();
  }

  // Coming back from the inline shell: the terminal has been scrolling and printing on
  // its own, so nothing the model believes about the screen is still true. Forget all of
  // it, and forget the cursor instruction too — the next frame has to send one whatever
  // it says, since the cursor is wherever the other shell left it.
  onReenable = () => {
    invalidate();
    lastCursor = "";
    lastShown = "";
    cleanValid = false;
    // And PAINT the frame again, because otherwise nobody will.
    //
    // The order a shell switch actually happens in is the whole reason this is needed.
    // React renders the new shell first and Ink writes that frame immediately — while
    // the framebuffer is still stood down, so it goes to the terminal untouched and
    // lands on the screen being left behind. Only then does the effect run: the
    // alternate screen is entered, which is blank, and this is switched back on. Ink is
    // now holding output identical to what it just wrote, so it writes nothing more, and
    // nothing else is scheduled to. The result is an empty alternate screen that stays
    // empty until something unrelated happens to cause a render.
    //
    // Re-feeding the last frame through the ordinary write path is what closes that gap.
    // It is the same bytes Ink produced for the shell being entered — React had already
    // rendered it — and going through `fbWrite` means it is parsed, diffed against the
    // just-invalidated model, and painted exactly like any other frame, rather than
    // through a second copy of that logic that could drift from it.
    if (lastFrameData !== "") fbWrite(lastFrameData);
  };

  // Going the other way: disarm the repaint the last frame of this shell armed. The
  // guards inside it make firing harmless, but a timer whose only possible outcome is
  // to do nothing is one that should not be running — and cancelling it is what makes
  // "stood down means silent" true by construction rather than by three checks agreeing.
  onDisable = () => {
    if (idle) clearTimeout(idle);
    idle = undefined;
  };

  /**
   * Re-assert the model onto the terminal outside of any frame.
   *
   * `pending` is scratch between frames — every frame rewrites it from scratch before
   * reading it — so it can hold the picture while `onScreen` becomes the grid that knows
   * nothing, and the two swap back exactly as they do on a normal frame.
   */
  function repaintNow(): void {
    // Stood down: the terminal is not ours to repaint. Everything below addresses cells
    // absolutely, so re-asserting a model of a screen we no longer own would stamp the
    // last full-screen frame over whatever the inline shell has printed since.
    //
    // The guard is here as well as on the timer that arms this, because the timer can
    // already be in flight when the switch happens — it is armed by the last frame of
    // the previous shell and fires a moment later, which is exactly the window this
    // used to go wrong in.
    if (!enabled) return;
    if (onScreen.width === 0 || onScreen.height === 0) return;
    pending.copyFrom(onScreen);
    invalidate();
    const escape = paint(onScreen, pending, 1);
    const previous = onScreen;
    onScreen = pending;
    pending = previous;
    // The grids were swapped, so the object anything outside is holding is now the
    // scratch buffer — and `invalidate()` above filled that one with a sentinel no
    // character can equal. Republishing is what stops a reader seeing it.
    publishScreen(onScreen);
    // Re-park the cursor, unconditionally.
    //
    // A repaint moves the cursor wherever its last run ended, so the position sent with
    // the previous frame is no longer where the cursor is — the dedup must be bypassed
    // rather than trusted. Skipping this left the cursor sitting in the bottom-right
    // corner, still visible, a fraction of a second after every burst of frames settled.
    // Bracketed for the same reason as a frame: a repaint writes every cell, so the
    // cursor would otherwise be seen travelling the whole screen.
    lastCursor = caretTail();
    lastShown = lastCursor;
    const painted = escape === "" ? lastCursor : SYNC_START + escape + lastCursor + SYNC_END;
    if (painted !== "") real.write(painted);
  }

  /**
   * Re-tint the frame already on screen and write the difference.
   *
   * This is what makes a drag cheap. Moving a selection changes no layout, so React
   * produces no new frame and there would otherwise be nothing to repaint. Re-tinting the
   * CLEAN copy (rather than trying to undo the tint on the screen grid) means the new
   * highlight is computed from scratch every time, so it cannot accumulate or leave a
   * cell inverted after the pointer has moved off it. The diff then writes only the cells
   * whose highlight actually changed, which is a couple of short runs.
   */
  function refreshOverlay(): void {
    // Stood down: same reason as `repaintNow`. There is no selection layer in the inline
    // shell, so this has nothing to re-tint there in any case.
    if (!enabled) return;
    if (!hasFrameOverlay()) return;
    if (onScreen.width === 0 || onScreen.height === 0) return;
    if (clean.width !== onScreen.width || clean.height !== onScreen.height) {
      clean.resize(onScreen.width, onScreen.height);
      cleanValid = false;
    }
    // The first re-tint after an overlay is installed has no clean copy to work from,
    // because the frame on screen was drawn before there was anything to keep one for.
    // That frame IS clean, though: nothing has tinted it yet. Taking it as the baseline
    // is what stops this repainting the screen as blanks.
    if (!cleanValid) {
      clean.copyFrom(onScreen);
      cleanValid = true;
    }
    pending.copyFrom(clean);
    applyFrameOverlay(pending);
    const escape = paint(onScreen, pending, 1);
    const previous = onScreen;
    onScreen = pending;
    pending = previous;
    publishScreen(onScreen);
    // Re-park the cursor, unconditionally.
    //
    // A repaint moves the cursor wherever its last run ended, so the position sent with
    // the previous frame is no longer where the cursor is — the dedup must be bypassed
    // rather than trusted. Skipping this left the cursor sitting in the bottom-right
    // corner, still visible, a fraction of a second after every burst of frames settled.
    // Bracketed for the same reason as a frame: a repaint writes every cell, so the
    // cursor would otherwise be seen travelling the whole screen.
    lastCursor = caretTail();
    lastShown = lastCursor;
    const painted = escape === "" ? lastCursor : SYNC_START + escape + lastCursor + SYNC_END;
    if (painted !== "") real.write(painted);
  }
  setOverlayRepaint(refreshOverlay);

  /**
   * Park the cursor when the caret moves but NO frame follows.
   *
   * Ink writes nothing when its output is unchanged, and typing a space at the end of a
   * line produces exactly that: the trailing blank is indistinguishable from the padding
   * beside it. The cursor was then the only thing that had moved, and nothing carried it
   * — so it sat a character behind until the after-burst repaint corrected it, which is
   * the pause that felt like the caret arriving late.
   *
   * Deferred by a microtask so the layout is settled and, more importantly, so a frame
   * that IS about to be written gets there first: it carries the same position, and the
   * change check below then makes this a no-op rather than a second write.
   */
  let parkQueued = false;
  onCaretMoved(() => {
    if (parkQueued) return;
    parkQueued = true;
    queueMicrotask(() => {
      parkQueued = false;
      // Stood down. This path writes to the terminal directly rather than through
      // `fbWrite`, so the check has to be repeated here: in the inline shell the cursor
      // belongs to Ink, and an absolute move would drop it somewhere in the scrollback.
      if (!enabled) return;
      const parked = caretTail();
      if (parked === lastShown) return;
      lastShown = parked;
      lastCursor = parked;
      real.write(parked);
    });
  });

  /** Arm the after-the-burst repaint. Unref'd: a screen touch-up must never be the
   *  reason the process is still alive. */
  function armIdleRepaint(): void {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      idle = undefined;
      repaintNow();
    }, IDLE_REPAINT_MS);
    idle.unref?.();
  }

  /**
   * Replaces `write` and nothing else.
   *
   * A hand-written object listing the members Ink "needs" was tried first and BROKE
   * THE APP: Ink reads `stdout.isTTY` in five places to decide whether it is driving
   * a terminal at all, the substitute did not have it, and Ink quietly took its
   * non-interactive path — a blank screen, no error. The tests did not catch it
   * because they pass a fake stdout that has no `isTTY` either, so both sides agreed
   * on the wrong thing.
   *
   * A Proxy is the fix that cannot have that class of bug again: every property, every
   * method, the prototype and `instanceof` all still resolve to the real stream, and
   * only `write` is ours. Nothing has to be enumerated, so nothing can be forgotten.
   */
  const fbWrite = (data: string, callback?: (err?: Error | null) => void): boolean => {
      // Stood down. Everything Ink writes goes straight to the terminal, untouched.
      //
      // The inline shell (see `screenMode.ts`) does not own the screen: its committed
      // output IS the terminal's scrollback, written once and scrolled by the terminal
      // itself. Every single thing this renderer does is wrong there. It strips the
      // erase-lines prefix, which is how Ink rewrites its live region; it diffs against
      // a grid the height of the window, when the real content is taller and moving; and
      // it parks the cursor absolutely, when in that mode the cursor belongs to Ink.
      //
      // A flag rather than a second stdout, because the stream is handed to `render()`
      // once and Ink holds it for the life of the process. `/screen` has to be able to
      // change its mind without unmounting the app.
      // Stood down. Everything Ink writes goes straight to the terminal, untouched —
      // INCLUDING the cursor move and show that Ink appends when a component has asked
      // for a position through `useCursor` (see PromptInput). That suffix is how the
      // caret exists at all in the inline shell, so nothing here may add to a frame or
      // take anything from it.
      if (!enabled) {
        // Remembered on the way past, because this is where the frame for the shell
        // being ENTERED goes: React renders it before the effect that moves the
        // terminal runs, so it is written while this is still standing aside. Ink will
        // not produce it a second time, so `onReenable` paints from what is kept here.
        // Only writes that carry cells — a bare control sequence is not a frame.
        if (data.replace(ANY_ESCAPE, "").trim() !== "") lastFrameData = data;
        return real.write(data, callback);
      }

      // A write that is NOTHING BUT AN ERASE. Swallowed, and this is the whole reason a
      // narrowing resize used to flicker.
      //
      // Ink clears the screen itself whenever the terminal gets narrower, to stop its own
      // re-renders overlapping. It writes that erase on its own, unsynchronized — measured
      // here, twenty-one `erase line` sequences in one write with no content — and only
      // then lays the new frame out. Forwarded, it does exactly what it says: the screen
      // goes blank, and stays blank for as long as the relayout takes. Dragging an edge is
      // one of those per event, which is the flicker.
      //
      // Nothing is lost by dropping it. The erase exists to stop stale rows showing
      // through a partial redraw, and that cannot happen here: a resize invalidates the
      // model below, so the next frame writes EVERY cell, and it goes out wrapped in
      // synchronized-update markers — the terminal holds the old picture until the whole
      // new one has arrived, then swaps in one step. That is strictly better than erasing,
      // because the old frame stays readable the entire time instead of a blank screen.
      //
      // Ink's own bookkeeping is untouched: `clear()` still runs and still resets its line
      // count, so it remains consistent with what it believes. Only the bytes are dropped,
      // and the screen was never Ink's to erase while this is switched on.
      if (ERASE_ONLY.test(data)) {
        callback?.(null);
        return true;
      }

      const body = data.replace(ERASE_PREFIX, "");

      const bare = body.replace(ANY_ESCAPE, "");
      // Nothing at all once the escapes are gone: a pure control sequence, not a frame.
      // Forward verbatim — this is how the alternate screen is entered, the cursor
      // hidden, and frames wrapped in synchronized-update markers, none of which we may
      // swallow.
      if (bare === "") return real.write(data, callback);

      // Escapes plus nothing but CONTROL characters — in practice a stray newline.
      //
      // This used to pass through with the case above, because the test trimmed before
      // asking, and a trimmed "\n" is empty. A newline is not inert: written at the
      // bottom row it SCROLLS THE WHOLE SCREEN UP ONE LINE. Every row is then somewhere
      // the model does not think it is, and since the model is the only thing that knows
      // what is on screen, nothing ever corrects it — the banner ends up half under a
      // tool row (`●MWrite(docs.html)`, the `M` being all that survived of "Mindweave").
      //
      // Swallowed rather than forwarded. Vertical position here is decided entirely by
      // the absolute cursor moves `paint` emits, so a newline arriving from outside that
      // can only move the real screen out from under the model. Tested by SPACES, not by
      // whitespace: a frame of nothing but spaces is a real frame that clears the screen,
      // and trimming would have swallowed that too.
      if (bare.replace(/[\r\n\t\v\f\b]/g, "") === "") {
        callback?.(null);
        return true;
      }

      // A resize invalidates everything, and so does simply having gone a while without
      // writing in full, and so does an explicit request (a scroll — see requestFullRepaint).
      // All are answered the same way: by knowing nothing about the screen, so that this
      // frame draws all of it.
      if (syncSize() || repaintRequested || Date.now() - lastFull >= repaintEvery) invalidate();
      repaintRequested = false;

      // Build the new frame. Cleared first because a frame is a complete statement
      // about the rows it covers: a line that got shorter must leave blanks behind,
      // not the tail of what used to be there.
      pending.clear();
      parseFrame(pending, body);

      // A selection highlight is added HERE, to the finished frame, and never reaches
      // React. `clean` keeps the untinted frame so the highlight can be moved without a
      // re-render (see `refreshOverlay`); it is only maintained while something is
      // actually tinting, so a session that never drags pays nothing for it.
      if (hasFrameOverlay()) {
        if (clean.width !== pending.width || clean.height !== pending.height) {
          clean.resize(pending.width, pending.height);
        }
        clean.copyFrom(pending);
        cleanValid = true;
        applyFrameOverlay(pending);
      } else {
        cleanValid = false;
      }

      const escape = paint(onScreen, pending, 1);

      // Swap rather than copy. Both grids are the same shape and `pending` is fully
      // rewritten at the start of every frame, so the old on-screen grid is free to
      // become the next scratch buffer — no allocation, no memcpy.
      const previous = onScreen;
      onScreen = pending;
      pending = previous;
      publishScreen(onScreen);

      onFrame?.({ inBytes: data.length, outBytes: escape.length });

      // Put the screen beyond doubt once this burst of frames stops. During a burst it
      // is only ever cancelled and re-armed, so it costs nothing until things settle.
      armIdleRepaint();

      // The caret is the TERMINAL's own cursor, parked AFTER the frame it belongs to.
      //
      // Last, and it has to be last: the painter moves the cursor all over the screen to
      // lay its runs down, so a position chosen before it finishes ends up wherever the
      // final run happened to leave off. Appended to the same write for the same reason —
      // a separate write could interleave and leave the cursor mid-paint.
      const parked = caretTail();
      lastCursor = parked;
      // A frame that PAINTED must always re-park, even when the caret has not moved.
      //
      // Painting walks the cursor to wherever the last run ended, so the instruction being
      // unchanged does not mean the cursor is still where it was put. Skipping it left the
      // caret stranded at the end of whatever was repainted — a rotating tip line was
      // enough to take it away, with nothing to bring it back until the next keystroke.
      //
      // The change check only applies when NOTHING was painted, which is the case it was
      // for: writing zero bytes for a frame where nothing happened.
      const out = escape === "" ? (parked === lastShown ? "" : parked) : SYNC_START + escape + parked + SYNC_END;
      if (out !== "") lastShown = parked;
      if (out === "") {
        // Nothing changed. Writing zero bytes is the correct output, but the caller
        // may be waiting on the callback, so it still has to be settled.
        callback?.(null);
        return true;
      }
      return real.write(out, callback);
  };

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "write") return fbWrite;
      const value = Reflect.get(target, prop, target);
      // Methods are bound to the REAL stream, not to the proxy. A stream's own
      // methods reach into its internal state, and calling them with the proxy as
      // `this` would have them look for that state on the wrong object.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
