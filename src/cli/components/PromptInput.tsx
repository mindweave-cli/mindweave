/**
 * PromptInput — the chat input box, pinned to the bottom of the screen.
 *
 * Owns its buffer + cursor via useInput (Ink does the word-wrapping; the box
 * grows downward). Beyond plain editing it provides the "real tool" niceties:
 *
 *  - Input history: ↑/↓ walk previously sent messages (a draft is preserved).
 *  - Slash autocomplete: typing `/…` opens a menu of matching commands/skills;
 *    ↑/↓ select, Tab completes, Enter runs the highlighted one.
 *  - Multiline: Shift+Enter inserts a newline (where the terminal reports it);
 *    Enter sends.
 *
 * Pinned to the bottom of the alt-screen frame (see App) while the chat scrolls
 * above it. Editing keys: ←/→, Ctrl+A/E (home/end), Ctrl+U (kill line),
 * Backspace, and paste (inserted at the cursor).
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Box, Text, measureElement, useCursor, useInput, type DOMElement } from "ink";
import { clickToOffset, inputView } from "../inputView.js";
import { cleanInputText } from "../inputText.js";
import { latestScreen } from "../framebuffer/overlay.js";
import { feedPasteChunk, initPasteState, type PasteState } from "../pasteAssembler.js";
import { stripMouse } from "../mouse.js";
import { killToLineEnd, wordEnd, wordStart } from "../wordEdit.js";
import { declareCaret } from "../caretPark.js";
import { ACCENT } from "../theme.js";

/** One autocomplete entry. */
export interface Completion {
  name: string; // includes the leading slash, e.g. "/skills"
  description: string;
}

// A paste collapses to a `[Pasted text …]` chip (the full content is restored when
// the message is sent) once it's big enough to flood the box — either many lines OR
// a long chunk that happens to be few lines (e.g. a couple of wrapped paragraphs).
// A single terminal paste always arrives as one `input` chunk, so a chunk this large
// is unambiguously a paste, never typed keys.
const PASTE_MIN_LINES = 6;
const PASTE_MIN_CHARS = 400;
// Bracketed paste: we ask the terminal (via `\x1b[?2004h`) to wrap every paste in
// `\x1b[200~ … \x1b[201~` markers, so we know exactly where a paste starts and ends
// instead of guessing. The chunk-reassembly state machine lives in pasteAssembler.ts
// (pure + unit-tested); here we just drive it and handle the timing fallback.
const BRACKET_PASTE_ON = "\x1b[?2004h";
const BRACKET_PASTE_OFF = "\x1b[?2004l";
// Safety net if the closing marker is lost or split across a chunk boundary: flush a
// marker-started paste after this much silence. Chunks of one paste arrive microseconds
// apart, so this never fires mid-paste.
const PASTE_END_TIMEOUT_MS = 250;
// Fallback for terminals that DON'T support bracketed paste (no markers ever arrive):
// coalesce chunks by timing. An input event this large, or one with a newline, or a
// continuation of one already buffering, is a paste chunk — never a typed key.
const PASTE_COALESCE_MS = 30;
const PASTE_CHUNK_MIN = 40;
// The longest single line still read as typing followed by Enter when it arrives in one chunk.
const TYPED_THEN_ENTER_MAX = 2000;

/**
 * The whole input buffer in one state object. Ink runs React in LegacyRoot mode, so
 * state updates from `useInput` (a Node stdin `data` listener, outside React's
 * batching scope) are NOT batched — each separate `setState` flushes its own
 * synchronous render and full terminal redraw. Folding every keystroke into ONE
 * reducer dispatch keeps it at one render → one frame per key, which is what makes
 * typing feel instant instead of laggy (especially on Windows, where each redraw is
 * comparatively expensive).
 */
interface InputState {
  value: string;
  cursor: number; // offset into `value`
  histIdx: number | null; // null = editing a fresh draft (not browsing history)
  selected: number; // highlighted suggestion in the menu
  draft: string; // the in-progress line, stashed while browsing history
  /** Text the user dragged over, as offsets into `value`. Backspace deletes it and typing
   *  replaces it, which is what "selected" means everywhere else. Null when nothing is
   *  selected, which is nearly always. */
  range: { from: number; to: number } | null;
}

const INITIAL: InputState = { value: "", cursor: 0, histIdx: null, selected: 0, draft: "", range: null };

/** The selected span as a safe, ordered pair inside the buffer, or null if there is none. */
function span(s: InputState): { from: number; to: number } | null {
  if (!s.range) return null;
  const from = Math.max(0, Math.min(s.range.from, s.value.length));
  const to = Math.max(0, Math.min(s.range.to, s.value.length));
  return from === to ? null : { from: Math.min(from, to), to: Math.max(from, to) };
}

type Action =
  | { t: "insert"; text: string } // a keypress or pasted chunk at the cursor
  | { t: "backspace" }
  | { t: "left" }
  | { t: "right" }
  | { t: "home" }
  | { t: "end" }
  | { t: "killLine" } // Ctrl+U — delete from start to cursor
  | { t: "killWordBack" } // Ctrl+W / Alt+Backspace: delete the chunk behind the cursor
  | { t: "killWordForward" } // Ctrl+Delete: delete the chunk ahead of it
  | { t: "killToEnd" } // Ctrl+K: delete the rest of the line
  | { t: "wordLeft" } // Ctrl+Left: move a chunk left
  | { t: "wordRight" } // Ctrl+Right: move a chunk right
  | { t: "moveTo"; offset: number } // a mouse click landed somewhere in the text
  | { t: "selectRange"; from: number; to: number } // a drag covered part of the text
  | { t: "newline" } // Shift/Meta+Enter
  | { t: "splice"; start: number; end: number; text: string } // replace a range (path completion)
  | { t: "selUp" }
  | { t: "selDown"; max: number }
  | { t: "histReplace"; value: string; histIdx: number | null; draft?: string }
  | { t: "restore"; value: string; cursor: number } // queued messages pulled back for editing
  | { t: "reset" };

function reduce(s: InputState, a: Action): InputState {
  // Every action but the two that manage it drops the selection. A selection is a thing
  // you are about to act on, not a mode to be left lying around: once the cursor has moved
  // or the text has changed, a range recorded against the old text means nothing.
  const clear = a.t === "selectRange" ? s : { ...s, range: null };

  switch (a.t) {
    case "insert": {
      // Typing over a selection replaces it, which is what selecting text is for.
      const sel = span(s);
      const from = sel ? sel.from : s.cursor;
      const to = sel ? sel.to : s.cursor;
      return {
        ...clear,
        value: s.value.slice(0, from) + a.text + s.value.slice(to),
        cursor: from + a.text.length,
        histIdx: null,
        selected: 0,
      };
    }
    case "backspace": {
      // With a selection, ONE press takes the whole of it rather than one character.
      const sel = span(s);
      if (sel) {
        return {
          ...clear,
          value: s.value.slice(0, sel.from) + s.value.slice(sel.to),
          cursor: sel.from,
          selected: 0,
        };
      }
      if (s.cursor === 0) return clear;
      return {
        ...clear,
        value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor),
        cursor: s.cursor - 1,
        selected: 0,
      };
    }
    case "selectRange":
      return { ...s, range: { from: a.from, to: a.to } };
    case "left":
      return { ...clear, cursor: Math.max(0, s.cursor - 1) };
    case "right":
      return { ...clear, cursor: Math.min(s.value.length, s.cursor + 1) };
    case "home":
      return { ...clear, cursor: 0 };
    case "end":
      return { ...clear, cursor: s.value.length };
    case "killLine":
      return { ...clear, value: s.value.slice(s.cursor), cursor: 0 };
    case "killWordBack": {
      const start = wordStart(s.value, s.cursor);
      if (start === s.cursor) return s;
      return { ...clear, value: s.value.slice(0, start) + s.value.slice(s.cursor), cursor: start, selected: 0 };
    }
    case "killWordForward": {
      const end = wordEnd(s.value, s.cursor);
      if (end === s.cursor) return s;
      return { ...clear, value: s.value.slice(0, s.cursor) + s.value.slice(end), selected: 0 };
    }
    case "killToEnd": {
      const next = killToLineEnd(s.value, s.cursor);
      if (next.value === s.value) return s;
      return { ...clear, value: next.value, cursor: next.cursor, selected: 0 };
    }
    case "wordLeft":
      return { ...clear, cursor: wordStart(s.value, s.cursor) };
    case "wordRight":
      return { ...clear, cursor: wordEnd(s.value, s.cursor) };
    case "moveTo":
      return { ...clear, cursor: Math.max(0, Math.min(s.value.length, a.offset)) };
    case "newline":
      return {
        ...s,
        value: s.value.slice(0, s.cursor) + "\n" + s.value.slice(s.cursor),
        cursor: s.cursor + 1,
      };
    case "splice": {
      const value = s.value.slice(0, a.start) + a.text + s.value.slice(a.end);
      return { ...clear, value, cursor: a.start + a.text.length, selected: 0 };
    }
    case "selUp":
      return { ...clear, selected: Math.max(0, s.selected - 1) };
    case "selDown":
      return { ...clear, selected: Math.min(a.max, s.selected + 1) };
    case "histReplace":
      return {
        ...s,
        value: a.value,
        cursor: a.value.length,
        histIdx: a.histIdx,
        draft: a.draft ?? s.draft,
      };
    case "restore":
      // Unlike histReplace this keeps NO history position and no draft: the text
      // came from the queue, not from history, so ↑ afterwards should walk history
      // from the newest again rather than resuming a walk the user never started.
      return { ...clear, value: a.value, cursor: Math.min(a.value.length, a.cursor), histIdx: null, selected: 0 };
    case "reset":
      return INITIAL;
  }
}

interface PromptInputProps {
  /** Called with the trimmed text when the user sends (Enter). */
  onSubmit: (value: string) => void;
  /** When true, the box is shown but input is inert (Mindweave is working). */
  disabled?: boolean;
  placeholder?: string;
  /** Current terminal width — used to bound the field so text wraps cleanly. */
  width: number;
  /** Previously sent messages, oldest-first — walked with ↑/↓. */
  history?: string[];
  /** Slash-command / skill completions offered when the buffer starts with `/`. */
  completions?: Completion[];
  /** Resolve a `@path` prefix to candidate paths (dirs end with `/`). Enables the
   *  file picker that opens while typing an `@mention`. */
  pathComplete?: (prefix: string) => Promise<string[]>;
  /** Register a large multi-line paste; returns the placeholder chip to insert in
   *  its place (the App restores the full text when the message is sent). */
  onLargePaste?: (content: string) => string;
  /** Register any file paths a drag-and-drop just delivered; returns the text with each
   *  path replaced by a short handle, so the buffer holds `mwimg1` rather than sixty
   *  characters of path. The App puts the real paths back when the message is sent. */
  onDroppedPaths?: (content: string) => string;
  /** Hand the App a way to place the caret from a mouse click. Only this component knows
   *  what its rows currently hold, which is what a click has to be resolved against. */
  registerCaretClick?: (place: ((x: number, y: number) => void) | null) => void;
  /** Hand the App a way to offer it a dragged range. Returns true when both ends landed
   *  in the input, which tells the App the selection is editable text rather than
   *  something dragged out of the transcript. */
  registerTextSelect?: (
    select: ((a: { x: number; y: number }, b: { x: number; y: number }) => boolean) | null,
  ) => void;
  /** How many command-palette rows App.tsx has actually verified there's room
   *  for — computed from the real frame height, not a guess. Showing more than
   *  this can make the footer taller than the screen, which corrupts the whole
   *  frame rather than just clipping (confirmed with a bare Ink render), so this
   *  is a hard cap, not a suggestion. Falls back to a small, always-safe count. */
  maxMenuRows?: number;
  /** Called when the suggestion menu's size changes (opened, closed, or
   *  filtered to a different number of rows). The App needs this to re-measure
   *  the footer — see the call site for why it can't detect it on its own. */
  onMenuChange?: () => void;
  /** Pull messages queued while Mindweave is working back into the box for editing,
   *  emptying the queue. Called on ↑ (from the first line) and on Esc. Returns the
   *  text and where to put the cursor, or undefined when nothing is queued — that
   *  distinction matters: on undefined ↑ must fall through to history, and Esc must
   *  fall through to the App's interrupt. */
  /** Draw the caret rather than parking the terminal cursor on it — the inline shell,
   *  which does not own the screen. See Field. */
  placeCursor?: boolean;
  /** Put the command menu ABOVE the input, without its border or title. The inline
   *  shell, where a taller region scrolls the terminal and every row costs one. */
  menuAbove?: boolean;
  /** Changes whenever something is committed to the terminal's scrollback. Releases the
   *  rows held open after the palette closes — see `holdPad` below. */
  settleKey?: number;
  onQueuePop?: (
    input: string,
    cursor: number,
    via: "up" | "escape",
  ) => { text: string; cursor: number } | undefined;
  /** Hard ceiling on how many rows the text area may occupy. Past it the box
   *  scrolls with the cursor instead of growing, because the rows it would take
   *  come off the bottom of a fixed frame — where the tip line lives. */
  maxInputRows?: number;
  /** A navigation/decision surface (a Picker) to show in the menu slot below the
   *  input, in place of the command menu. While present the input box stays visible
   *  but goes inert — the overlay owns the keys — so choosing an option keeps the same
   *  frame instead of swapping the whole design out. */
  overlay?: ReactNode;
  /** A surface for this box is being opened: hold the frame so it never leaves the screen
   *  between the command list closing and what it opened taking its place. */
  opening?: boolean;
  /** Text to put in the box, cursor at the end: a message handed back to be edited (a
   *  rewind). Applied once per new object, so the same text given twice still lands. */
  fill?: { text: string };
}

/** A literal newline, kept out of the key handler so the source has no escapes there. */
const NEWLINE = String.fromCharCode(10);
const DEFAULT_MAX_SUGGESTIONS = 6;
/** Rows the text area may grow to before it scrolls instead. Enough for a real
 *  paragraph; small enough that the chat above it is never squeezed away. */
const DEFAULT_MAX_INPUT_ROWS = 8;

export function PromptInput({
  onSubmit,
  disabled = false,
  placeholder = "",
  width,
  history = [],
  completions = [],
  pathComplete,
  onLargePaste,
  onDroppedPaths,
  registerCaretClick,
  registerTextSelect,
  maxMenuRows = DEFAULT_MAX_SUGGESTIONS,
  onMenuChange,
  placeCursor = false,
  menuAbove = false,
  settleKey = 0,
  onQueuePop,
  maxInputRows = DEFAULT_MAX_INPUT_ROWS,
  overlay,
  opening = false,
  fill,
}: PromptInputProps) {
  const [state, rawDispatch] = useReducer(reduce, INITIAL);
  // The buffer as it is NOW, not as it was at the last render. Ink renders on a timer, so a
  // key that arrives a few milliseconds after the one before it runs against the committed
  // state of before that one: Enter pressed right after the last letter saw an empty box and
  // sent nothing, and the text stayed where it was. Every action goes through the same pure
  // reducer here at the moment it is dispatched, so the answer to "what is in the box" is
  // always the latest one, however fast the keys come (a macro, a remote session, a stalled
  // machine delivering a backlog all at once).
  const latest = useRef(state);
  const dispatch = (action: Parameters<typeof rawDispatch>[0]) => {
    latest.current = reduce(latest.current, action);
    rawDispatch(action);
  };
  // Mirrors what the click handler needs, refreshed each render (see registerCaretClick).
  const clickCtx = useRef({ value: "", cursor: 0, fieldWidth: 0, maxRows: 1 });
  const { value, cursor, histIdx, selected, draft } = state;
  useEffect(() => {
    if (fill) dispatch({ t: "restore", value: fill.text, cursor: fill.text.length });
  }, [fill]);

  // The two autocomplete sources. Command menu: a single `/token` (no space) at the
  // start. Path menu: a `@token` ending at the cursor, resolved against the
  // filesystem (async, in the effect below). Command takes priority.
  const commandMode = value.startsWith("/") && !value.includes(" ");
  const at = !commandMode && pathComplete ? atTokenAt(value, cursor) : null;
  const [pathItems, setPathItems] = useState<string[]>([]);
  useEffect(() => {
    if (!at || !pathComplete) {
      setPathItems([]);
      return;
    }
    let cancelled = false;
    pathComplete(at.text.slice(1)).then((items) => {
      if (!cancelled) setPathItems(items);
    });
    return () => {
      cancelled = true;
    };
  }, [at?.text, pathComplete]);

  const menu = computeMenu();
  const menuOpen = menu !== null;
  const sel = Math.min(selected, Math.max(0, (menu?.items.length ?? 1) - 1));

  // Tell the App the footer's height just changed.
  //
  // Opening the menu is state local to THIS component, so React re-renders only
  // this subtree — App does not re-render, so App's own footer measurement never
  // re-runs and it keeps sizing the chat against a menu-closed footer. The menu
  // then overflows the frame and is clipped away entirely; sitting idle at the
  // prompt, nothing else re-renders App, so it never corrects itself. The row
  // count (not just open/closed) is the trigger, because filtering as you type
  // changes the height too.
  const menuRowCount = menu ? Math.min(menu.items.length, maxMenuRows) : 0;
  useEffect(() => {
    onMenuChange?.();
  }, [menuRowCount, onMenuChange]);

  function computeMenu(): { mode: "command" | "path"; items: Completion[]; start: number } | null {
    if (commandMode) {
      const items = completions.filter((c) => c.name.toLowerCase().startsWith(value.toLowerCase()));
      return items.length > 0 ? { mode: "command", items, start: 0 } : null;
    }
    if (at && pathItems.length > 0) {
      return { mode: "path", items: pathItems.map((p) => ({ name: "@" + p, description: "" })), start: at.start };
    }
    return null;
  }

  // Apply the highlighted path completion: splice it over the `@token` (keep the
  // menu open after a directory so you can keep drilling in).
  function completePath() {
    if (!menu || menu.mode !== "path") return;
    const chosen = menu.items[sel]!.name;
    const text = chosen.endsWith("/") ? chosen : chosen + " ";
    dispatch({ t: "splice", start: menu.start, end: cursor, text });
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    dispatch({ t: "reset" });
    onSubmit(trimmed);
  }

  // Paste reassembly: a paste arrives as several `input` chunks. `paste` holds the
  // cross-chunk state (see pasteAssembler.ts); the timer flushes the fallback path and
  // guards against a lost end marker.
  const paste = useRef<PasteState>(initPasteState());
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Insert an assembled paste — as a `[Pasted text …]` chip when it's big enough to
  // flood the box, otherwise inline.
  /**
   * The one way text enters the buffer, so a dropped file path is shortened to its handle
   * wherever it came in.
   *
   * That matters because a drop does NOT reliably arrive as a paste. Ink consumes the
   * bracketed-paste markers itself and hands the content over as one ordinary input
   * event, so whether a dropped path reaches the paste branch below or this one comes
   * down to whether it happened to be long enough to look like a paste. Shortening at
   * the single point every insert passes through makes that distinction irrelevant.
   *
   * A lone keystroke is never a path and typing is the hot path here, so anything one
   * character wide skips the scan entirely.
   */
  function insertText(raw: string) {
    // Plain text only, however it arrived (see inputText.ts): a pasted carriage return used to draw over the box.
    const text = cleanInputText(raw);
    if (!text) return;
    dispatch({ t: "insert", text: onDroppedPaths && text.length > 1 ? onDroppedPaths(text) : text });
  }
  function emitPaste(raw: string) {
    // Line breaks first: a paste counts its lines, and a terminal sends them as carriage returns.
    const text = cleanInputText(raw);
    if (!text) return;
    const big = text.split("\n").length >= PASTE_MIN_LINES || text.length >= PASTE_MIN_CHARS;
    if (onLargePaste && big) {
      dispatch({ t: "insert", text: onLargePaste(text) });
      return;
    }
    insertText(text);
  }
  function flushPaste() {
    pasteTimer.current = null;
    // A split end-marker can leave a stray trailing ESC; drop it.
    const buf = paste.current.buf.replace(/\x1b$/, "");
    paste.current = initPasteState();
    emitPaste(buf);
  }
  // Turn bracketed paste on so the terminal delimits pastes for us; restore it on exit.
  useEffect(() => {
    process.stdout.write(BRACKET_PASTE_ON);
    return () => {
      if (pasteTimer.current) clearTimeout(pasteTimer.current);
      process.stdout.write(BRACKET_PASTE_OFF);
    };
  }, []);

  useInput(
    (raw, key) => {
      // Mouse reports arrive as ordinary stdin bytes once wheel reporting is on
      // (see mouse.ts). Ink's key parser does not recognise them and hands them
      // straight through as if typed, so scrolling filled the prompt with
      // `[<64;25;26M`. Stripped FIRST — ahead of the paste assembler, which would
      // otherwise buffer a fast flick and commit it as a pasted block.
      const input = stripMouse(raw);
      // A chunk that was nothing but mouse reports is not a keystroke. Guarded on
      // `raw` being non-empty so genuine keys that carry no text (arrows, Enter)
      // still reach the handlers below.
      if (input === "" && raw !== "") return;

      // Bracketed paste (authoritative): from the `\x1b[200~` start marker to the
      // `\x1b[201~` end marker, every chunk is literal pasted content — never Enter,
      // arrows, or other keys — so we handle it here, before anything else, accumulating
      // across chunks. The paste flushes as ONE unit (one chip) at the end marker; the
      // timer only guards against a lost/split end marker.
      const step = feedPasteChunk(paste.current, input);
      if (step.kind !== "passthrough") {
        if (pasteTimer.current) clearTimeout(pasteTimer.current);
        if (step.kind === "flush") {
          pasteTimer.current = null;
          paste.current = initPasteState();
          emitPaste(step.text);
        } else {
          paste.current = step.state;
          pasteTimer.current = setTimeout(flushPaste, PASTE_END_TIMEOUT_MS);
        }
        return;
      }

      // Enter: Shift+Enter inserts a newline (terminals that report it); plain
      // Enter sends — the highlighted suggestion when the menu is open, else the
      // buffer.
      if (key.return) {
        if (key.shift || key.meta) {
          dispatch({ t: "newline" });
          return;
        }
        // In the path menu, Enter completes the path (you press Enter again to send);
        // in the command menu it runs the highlighted command; otherwise it sends.
        if (menu?.mode === "path") {
          completePath();
          return;
        }
        // Rendered state that is behind the buffer (keys arrived faster than frames) is not
        // the box the user is looking at: send what is really in it.
        submit(latest.current.value !== value ? latest.current.value : menu ? menu.items[sel]!.name : value);
        return;
      }

      // Tab completes the highlighted suggestion (a command, or a path mention).
      // Shift-Tab is reserved for cycling the interaction mode (handled in App), so
      // it must never complete here.
      if (key.tab && !key.shift && menu) {
        if (menu.mode === "path") completePath();
        else dispatch({ t: "histReplace", value: menu.items[sel]!.name + " ", histIdx: null });
        return;
      }

      // ↑/↓: navigate the menu when open, otherwise walk input history.
      if (key.upArrow) {
        if (menuOpen) dispatch({ t: "selUp" });
        else if (!popQueue()) historyPrev();
        return;
      }
      if (key.downArrow) {
        if (menuOpen) dispatch({ t: "selDown", max: menu!.items.length - 1 });
        else historyNext();
        return;
      }

      // Chunk-sized editing. Every one of these has to be tested BEFORE the plain
      // backspace and arrow handlers below, which claim the same physical keys and would
      // otherwise swallow the chord one character at a time.
      //
      // Ctrl+Backspace is deliberately absent. The terminal sends it as the same byte as
      // a bare Backspace, so there is nothing to tell the two apart by: binding it would
      // either do nothing or change what plain Backspace does. Ctrl+W and Alt+Backspace
      // are the chords that survive the wire, and both are bound here.
      if ((key.ctrl && input === "w") || (key.meta && key.backspace)) {
        dispatch({ t: "killWordBack" });
        return;
      }
      if (key.ctrl && key.delete) {
        dispatch({ t: "killWordForward" });
        return;
      }
      if (key.ctrl && input === "k") {
        dispatch({ t: "killToEnd" });
        return;
      }
      if (key.ctrl && key.leftArrow) {
        dispatch({ t: "wordLeft" });
        return;
      }
      if (key.ctrl && key.rightArrow) {
        dispatch({ t: "wordRight" });
        return;
      }

      if (key.backspace || key.delete) {
        dispatch({ t: "backspace" });
        return;
      }
      if (key.leftArrow) {
        dispatch({ t: "left" });
        return;
      }
      if (key.rightArrow) {
        dispatch({ t: "right" });
        return;
      }
      if (key.ctrl && input === "a") {
        dispatch({ t: "home" });
        return;
      }
      if (key.ctrl && input === "e") {
        dispatch({ t: "end" });
        return;
      }
      if (key.ctrl && input === "u") {
        dispatch({ t: "killLine" });
        return;
      }

      // Esc takes back whatever is queued, if anything is. When nothing is, it falls
      // through untouched and stays what it has always been — the App's interrupt.
      // Both handlers are live at once while Mindweave is working, and that is the
      // behaviour we want there: Esc stops the turn, and popQueue() declines because
      // App refuses to pop mid-turn (see its onQueuePop).
      if (key.escape) {
        popQueue();
        return;
      }

      // Ignore control chords / keys we don't handle here.
      if (key.ctrl || key.meta || key.tab) {
        return;
      }

      // Printable text. On terminals WITHOUT bracketed paste (no markers ever arrive),
      // we fall back to timing: a large chunk, a chunk with a newline, or a continuation
      // of one already buffering is a paste — accumulate and flush once idle so the whole
      // paste is one decision (one chip). A lone keypress inserts immediately.
      // Typing that reached us as ONE chunk with its Enter on the end ("hello\r"): keys that were
      // pressed a few milliseconds apart and delivered together, by a macro, a remote session or a
      // machine that stalled for a moment. That is typing then Enter, not a paste (a real paste
      // is bracketed above, or has newlines inside it), and treating it as text left the message
      // sitting in the box with no Enter ever seen.
      const typedThenEnter = /^([^\r\n]+)\r$/.exec(input);
      if (typedThenEnter && paste.current.buf.length === 0 && typedThenEnter[1]!.length < TYPED_THEN_ENTER_MAX && !key.ctrl && !key.meta) {
        insertText(typedThenEnter[1]!);
        submit(latest.current.value);
        return;
      }
      if (input) {
        const isPasteChunk =
          paste.current.buf.length > 0 || input.length >= PASTE_CHUNK_MIN || input.includes("\n");
        if (isPasteChunk) {
          paste.current.buf += input;
          if (pasteTimer.current) clearTimeout(pasteTimer.current);
          pasteTimer.current = setTimeout(flushPaste, PASTE_COALESCE_MS);
        } else {
          insertText(input);
        }
      }

      /** Take the queue back into the box. False when there was nothing to take. */
      function popQueue(): boolean {
        if (!onQueuePop) return false;
        // Only from the FIRST line. In a multi-line draft ↑ means "move up a line",
        // and stealing that would make the queue impossible to leave alone.
        if (key.upArrow && value.slice(0, cursor).includes(NEWLINE)) return false;
        const popped = onQueuePop(value, cursor, key.upArrow ? "up" : "escape");
        if (!popped) return false;
        dispatch({ t: "restore", value: popped.text, cursor: popped.cursor });
        return true;
      }

      function historyPrev() {
        if (history.length === 0) return;
        if (histIdx === null) {
          const i = history.length - 1;
          dispatch({ t: "histReplace", value: history[i]!, histIdx: i, draft: value });
        } else if (histIdx > 0) {
          dispatch({ t: "histReplace", value: history[histIdx - 1]!, histIdx: histIdx - 1 });
        }
      }
      function historyNext() {
        if (histIdx === null) return;
        const i = histIdx + 1;
        if (i >= history.length) {
          dispatch({ t: "histReplace", value: draft, histIdx: null });
        } else {
          dispatch({ t: "histReplace", value: history[i]!, histIdx: i });
        }
      }
    },
    { isActive: !disabled && !overlay },
  );

  const fieldWidth = Math.max(10, width - 6);
  // The menu box's baseline height: a border (2) around a header (1), `maxMenuRows` item
  // rows, and the hint (1). Used as a MINIMUM so the command list and every picker (which
  // pad to `maxMenuRows`) land at exactly this height and never resize as you filter or
  // switch, while a richer surface in the same box (the key manager, an approval) may grow
  // past it rather than being clipped.
  // Bordered: a border (2) around a header (1), the item rows, and the hint (1). Bare —
  // the inline shell — keeps only the rows and the hint, because the two it drops are two
  // more rows the terminal has to scroll for and neither is part of the choice.
  const menuBoxRows = maxMenuRows + (menuAbove ? 1 : 4);

  // Clicking in the text moves the caret there.
  //
  // What the click has to be resolved against is the CURRENT buffer, so the handler reads
  // through a ref that this render refreshes rather than closing over a snapshot: a
  // handler registered once and holding last minute's text would place clicks against
  // characters that are no longer on screen. The alternative — re-registering on every
  // keystroke — would put a subscribe and unsubscribe on the typing path for no gain.
  //
  // The mapping itself deliberately knows nothing about where the box was laid out; it
  // finds the row's text in what was actually painted. See clickToOffset.
  clickCtx.current = { value, cursor, fieldWidth, maxRows: maxInputRows };

  /** Screen cell to buffer offset, against the buffer as it stands right now. */
  function offsetAt(x: number, y: number): number | null {
    const screen = latestScreen();
    if (!screen) return null;
    const { value: text, cursor: at, fieldWidth: w, maxRows } = clickCtx.current;
    const view = inputView(text, at, Math.max(1, w - 1), maxRows);
    const rowAt = (row: number) => (col: number) => {
      if (row < 0 || row >= screen.height || col < 0 || col >= screen.width) return " ";
      const ch = screen.chars[screen.index(col, row)]!;
      // A grid caught mid-repaint holds sentinels that are not codepoints at all, and
      // String.fromCodePoint throws on them. Reading them as blanks simply means the row
      // will not match and the click is ignored, which is the right outcome.
      return ch > 0x10ffff ? " " : String.fromCodePoint(ch);
    };
    return clickToOffset(view.rows, view.cursorRow, view.cursorCol, rowAt, screen.width, x, y);
  }

  useEffect(() => {
    if (!registerCaretClick) return;
    registerCaretClick((x, y) => {
      const offset = offsetAt(x, y);
      if (offset !== null) dispatch({ t: "moveTo", offset });
    });
    return () => registerCaretClick(null);
  }, [registerCaretClick]);

  useEffect(() => {
    if (!registerTextSelect) return;
    registerTextSelect((a, b) => {
      // Both ends have to land in the input. A drag that started in the transcript is
      // something to copy, not something to edit, and must not be reported as text.
      const from = offsetAt(a.x, a.y);
      const to = offsetAt(b.x, b.y);
      if (from === null || to === null || from === to) return false;
      // The far end of a drag is the cell the pointer is ON, and that character is part of
      // what was highlighted, so the range has to reach past it.
      const [lo, hi] = from < to ? [from, to + 1] : [to, from + 1];
      dispatch({ t: "selectRange", from: lo, to: hi });
      return true;
    });
    return () => registerTextSelect(null);
  }, [registerTextSelect]);

  // The ONE surface for everything: the command menu, every picker, the key manager, an
  // approval prompt — they all render HERE, in a single box beside the input. It appears
  // ONLY when something is open, and its height is FIXED at  and NEVER grows:
  // every surface inside windows or pads its content to fit and scrolls when there is
  // more, so the box is one steady size no matter what it holds.
  //
  // WHERE it sits is the shells' only disagreement about it. Fullscreen puts it beneath
  // the input, inside a frame of fixed height, so opening it shrinks the chat and closing
  // it gives those rows back — nothing moves that does not come back. Inline has no frame:
  // the region simply gets taller, the terminal SCROLLS to fit it, and that scroll is
  // one-way. Above the input, the prompt stays the last thing on screen through all of it,
  // and the rows the palette borrowed are given back above rather than below (see
  // livePad.ts). The chrome goes too, because inline every row costs a scroll.
  // Blank rows holding the prompt still when the palette closes.
  //
  // The palette makes the live region taller than the room below it, so the TERMINAL
  // scrolls to fit — and a scroll is one-way. Closing it again would let Ink write a
  // shorter region at the top of where the tall one was, dropping the prompt a dozen rows
  // up the screen with a gap beneath it. The rows are held instead of given back.
  //
  // Computed HERE, beside the box it compensates for, and that placement is the fix for a
  // bug that survived two attempts elsewhere. Held in App, the height had to arrive
  // through a callback — a render late — so for exactly one frame the pad and the palette
  // were BOTH on screen, the region grew by twice what it should have, and the correction
  // on the next frame left the gap it was supposed to prevent. Same state, same render,
  // and the two can no longer disagree.
  //
  //  changes when something is committed to scrollback. That is when the hold
  // is released: printing pushes the live region back to the bottom of the screen on its
  // own, so the rows are no longer holding anything up, and keeping them would leave a
  // band of blank above the prompt for the rest of the session.
  const boxRows = overlay || menu || opening ? menuBoxRows + 1 : 0;
  const holdRef = useRef(0);
  const heldAt = useRef(settleKey);
  if (heldAt.current !== settleKey) {
    heldAt.current = settleKey;
    holdRef.current = 0;
  }
  holdRef.current = Math.max(holdRef.current, boxRows);
  // Only the inline shell needs this. Fullscreen has a frame of fixed height: the palette
  // shrinks the chat and closing it gives those rows back, so nothing ever scrolls.
  const holdPad = menuAbove ? Math.max(0, holdRef.current - boxRows) : 0;

  const menuBox =
    overlay || menu || opening ? (
        <Box
          flexDirection="column"
          width={width}
          height={menuBoxRows}
          flexShrink={0}
          {...(menuAbove ? { marginBottom: 1 } : { borderStyle: "single" as const, borderColor: "gray", paddingX: 1, marginTop: 1 })}
          overflow="hidden"
        >
          {overlay ? (
            overlay
          ) : menu ? (
            <SuggestionMenu matches={menu.items} selected={sel} width={width} mode={menu.mode} maxRows={maxMenuRows} bare={menuAbove} />
          ) : (
            // `opening`: a command that opens a surface here was submitted, and the surface
            // is a moment away. The frame is held open with an empty body so the transition
            // from the command list to what it opens is a change of CONTENT inside one box
            // that never leaves the screen.
            <Box flexDirection="column" height={menuBoxRows - 2} />
          )}
      </Box>
    ) : null;

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {holdPad > 0 ? <Box flexShrink={0} height={holdPad} /> : null}
      {menuAbove ? menuBox : null}
      {/* The chat input box — its own box, always separate from the menu below it. */}
      <Box
        flexDirection="column"
        width={width}
        flexShrink={0}
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
      >
        <Field
          value={value}
          cursor={cursor}
          active={!disabled && !overlay}
          placeholder={overlay ? "" : placeholder}
          width={fieldWidth}
          maxRows={maxInputRows}
          placeCursor={placeCursor}
        />
      </Box>

      {menuAbove ? null : menuBox}
    </Box>
  );
}

/** The `@token` ending at the cursor (back to the nearest whitespace), or null.
 *  Used to drive the file-path picker while typing a `@mention`. */
// No real @mention (a path) is anywhere near this long. Without a cap, a run of
// the same non-whitespace character (fast typing, a held key) has no whitespace
// to stop the scan at, so it walks back to index 0 on EVERY keystroke — O(cursor)
// work repeated once per character typed, which is what made fast typing laggy
// even well under the length where Field's own render-windowing kicks in.
const MAX_TOKEN_SCAN = 300;

function atTokenAt(value: string, cursor: number): { text: string; start: number } | null {
  const floor = Math.max(0, cursor - MAX_TOKEN_SCAN);
  let i = cursor;
  while (i > floor && !/\s/.test(value[i - 1]!)) i--;
  if (i === floor && floor > 0 && !/\s/.test(value[floor - 1] ?? " ")) return null; // ran into the cap, not a real boundary
  const text = value.slice(i, cursor);
  return text.startsWith("@") ? { text, start: i } : null;
}

/**
 * The dropdown of matching commands/skills shown below the input. It SCROLLS: a
 * sliding window keeps the highlighted row in view as ↑/↓ move past the visible
 * count, so a long list (every command) is fully reachable, not capped at the first
 * few. The window is always the same number of rows, and no "N more" markers are
 * shown, so the box stays one fixed height from the first item to the last: a marker
 * that appeared only at the ends made the box taller mid-list and shifted the whole
 * transcript above it by a row when the selection crossed into or out of an end.
 *
 * Bordered like the input box itself, not a bare list floating under it — same
 * treatment, same reason: it's the other place the user is choosing something,
 * not just reading a log.
 */
function SuggestionMenu({
  matches,
  selected,
  width,
  mode,
  maxRows,
  bare = false,
}: {
  matches: Completion[];
  selected: number;
  width: number;
  mode: "command" | "path";
  maxRows: number;
  /** Drop the title row. The inline shell pays for every row it renders — see the box
   *  below — and the title is the one line here that says nothing about the choice. */
  bare?: boolean;
}) {
  // Window the list so `selected` is always visible (same scheme as Picker).
  const start = Math.min(Math.max(0, selected - (maxRows - 1)), Math.max(0, matches.length - maxRows));
  const shown = matches.slice(start, start + maxRows);
  const nameWidth = Math.min(18, Math.max(...shown.map((m) => m.name.length), 1));
  const title = mode === "command" ? "Commands" : "Files";
  // The prefix ("› " / "  ") + the padded name, so the description column knows
  // exactly what's left. Without this Box the description had no width of its
  // own to truncate against — Yoga let a long one push past the row and wrap,
  // splitting a command's NAME onto its own line, one row later than where it
  // belonged. Confirmed with a bare Ink render before this fix went in.
  //
  // Widths subtract the enclosing box's chrome — border (2) + paddingX (2) = 4 — plus
  // the 2-col prefix, so a truncated description ends INSIDE the border. Without the
  // full subtraction a long line filled the row past the content area and wrapped,
  // leaving a blank continuation row between items.
  const rowWidth = width - 4;
  const descWidth = Math.max(4, rowWidth - 2 - nameWidth);
  // The parenthetical is the only place that says you can keep TYPING to narrow the
  // list. Without it the arrows look like the only way through, and a long catalog
  // reads as something to scroll rather than something to filter.
  const header = (
    <Box flexShrink={0}>
      <Text bold>{title}</Text>
      <Text dimColor>{" (type to filter, or use ↑/↓)"}</Text>
    </Box>
  );
  const hint = mode === "command" ? "Tab completes · Esc dismisses" : "↑/↓ to select · Enter/Tab to complete · Esc dismisses";
  // Blank rows padding the list up to `maxRows`, so the box is the SAME height whether it
  // shows two matches or twelve. Fixed dimensions: the menu box never resizes as you
  // filter down or switch to a shorter list — the surplus is empty space, not a smaller box.
  const pad = Math.max(0, maxRows - shown.length);
  // Content only — the surrounding box is the menu box in PromptInput. flexShrink:0 on
  // every row is what makes App.tsx's maxRows cap reliable: without it Yoga compresses an
  // overfull menu instead of respecting the cap computed so it wouldn't need to (confirmed
  // with a bare Ink render, same as the chat viewport's rows — see App.tsx).
  return (
    <>
      {bare ? null : header}
      {shown.map((m, i) => {
        const active = start + i === selected;
        return (
          <Box key={m.name} width={rowWidth} flexShrink={0}>
            <Text color={active ? ACCENT : undefined} bold={active}>
              {active ? "› " : "  "}
              {m.name.padEnd(nameWidth)}
            </Text>
            <Box width={descWidth}>
              <Text dimColor wrap="truncate-end">{"  " + m.description}</Text>
            </Box>
          </Box>
        );
      })}
      {Array.from({ length: pad }).map((_, i) => (
        <Box key={`pad${i}`} flexShrink={0}><Text> </Text></Box>
      ))}
      <Box flexShrink={0}>
        <Text dimColor>{hint}</Text>
      </Box>
    </>
  );
}

/** The text area: the buffer word-wrapped, with a block cursor, or a placeholder. */
/**
 * The text area: the buffer wrapped into rows with a block cursor, capped in height.
 *
 * Row-by-row rather than one `<Text wrap="wrap">`, because the box has to know how tall
 * it is. Left to wrap itself it grew without limit, and since it shares a fixed frame
 * with the chat and the tip line, the rows it took came off the bottom of the screen —
 * the tip vanished and the box looked cut in half. The wrapping and the cursor maths
 * live in inputView.ts, where they are unit-tested.
 */
function Field({
  value,
  cursor,
  active,
  placeholder,
  width,
  maxRows,
  placeCursor,
}: {
  value: string;
  cursor: number;
  active: boolean;
  placeholder: string;
  width: number;
  maxRows: number;
  /**
   * Draw the caret as a cell, instead of relying on the terminal's own cursor being
   * parked on it.
   *
   * True in the inline shell, and it is not a preference there — parking needs an
   * absolute cursor move, which needs to know where everything is, which is exactly what
   * the app gives up by not owning the screen. Without this the input has no caret at
   * all and the real cursor sits wherever Ink's output happened to end, stranded on a
   * line of its own below the box.
   *
   * Inverse rather than a bar, and that is the one honest option: a bar has to live
   * somewhere, and a grid has no room between two cells, so it would either take a
   * column (opening a gap between the letters it sits between) or stand on the character
   * and hide it for half of every blink. Inverse takes no column and the character stays
   * readable. The terminal's own cursor does better than any of these, which is why the
   * fullscreen shell parks it — this is what is left when that is not available.
   */
  placeCursor: boolean;
}) {
  // ---- NO EARLY RETURN ABOVE THIS BLOCK ----
  // Every hook here runs before the empty-value branch below returns. A hook underneath
  // an early return runs a different number of times on the two renders either side of
  // it, which takes the whole tree down; this app has already been bitten by exactly that.
  const caretRowRef = useRef<DOMElement | null>(null);
  const caretView = inputView(value, cursor, Math.max(1, width - 1), maxRows);
  // Declared during RENDER, not from a layout effect.
  //
  // Ink writes its frame from resetAfterCommit, which React runs BEFORE layout effects.
  // A declaration made in useLayoutEffect is therefore read by the NEXT frame, not this
  // one — the cursor sat one keystroke behind, visibly at the old position for a moment
  // before catching up. Declaring here happens before the frame is built.
  //
  // Only the column is a value; the box is a REF, resolved at paint time when it has been
  // attached and yoga has measured it. So nothing here has to be current except the
  // number, which is.
  declareCaret(active ? { ref: caretRowRef, column: value.length === 0 ? 0 : caretView.cursorCol } : null);

  // ── the inline shell: the same caret, placed by Ink instead of by us ──────
  //
  // Fullscreen parks the terminal's own cursor after each frame, because it owns the
  // screen and knows where every cell is. Inline it owns nothing — but Ink does, and
  //  is its API for exactly this: hand it a position relative to the live
  // output and it emits the move and the show on the end of its own frame.
  //
  // So the caret is the REAL terminal cursor in both shells. Thin, blinking or not
  // according to the terminal's own setting, taking no column and hiding no character.
  // The block that was here before was what every inline terminal app draws when it
  // gives up on this, and it is worse in all three of those ways.
  //
  // The ROW comes from a measurement of the previous frame; the COLUMN is computed
  // fresh every render. That split is what keeps typing exact: a keystroke moves the
  // column and nothing else, so the caret is never a frame behind where the character
  // just went. The row only moves when the layout does — a block landing, a wrap — and
  // catches up on the frame after, when nobody is mid-keystroke.
  const { setCursorPosition } = useCursor();
  const [caretAnchor, setCaretAnchor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!placeCursor || !caretRowRef.current) return;
    try {
      const box = measureElement(caretRowRef.current);
      // A node that has never been laid out measures as nothing. Anchoring there would
      // put the cursor at the top-left corner of the output.
      if (box.width === 0 && box.height === 0) return;
      setCaretAnchor((a) => (a && a.x === box.x && a.y === box.y ? a : { x: box.x, y: box.y }));
    } catch {
      // Unmounted between the render and the measurement.
    }
  });
  if (placeCursor) {
    const column = value.length === 0 ? 0 : caretView.cursorCol;
    setCursorPosition(active && caretAnchor ? { x: caretAnchor.x + column, y: caretAnchor.y } : undefined);
  }


  if (value.length === 0) {
    // An empty prompt still has a caret, sitting where the first character will go: at
    // the START of the placeholder, which is the row the renderer can find on screen.
    return (
      <Box flexShrink={0}>
        <Text bold color={ACCENT}>{"> "}</Text>
        {/* The caret sits at the start of this box when there is nothing typed yet. */}
        <Box width={width} overflow="hidden" ref={caretRowRef}>
          <Text wrap="truncate-end">
            {placeholder ? <Text dimColor>{placeholder}</Text> : null}
          </Text>
        </Box>
      </Box>
    );
  }

  // One column narrower than the box, because the caret is a real column.
  //
  // At the end of a row the caret has no character to sit on top of, so it ADDS a column
  // to that row. Wrapped to the full box width, a row that filled the box then rendered
  // one column too wide, `truncate-end` cut it, and the `…` landed on the character just
  // typed — so the box would hide exactly the letter being written, and only once a line
  // was full. The reserved column is never wasted: the caret is always somewhere.
  const view = inputView(value, cursor, Math.max(1, width - 1), maxRows);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {view.hiddenAbove > 0 ? (
        <Box flexShrink={0}><Text dimColor>{`  ↑ ${view.hiddenAbove} more line${view.hiddenAbove === 1 ? "" : "s"}`}</Text></Box>
      ) : null}
      {view.rows.map((row, i) => (
        <Box key={i} flexShrink={0}>
          {/* The marker is only on the first row; continuations align under the text
              so a wrapped message reads as one paragraph, not a list. */}
          <Text bold color={ACCENT}>{i === 0 && view.hiddenAbove === 0 ? "> " : "  "}</Text>
          <Box
            width={width}
            overflow="hidden"
            ref={active && i === view.cursorRow ? caretRowRef : undefined}
          >
            <Text wrap="truncate-end">
              {row.text}
            </Text>
          </Box>
        </Box>
      ))}
      {view.hiddenBelow > 0 ? (
        <Box flexShrink={0}><Text dimColor>{`  ↓ ${view.hiddenBelow} more line${view.hiddenBelow === 1 ? "" : "s"}`}</Text></Box>
      ) : null}
    </Box>
  );
}

