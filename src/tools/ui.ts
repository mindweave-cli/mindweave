/**
 * ui.ts — let the agent USE an app: see its controls, press them, type into them.
 *
 * `screenshot` answers "does it look right". This answers the next question, the one a
 * picture cannot: "does it work". An agent that built a library view and can only look
 * at the home screen has checked the home screen. With this it can open the view, pick
 * an item, fill the search box, press Enter, and look at what that did.
 *
 * ## Two routes, one loop
 *
 *  - The PAGE route (uiPage.ts) drives web content over the DevTools protocol: a page
 *    opened by address in a hidden browser (a dev server, a built site), or an Electron /
 *    Tauri app started with a debugging port. It can do everything a person can in a
 *    page: real clicks at the control, real keys, hover, going back. It also reports the
 *    page's own errors, and it refuses to "click" a button something else is covering.
 *  - The WINDOW route (uiWin.ts) works on any window through Windows' accessibility
 *    layer, for native apps. It presses, toggles, selects, fills and scrolls, but it
 *    has no keys or hover, because those would need the real keyboard and mouse.
 *
 * Both hand back the same thing, so the model learns one loop: a numbered list of what
 * can be acted on, the text on screen, and a picture. The numbers belong to that list
 * only, and behind each is an id the route can find the control by again, so a control
 * that disappeared in the meantime is reported as gone instead of pressing whatever took
 * its place.
 *
 * ## Never the user's mouse or keyboard
 *
 * Neither route touches them. The window route acts through control patterns; the page
 * route sends input to the page itself. The user can keep working while the agent tests
 * a window behind theirs, or a page with no window at all.
 *
 * ## A control with no name
 *
 * Screen readers, and this tool, know a control by its accessible name. An icon button
 * with none is listed as "no name": still pressable by its number, but it is also an
 * accessibility bug. When the app is the one being built, that is worth saying, because
 * fixing it is one attribute and makes the next pass read clearly.
 *
 * ## Consent
 *
 * A mutating tool: Sentinel asks before each action, plan mode withholds it, an
 * auto-accept session runs it like everything else. The window route photographs the
 * desktop, so like `screenshot` it is refused where there is nobody to ask (a sub-agent).
 * The page route only ever sees the page, so a sub-agent may use it to verify a web app.
 * Password fields are never typed into. Text from a page that is not on this machine is
 * framed as untrusted, like every other web result.
 */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolCallChannel, ToolContext, ToolResult, UiDisplay } from "./types.js";
import { describeImage, isRejection, type ImageRef } from "../memory/images.js";
import { captureWindow, listWindows, type WindowInfo } from "./screenshotWin.js";
import { ambiguousMessage, listTitles, pickWindow, safeName } from "./screenshot.js";
import { actOn, readControls, type UiControl, type UiSnapshot } from "./uiWin.js";
import { isLocalUrl, PageSession, shortUrl, type CastFrame, type PageAction, type PageSnapshot } from "./uiPage.js";
import { listTargets, pageTargets } from "./cdp.js";
import { launchBrowser } from "./browser.js";
import { hideAppWindows, restoreAppWindows, type MovedWindow } from "./uiHide.js";
import { HIDDEN_MARK } from "./hiddenDesktop.js";
import { frameExternal } from "./untrusted.js";
import { guardedPathReason } from "./guard.js";
import { fileURLToPath } from "node:url";

type Action = "look" | "click" | "type" | "key" | "scroll" | "hover" | "back" | "wait" | "resize" | "inspect" | "close";
const ACTIONS: Action[] = ["look", "click", "type", "key", "scroll", "hover", "back", "wait", "resize", "inspect", "close"];
/** What only the page route can do; the window route has no keyboard or pointer, and cannot read a page's styles. */
const PAGE_ONLY: Action[] = ["key", "hover", "back", "wait", "resize", "inspect"];
/** The most steps one call may run: enough for a form or a walk through a view, few enough that a wrong guess is cheap. */
const MAX_STEPS = 25;
/** How long a wait for some text may take, by default and at most. */
const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MS = 30_000;
const DIRECTIONS = ["down", "up", "left", "right"] as const;

/** How long to let the app react before reading it again, unless the call says. */
const DEFAULT_SETTLE_MS = 500;
const MAX_SETTLE_MS = 10_000;

/** A hidden browser nobody has used for this long is closed. */
const IDLE_CLOSE_MS = 10 * 60_000;

/** What a session is working on, and the list its numbers refer to. */
/** What a session is working on, and the list its numbers refer to. `live` names this
 *  test for the front end (its steps and its recording); `texts` is what the screen said
 *  last time, so a step can report what changed. */
type UiState =
  | { route: "window"; handle: string; title: string; controls: UiControl[]; live: string; texts: string[]; hidden?: MovedWindow[] }
  | {
      route: "page";
      page: PageSession;
      title: string;
      url: string;
      controls: UiControl[];
      live: string;
      texts: string[];
      idle?: NodeJS.Timeout;
      castStop?: NodeJS.Timeout;
      /** What the control list and the picture were last time, so an unchanged one is not sent again. */
      listKey?: string;
      sinceList?: number;
      lastShot?: string;
      hidden?: MovedWindow[];
      /** The app runs on the hidden desktop: never on screen, and cannot be brought there. */
      hiddenDesktop?: boolean;
      /** Set when WE close it, so the connection dropping is not read as someone else
       *  closing the app. */
      closing?: boolean;
      /** Set while moving to a tab the app opened: the old connection closes on purpose. */
      switching?: boolean;
    };

/** How long the page keeps streaming after a step, so what the step set moving (a menu
 *  opening, a spinner, a transition) is in the recording too. */
const CAST_TAIL_MS = 1500;

let liveCounter = 0;
/** A name for one test of one app. */
function newLiveId(): string {
  return `live-${Date.now().toString(36)}-${(++liveCounter).toString(36)}`;
}

/** Told once, when an app's window is moved away, so the model does not report the app
 *  as missing and knows how to leave it visible when the user wants that. */
const HIDE_NOTE =
  "You started this app, so its window was moved off the user's screen while you test it; it is still running " +
  "and drawing, and goes back where it was when you close it. If the user asked to see it, call again with show: true.";

/** Told once, for an app started on the hidden desktop (hiddenDesktop.ts). */
const HIDDEN_DESKTOP_NOTE =
  "This app runs on a hidden desktop, so it never appears on the user's screen while you test it. " +
  "It cannot be moved onto their screen: if the user asks to see it, stop it and start the same command again with hidden: false.";

/** Asked to show an app that is on the hidden desktop, which cannot be done in place. */
const CANNOT_SHOW_NOTE =
  "This app runs on a hidden desktop and a window cannot be moved from there onto the user's screen, so it is still " +
  "not visible to them. To show it, stop it and start the same command again with hidden: false (it starts fresh).";

/** What one step was, before its result is known. */
interface StepInfo {
  live: string;
  action: string;
  target?: string;
  input?: string;
  app: string;
  startedAt: number;
  /** Set when the action itself failed: why, in the tool's words. */
  failWhy?: string;
  /** What the screen said before this step. */
  before: string[];
  /** A batch: what each of its steps was and how it went. */
  steps?: UiStepLine[];
}

/** Per session: keyed by the session's tool context, so two sessions never share one. */
const states = new WeakMap<ToolContext, UiState>();

/**
 * Debugging ports an app was reachable on, and when it went away (0 while it is up).
 *
 * What tells "still building" from "was closed": a port that was up and then went away
 * was closed (by the user, or it quit), and waiting for it to come back would wait for
 * something that will not happen. Unless a background command started after it closed,
 * which is the agent restarting it: that one is building again and is waited for.
 */
const portHistory = new Map<number, { closedAt: number; title: string }>();

/** What the model is told when the app it was testing is gone and it did not close it. */
function appClosedMessage(title: string): string {
  return (
    `The app ${title ? `"${title}" ` : ""}was closed while you were testing it, and not by you: most likely the ` +
    `user closed it, or it quit. Tell the user in one short line that it was closed and what you had verified ` +
    `so far, then carry on with the rest of the task. Do not start it again unless the user asks.`
  );
}

/** Chromium stops drawing a window it thinks nobody can see; these keep an app drawing
 *  while it is kept off-screen, so it can still be watched and recorded. */
const KEEP_DRAWING = "--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";

/** How to start an app so the page route can reach it. Said where it is needed. */
const PORT_RECIPES =
  `Electron: add ${"`"}--remote-debugging-port=9222 ${KEEP_DRAWING}${"`"} to its start command (e.g. ${"`"}npx electron . --remote-debugging-port=9222 ${KEEP_DRAWING}${"`"}). ` +
  `Tauri or any WebView2 app on Windows: set the environment variable ` +
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 ${KEEP_DRAWING}" before starting it. ` +
  "Start it in the background, then call ui with port 9222 straight away: it waits while the app is still building.";

/** UIA's control type names, in the words a person would use. */
const KIND_WORDS: Record<string, string> = {
  tabitem: "tab",
  listitem: "item",
  treeitem: "tree item",
  dataitem: "row",
  menuitem: "menu item",
  splitbutton: "button",
  edit: "text box",
  combobox: "dropdown",
  hyperlink: "link",
  checkbox: "checkbox",
  radiobutton: "option",
  headeritem: "column header",
  document: "page",
};

/** One control as the model reads it: `[4] button "Save" (disabled)`. Pure. */
export function controlLine(n: number, c: UiControl): string {
  const kind = KIND_WORDS[c.kind] ?? c.kind;
  const name = c.name ? ` "${c.name}"` : " (no name)";
  const value = c.value && c.value !== c.name ? ` = "${c.value}"` : "";
  const state = c.state.filter((s) => s !== "password");
  const flags = [...state, ...(c.state.includes("password") ? ["password: never typed into"] : [])];
  const only = c.actions.length === 1 && c.actions[0] !== "click" ? ` [${c.actions[0]}]` : "";
  return `[${n}] ${kind}${name}${value}${flags.length ? ` (${flags.join(", ")})` : ""}${only}`;
}

/** Just what the control is, for saying what was done to it: `button "Save"`. Pure. */
export function controlName(c: UiControl): string {
  return `${KIND_WORDS[c.kind] ?? c.kind}${c.name ? ` "${c.name}"` : " (no name)"}`;
}

/** The whole numbered list, grouped by window when a dialog or popup is open. Pure. */
export function controlList(snap: UiSnapshot): string {
  if (snap.controls.length === 0) {
    return (
      "No controls could be read here. Some apps expose nothing to accessibility " +
      "(games, canvas drawing, a few custom frameworks); the picture is all there is to go on."
    );
  }
  const lines: string[] = [];
  let lastWindow = -1;
  const many = snap.windows.length > 1;
  snap.controls.forEach((c, i) => {
    if (many && c.window !== lastWindow) {
      lastWindow = c.window;
      lines.push(`In "${snap.windows[c.window]?.title || "untitled window"}":`);
    }
    lines.push(`${many ? "  " : ""}${controlLine(i + 1, c)}`);
  });
  if (snap.more > 0) lines.push(`… and ${snap.more} more not listed. Scroll, or open the part you need, to reach them.`);
  return lines.join("\n");
}

/**
 * The words on screen that are not controls: a status line, a heading, an error (pure).
 *
 * The picture shows them, but not every model can see a picture, and "did pressing Go
 * work" is usually answered by a line of text rather than a button. Deduplicated, since
 * a control's label is often repeated as its own text element.
 */
export function screenText(snap: UiSnapshot): string {
  const named = new Set(snap.controls.map((c) => c.name));
  const seen = new Set<string>();
  const lines = snap.texts
    .map((t) => t.text)
    .filter((t) => !named.has(t) && !seen.has(t) && seen.add(t));
  return lines.length ? `Text on screen:\n${lines.map((t) => `  ${t}`).join("\n")}` : "";
}

/**
 * What to say about controls with no name (pure). Empty when there are none.
 *
 * Said as a fact with its fix, not as a task: the model decides whether this app is its
 * own to change.
 */
export function unnamedNote(controls: UiControl[]): string {
  const unnamed = controls.filter((c) => !c.name && c.actions.includes("click")).length;
  if (unnamed === 0) return "";
  return (
    `${unnamed} control${unnamed === 1 ? " has" : "s have"} no name, so ${unnamed === 1 ? "it is" : "they are"} ` +
    `known only by number. In an app you are building that is an accessibility bug: give each one a ` +
    `name (aria-label or title on the web, AutomationProperties.Name in XAML, AccessibleName in ` +
    `WinForms, or visible text), and it will read by name on the next look.`
  );
}

/** One checked request. */
export interface UiRequest {
  action: Action;
  window?: string;
  url?: string;
  port?: number;
  target?: number;
  /** A control by its name, instead of its number: resolved against a fresh read. */
  name?: string;
  text: string;
  /** wait: text that must no longer be on the page. */
  gone?: string;
  key?: string;
  direction: (typeof DIRECTIONS)[number];
  /** The most to let the app react before looking again; it returns sooner when the page is still. */
  settleMs: number;
  /** wait: the most to wait for the text. */
  waitMs: number;
  /** resize: the viewport to force (0 by 0 gives it back), and whether it is a phone. */
  width?: number;
  height?: number;
  mobile: boolean;
  /** look: a picture of the whole page, not only what is in view. */
  full: boolean;
  /** look: each listed control's number drawn over it in the picture. */
  annotate: boolean;
  /** Several steps, run in order in this one call. */
  steps?: UiRequest[];
  /** The user asked to see the app: leave its window where it is. */
  show: boolean;
}

/** One line of a batch, for the user's row. */
export interface UiStepLine {
  action: string;
  target?: string;
  input?: string;
  ok: boolean;
  why?: string;
}

/**
 * The control a name means, in the latest list (pure). An exact name wins, then a name that
 * starts with it, then one that contains it; when several are equally good the one in view
 * wins, and when it is still not one control the answer lists them, so the model picks by number.
 */
export function findControl(controls: UiControl[], raw: string): { n: number } | { error: string } {
  const want = raw.trim().toLowerCase();
  if (!want) return { error: "the name is empty." };
  const tiers: ((c: UiControl) => boolean)[] = [
    (c) => c.name.trim().toLowerCase() === want,
    (c) => c.name.trim().toLowerCase().startsWith(want),
    (c) => c.name.trim().toLowerCase().includes(want),
  ];
  for (const test of tiers) {
    let hits = controls.map((c, i) => ({ c, n: i + 1 })).filter((h) => test(h.c));
    if (hits.length > 1) {
      const visible = hits.filter((h) => !h.c.state.includes("out of view"));
      if (visible.length >= 1) hits = visible;
    }
    if (hits.length === 1) return { n: hits[0]!.n };
    if (hits.length > 1) {
      return { error: `more than one control matches "${raw}": ${hits.slice(0, 6).map((h) => controlLine(h.n, h.c)).join("; ")}. Use the number of the one you mean.` };
    }
  }
  return { error: `no control in the latest list is named "${raw}". Look again, or use a number from the list.` };
}

/** Why a file:// address may not be shown (the read_file guard on its path), or null. */
async function fileUrlReason(url: string): Promise<string | null> {
  if (!/^file:/i.test(url)) return null;
  try {
    return await guardedPathReason(fileURLToPath(url));
  } catch {
    return "not a file path that can be checked";
  }
}

/** An address as typed ("localhost:5173") made into one the browser opens. Pure. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(localhost|[\d.]+):\d/i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    return ["http:", "https:", "file:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** Check the arguments and turn them into one request, or say what is wrong. Pure. */
export function parseUiArgs(args: Record<string, unknown>, inStep = false): ({ ok: true } & UiRequest) | { ok: false; error: string } {
  if (Array.isArray(args.steps) && !inStep) {
    if (args.steps.length === 0) return { ok: false, error: "`steps` is empty: list at least one step, or leave it out." };
    if (args.steps.length > MAX_STEPS) return { ok: false, error: `\`steps\` has ${args.steps.length} steps; ${MAX_STEPS} is the most in one call. Split it.` };
    const steps: UiRequest[] = [];
    for (let i = 0; i < args.steps.length; i++) {
      const raw = args.steps[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `step ${i + 1} must be an object like {"action": "click", "name": "Save"}.` };
      const inner = raw as Record<string, unknown>;
      if (inner.url !== undefined || inner.port !== undefined || inner.window !== undefined || inner.steps !== undefined) {
        return { ok: false, error: `step ${i + 1} cannot open a page or nest steps: put \`url\`, \`port\` or \`window\` on the call itself.` };
      }
      if (inner.action === "look" || inner.action === "close") {
        return { ok: false, error: `step ${i + 1}: \`${String(inner.action)}\` is not a step. Every call already ends with a look.` };
      }
      const one = parseUiArgs(inner, true);
      if (!one.ok) return { ok: false, error: `step ${i + 1}: ${one.error}` };
      steps.push(one);
    }
    const head = parseUiArgs({ ...args, action: "look", steps: undefined }, true);
    if (!head.ok) return head;
    return { ...head, steps };
  }
  const action = args.action;
  if (typeof action !== "string" || !ACTIONS.includes(action as Action)) {
    return { ok: false, error: `\`action\` must be one of: ${ACTIONS.join(", ")}.` };
  }
  const window = typeof args.window === "string" && args.window.trim() ? args.window.trim() : undefined;
  let url: string | undefined;
  if (typeof args.url === "string" && args.url.trim()) {
    const u = normalizeUrl(args.url);
    if (!u) return { ok: false, error: "`url` must be a web address (http, https) or a file:// path." };
    url = u;
  }
  let port: number | undefined;
  if (args.port !== undefined && args.port !== null && args.port !== "") {
    const p = typeof args.port === "number" ? args.port : Number(args.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, error: "`port` must be a port number, e.g. 9222." };
    port = p;
  }
  if (url && port !== undefined) return { ok: false, error: "Pass `url` or `port`, not both." };
  if (url && window) return { ok: false, error: "Pass `url` or `window`, not both: `url` opens a page, `window` uses an open window." };
  const rawTarget = args.target;
  const target = typeof rawTarget === "number" ? rawTarget : typeof rawTarget === "string" && /^\d+$/.test(rawTarget.trim()) ? Number(rawTarget) : undefined;
  if (target !== undefined && (!Number.isInteger(target) || target < 1)) {
    return { ok: false, error: "`target` is a control's number from the latest list, starting at 1." };
  }
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
  if ((action === "click" || action === "type" || action === "hover" || action === "inspect") && target === undefined && name === undefined) {
    return { ok: false, error: `\`${action}\` needs \`target\` (the number of a control from the latest look) or \`name\` (its name).` };
  }
  const text = typeof args.text === "string" ? args.text : "";
  if (action === "type" && typeof args.text !== "string") return { ok: false, error: "`type` needs `text`." };
  const key = typeof args.key === "string" && args.key.trim() ? args.key.trim() : undefined;
  if (action === "key" && !key) return { ok: false, error: "`key` needs `key`, e.g. \"Enter\", \"Escape\" or \"Ctrl+A\"." };
  const dir = typeof args.direction === "string" ? args.direction : "down";
  if (!DIRECTIONS.includes(dir as (typeof DIRECTIONS)[number])) {
    return { ok: false, error: `\`direction\` must be one of: ${DIRECTIONS.join(", ")}.` };
  }
  const gone = typeof args.gone === "string" && args.gone.trim() ? args.gone : undefined;
  if (action === "wait" && !(text.trim() || gone)) {
    return { ok: false, error: "`wait` needs `text` (what should appear) or `gone` (what should disappear)." };
  }
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : undefined);
  const width = num(args.width);
  const height = num(args.height);
  if (action === "resize") {
    const reset = args.width === 0 && args.height === 0;
    if (!reset && (width === undefined || height === undefined || width < 200 || height < 200 || width > 4000 || height > 4000)) {
      return { ok: false, error: "`resize` needs `width` and `height` in pixels (200 to 4000), or both 0 to give the window's own size back. Phone: 390 by 844 with `mobile`." };
    }
  }
  const wait = typeof args.wait_ms === "number" && Number.isFinite(args.wait_ms) ? args.wait_ms : action === "wait" ? DEFAULT_WAIT_MS : DEFAULT_SETTLE_MS;
  return {
    ok: true,
    action: action as Action,
    window,
    url,
    port,
    target,
    name,
    text,
    gone,
    key,
    direction: dir as (typeof DIRECTIONS)[number],
    settleMs: Math.max(0, Math.min(MAX_SETTLE_MS, Math.round(wait))),
    waitMs: Math.max(200, Math.min(MAX_WAIT_MS, Math.round(wait))),
    width,
    height,
    mobile: args.mobile === true,
    full: args.full === true,
    annotate: args.annotate === true,
    show: args.show === true,
  };
}

export const ui: Tool = {
  name: "ui",
  deferred: true,
  readOnly: false,
  keywords: ["click", "press", "button", "app", "window", "gui", "interact", "navigate", "type", "desktop", "automation", "browser", "page", "test", "electron", "tauri"],
  description:
    "Use an app the way a person would: see its controls, press buttons, switch views, fill forms, press keys, " +
    "scroll. Use it to check that what you built actually WORKS and that it LOOKS right, not only that it starts: " +
    "open the view, submit the form, and look at what happened. The picture is part of the result: study it every " +
    "time, not only the list. After each change, say what looks wrong in it (misaligned, clipped or overlapping " +
    "things, wrong colours or sizes, a control that looks dead or different from its neighbours) and compare it " +
    "with the design rules or the rest of the app, before you call it done. Start with `look`, which picks the app:\n" +
    "- `url`: a web page or dev server (e.g. http://localhost:5173), opened in a hidden browser. Nothing " +
    "appears on the user's screen.\n" +
    "- `port`: an Electron or Tauri app started with a debugging port. " + PORT_RECIPES + "\n" +
    "- `window`: any open window, by part of its title (Windows only), through its accessibility interface. " +
    "It cannot press keys, hover or go back; prefer `port` for Electron/Tauri apps.\n" +
    "Every call returns a numbered list of the controls, the text on screen, any errors and warnings the page " +
    "reported, and a picture. Then act on a control by its number from the LATEST list, or by its `name`: " +
    "`click`; `type` (replaces the text, or picks an option in a dropdown); `key` (Enter, Tab, Escape, " +
    "ArrowDown, Ctrl+A; into the control or wherever focus is); `hover`; `scroll`; `back`.\n" +
    "Do MANY things in ONE call with `steps`: a list like [{action:\"click\",name:\"Add Game\"},{action:\"type\"," +
    "name:\"Title\",text:\"Halo\"},{action:\"click\",name:\"Save\"}]. They run in order, each control found by name " +
    "again just before its step (so a menu an earlier step opened can be used), it stops at the first step that " +
    "fails, and you get ONE result: the final list and picture. Prefer this to one call per click: every call " +
    "costs you a full round trip.\n" +
    "Also: `wait` (text: until it appears; gone: until it disappears; it returns the moment it does, so use " +
    "it instead of guessing a delay); `resize` (width and height: test a narrow window or a phone, mobile: true " +
    "for touch; 0 and 0 gives it back); `inspect` (a control's size, colours, type, spacing and what is wrong with " +
    "it: too small to press, text cut off, low contrast); `look` with `target` is a close-up of that one control, " +
    "with `full: true` the whole page, not only what is in view, with `annotate: true` the list numbers drawn over the controls.\n" +
    "When you have finished testing, call `close`: the user watches the test live until then. Later calls reuse " +
    "the same app, so leave `url`, `port` and `window` out. Controls marked \"out of view\" can still be " +
    "clicked. Controls marked (covered) have something on top of them at that moment (a dialog, an overlay): a click on one is refused and says what covers it, since a " +
    "person could not click it either. The user's mouse and keyboard are never used, and password fields are " +
    "never typed into. An app you start to test never appears on the user's screen: run_command puts it on a " +
    "hidden desktop, automatically for the debugging-port commands above; for any other app you start to test " +
    "(a native one for `window`), pass `hidden: true` to run_command. Pass `show: true` here only when the " +
    "user asked to see the app.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      action: { type: "string", enum: ACTIONS, description: "What to do. Leave it out when you pass `steps`." },
      steps: {
        type: "array",
        maxItems: MAX_STEPS,
        description:
          "Several steps to run in order in this one call (click, type, key, hover, scroll, back, wait, resize, inspect). " +
          "Each is {action, target or name, text, key, direction, wait_ms, gone, width, height, mobile}. " +
          "Stops at the first one that fails.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { type: "string", enum: ACTIONS.filter((a) => a !== "look" && a !== "close") },
            target: { type: "integer", description: "The control's number from the latest list." },
            name: { type: "string", description: "The control's name, instead of its number. Read fresh before the step." },
            text: { type: "string", description: "type: the text or option. wait: the text to wait for." },
            gone: { type: "string", description: "wait: text that must disappear." },
            key: { type: "string" },
            direction: { type: "string", enum: [...DIRECTIONS] },
            wait_ms: { type: "integer" },
            width: { type: "integer" },
            height: { type: "integer" },
            mobile: { type: "boolean" },
          },
        },
      },
      name: { type: "string", description: "The control's name (or part of it), instead of `target`. Read fresh first, so it also finds what an earlier step opened." },
      gone: { type: "string", description: "wait: text that must no longer be on the page." },
      width: { type: "integer", description: "resize: viewport width in pixels (200 to 4000); 0 with height 0 gives the window's own size back." },
      height: { type: "integer", description: "resize: viewport height in pixels." },
      mobile: { type: "boolean", description: "resize: phone-style (touch, mobile layout)." },
      full: { type: "boolean", description: "look: a picture of the whole page, not only what is in view." },
      annotate: { type: "boolean", description: "look: draw each control's list number over it in the picture, so what you see and the list line up. Costs nothing extra; leave it off when judging how the page really looks." },
      url: { type: "string", description: "look: open this page (a dev server, a site, a file://)." },
      port: { type: "integer", description: "look: attach to the app behind this local debugging port." },
      window: {
        type: "string",
        description:
          "look: part of a window's title (window route); with `port`, part of the page title to pick among several. " +
          "An app with a custom title bar is listed by its process name.",
      },
      target: { type: "integer", description: "The control's number from the latest list." },
      text: { type: "string", description: "For type: the text to put in (or the option to pick). For wait: the text to wait for." },
      key: { type: "string", description: "For key: e.g. \"Enter\", \"Escape\", \"Tab\", \"Ctrl+A\"." },
      direction: { type: "string", enum: [...DIRECTIONS], description: "For scroll. Default down." },
      wait_ms: {
        type: "integer",
        description: `The most to let the app react before looking again (default ${DEFAULT_SETTLE_MS}); it goes on sooner once the page has stopped changing. For wait: how long to wait for the text (default ${DEFAULT_WAIT_MS / 1000}s, at most ${MAX_WAIT_MS / 1000}s).`,
      },
      show: {
        type: "boolean",
        description:
          "Leave the app's window on the user's screen. Only when the user asked to see or use the app themselves; " +
          "for testing and debugging leave it out. An app on the hidden desktop cannot be shown this way; the call says so.",
      },
    },
  },

  async execute(args, ctx, call): Promise<ToolResult> {
    const req = parseUiArgs(args);
    if (!req.ok) return { output: `Error: ${req.error}`, isError: true, summary: "invalid ui call", quiet: true };
    // A file:// address is a file read, and gets the same guard read_file does. Opened in
    // the browser, .env came back as page text that read_file had just refused.
    if (req.url) {
      const blocked = await fileUrlReason(req.url);
      if (blocked) return fail(`Refusing to open ${req.url}: it is ${blocked}.`);
    }
    const state = states.get(ctx);

    if (req.action === "close") {
      if (!state) return { output: "Nothing was open.", summary: "nothing open" };
      states.delete(ctx);
      if (state.route === "page") {
        if (state.idle) clearTimeout(state.idle);
        state.closing = true;
        if (state.page.closed) {
          // Already gone before we got here: the user (or the app) closed it.
          return { output: appClosedMessage(state.title), summary: `${state.title || "the app"} was already closed` };
        }
        await state.page.close();
      }
      await restoreAppWindows(state.hidden ?? []);
      return { output: `Closed ${state.title || "it"}.`, summary: `closed ${state.title || "the app"}` };
    }

    const pageRoute = req.url !== undefined || req.port !== undefined || (!req.window && state?.route === "page");
    const startedAt = Date.now();
    try {
      return pageRoute ? await runPage(req, ctx, state, startedAt, call) : await runWindow(req, ctx, state, startedAt, call);
    } catch (error) {
      if (ctx.abortSignal?.aborted) return fail("Stopped.");
      return fail(message(error));
    }
  },
};

// ── the window route ─────────────────────────────────────────────────────────

async function runWindow(req: UiRequest, ctx: ToolContext, prior: UiState | undefined, startedAt: number, call?: ToolCallChannel): Promise<ToolResult> {
  if (process.platform !== "win32") {
    return {
      output:
        `Using windows by title is Windows-only, and this is ${process.platform}. For a web page or dev server ` +
        `pass \`url\`; for an Electron or Tauri app pass \`port\`. ${PORT_RECIPES}`,
      summary: "window route unsupported here",
    };
  }
  const pageOnly = PAGE_ONLY.includes(req.action) ? req.action : req.steps?.find((x) => PAGE_ONLY.includes(x.action))?.action;
  if (pageOnly) {
    return fail(
      `\`${pageOnly}\` needs the page route: the window route works through accessibility and has no keyboard ` +
        `or pointer to use. For a web page pass \`url\`; for an Electron or Tauri app pass \`port\`. ${PORT_RECIPES}`,
    );
  }
  // Same rule as a screenshot: every call ends in a picture of the user's desktop, so a
  // context with nobody to ask (a sub-agent) does not get to take one.
  if (!ctx.requestApproval) {
    return {
      output:
        "Cannot use desktop windows from here: it photographs the user's screen and there is nobody to ask in " +
        "this context. A web page can still be tested with `url`; otherwise report what should be checked.",
      summary: "cannot use windows here",
    };
  }
  // Moving from a page to a window: the page and its browser are finished with.
  if (prior?.route === "page") {
    states.delete(ctx);
    if (prior.idle) clearTimeout(prior.idle);
    await prior.page.close();
    await restoreAppWindows(prior.hidden ?? []);
  }
  let state = prior?.route === "window" ? prior : undefined;

  // ── which window ──
  let target: { handle: string; title: string };
  let windows: WindowInfo[];
  try {
    windows = await listWindows(ctx.abortSignal);
  } catch (error) {
    return fail(`Could not list open windows: ${message(error)}`);
  }
  if (req.window) {
    const pick = pickWindow(req.window, windows);
    if (pick.kind === "none") {
      return fail(
        `No open window's title contains "${req.window}". ${listTitles(pick.candidates)}\n` +
          `If you just launched the app, give it a moment and call again. An app with a custom title bar ` +
          `is listed by its process name.`,
      );
    }
    if (pick.kind === "ambiguous") return fail(ambiguousMessage(req.window, pick.candidates));
    target = { handle: pick.window.handle, title: pick.window.title };
    // A different window: the old numbers mean nothing here.
    if (state && state.handle !== target.handle) state = undefined;
  } else if (state) {
    const still = windows.find((w) => w.handle === state!.handle);
    target = { handle: state.handle, title: still?.title ?? state.title };
  } else {
    return fail(
      `Name what to use: \`window\` for an open window, \`url\` for a web page, or \`port\` for an Electron/Tauri app. ${listTitles(windows)}`,
    );
  }

  // ── act, or just read ──
  let snap!: UiSnapshot;
  let did = "";
  let targetLabel: string | undefined;
  let failWhy: string | undefined;
  const batch = req.steps !== undefined;
  // A batch starts with a read, so its steps have a list to find controls in.
  const queue: UiRequest[] = req.steps ? [{ ...req, action: "look", steps: undefined }, ...req.steps] : [req];
  const log: { line: string; step: UiStepLine }[] = [];
  let controlsNow = state?.controls ?? [];
  try {
    for (let i = 0; i < queue.length; i++) {
      const r = queue[i]!;
      if (r.action === "look") {
        snap = await readControls(target.handle, ctx.abortSignal);
        controlsNow = snap.controls;
        continue;
      }
      if (!state && !batch) {
        return fail(`Look at the window first: call ui with action "look" and window "${target.title}".`);
      }
      let n = r.target;
      if (r.name !== undefined) {
        const found = findControl(controlsNow, r.name);
        if ("error" in found) {
          failWhy = found.error;
          did = `Could not ${r.action} "${r.name}": ${found.error}`;
        } else n = found.n;
      }
      let line: string;
      let ok = true;
      let label: string | undefined;
      if (failWhy) {
        line = did;
        ok = false;
      } else {
        // A scroll with no target scrolls the first thing that can.
        const num = n ?? controlsNow.findIndex((c) => c.actions.includes("scroll")) + 1;
        if (num === 0) return fail("Nothing in the latest list scrolls. Pass `target` with a control inside the area to scroll.");
        const control = controlsNow[num - 1];
        if (!control) {
          return fail(`There is no control [${num}] in the latest list (it has ${controlsNow.length}). Look again if the window changed.`);
        }
        if (r.action === "type" && control.state.includes("password")) {
          return fail(`[${num}] is a password field. Never type into one: ask the user to enter it themselves.`);
        }
        const verb = r.action === "scroll" ? (`scroll-${r.direction}` as const) : (r.action as "click" | "type");
        snap = await actOn(target.handle, control.id, verb, r.text, r.settleMs, ctx.abortSignal);
        controlsNow = snap.controls;
        label = `[${num}] ${controlName(control)}`;
        targetLabel = controlName(control);
        if (snap.acted && !snap.acted.ok) {
          const why = snap.acted.text === "GONE" ? "it is gone: the window changed since the last look" : snap.acted.text;
          failWhy = why;
          ok = false;
          line = `Could not ${r.action} ${label}: ${why}.`;
        } else {
          line = describeAction(r.action, label, r.text, r.direction, snap.acted?.text);
        }
      }
      if (batch) {
        log.push({
          line: `${log.length + 1}. ${line}`,
          step: { action: r.action, ...(label ? { target: label.replace(/^\[\d+\] /, "") } : {}), ...(stepInput(r) ? { input: stepInput(r) } : {}), ok, ...(!ok && failWhy ? { why: failWhy } : {}) },
        });
        call?.progress(log.map((l) => l.line).join("\n"));
      } else did = line;
      if (!ok) {
        if (batch) log.push({ line: `Stopped at step ${log.length}; ${queue.length - i - 1} later step${queue.length - i - 1 === 1 ? " was" : "s were"} not run.`, step: { action: "stop", ok: false } });
        break;
      }
      if (snap.error) break;
    }
    if (batch) {
      const ran = log.filter((l) => l.step.action !== "stop" && l.step.ok).length;
      did = `Ran ${ran} of ${req.steps!.length} steps:\n${log.map((l) => l.line).join("\n")}`;
      if (failWhy) did = `Could not finish: ${did}`;
    }
  } catch (error) {
    if (ctx.abortSignal?.aborted) return fail("Stopped.");
    return fail(`Could not read "${target.title}": ${message(error)}`);
  }
  if (snap.error) {
    states.delete(ctx);
    // Pressing Close, OK or Cancel is SUPPOSED to make the window go away: that is the
    // action working, not failing.
    if (did && !did.startsWith("Could not")) {
      return { output: `${did} The window "${target.title}" closed.`, summary: `${stripNumbers(did)}; the window closed` };
    }
    return fail(`${did ? `${did} ` : ""}${appClosedMessage(target.title)}`);
  }
  const live = state?.live ?? newLiveId();
  const before = state?.texts ?? [];
  let hidden = state?.hidden;
  let hideNote = "";
  if (req.show && target.handle.startsWith(HIDDEN_MARK)) {
    hideNote = CANNOT_SHOW_NOTE;
  } else if (req.show && hidden?.length) {
    await restoreAppWindows(hidden);
    hidden = undefined;
  } else if (!req.show && !state) {
    const found = await hideAppWindows({ handle: target.handle });
    hidden = found.moved;
    hideNote = found.moved.length ? HIDE_NOTE : found.hiddenDesktop ? HIDDEN_DESKTOP_NOTE : "";
  }
  states.set(ctx, { route: "window", handle: target.handle, title: target.title, controls: snap.controls, live, texts: snap.texts.map((x) => x.text), hidden });

  // ── the picture: the window on top, which is an open dialog when there is one ──
  const shotOf = snap.top ?? { handle: target.handle, title: target.title };
  const shot = await picture(shotOf.title || target.title, (path) => captureWindow(shotOf.handle, path, ctx.abortSignal));
  // A window cannot be streamed the way a page can, so its live view is this picture:
  // one frame per step.
  if (ctx.onLive && shot.image) {
    try {
      const data = (await readFile(shot.image.path)).toString("base64");
      const [w, h] = shot.size.split("x").map(Number);
      ctx.onLive({ kind: "frame", live, ts: Date.now(), data, mime: "image/png", width: w ?? 0, height: h ?? 0 });
    } catch {
      // Not shown live; the step's own picture is still in its result.
    }
  }
  const dialog = snap.top && snap.top.handle !== target.handle ? ` A window "${snap.top.title}" is open on top of it.` : "";
  return render({
    did,
    heading: `"${target.title}": ${countControls(snap)}.${dialog} Numbers below refer to this list only.`,
    title: target.title,
    snap,
    shot,
    extra: hideNote,
    step: {
      live,
      action: batch ? "steps" : req.action,
      target: batch ? `${req.steps!.length} steps` : targetLabel,
      input: batch ? undefined : stepInput(req),
      app: target.title,
      startedAt,
      failWhy,
      before,
      ...(batch ? { steps: log.map((l) => l.step).filter((x) => x.action !== "stop") } : {}),
    },
  });
}

// ── the page route ──────────────────────────────────────────────────────────

async function runPage(req: UiRequest, ctx: ToolContext, prior: UiState | undefined, startedAt: number, call?: ToolCallChannel): Promise<ToolResult> {
  let state = prior?.route === "page" && !prior.page.closed ? prior : undefined;
  if (prior?.route === "page" && prior.page.closed) {
    states.delete(ctx);
    // The app went away between calls and this call does not open another: the model
    // is acting on an app that is not there. Say so plainly instead of "nothing is open".
    if (req.url === undefined && req.port === undefined && !prior.closing) return fail(appClosedMessage(prior.title));
  }
  let othersNote = "";
  let did = "";

  // ── connect: a debugging port, or a hidden browser for an address ──
  if (req.port !== undefined && (!state || state.page.port !== req.port || req.window)) {
    const waited = await waitForApp(req.port, ctx, call);
    if (waited) return fail(`${waited} ${PORT_RECIPES}`);
    try {
      const { session, others } = await PageSession.attach(req.port, req.window);
      if (state) await closeState(ctx, state);
      state = { route: "page", page: session, title: session.target.title, url: session.target.url, controls: [], live: newLiveId(), texts: [] };
      watchForClose(ctx, state, req.port);
      const found = await hideAppWindows({ port: req.port }, !req.show);
      state.hidden = found.moved;
      state.hiddenDesktop = found.hiddenDesktop;
      othersNote = found.moved.length ? HIDE_NOTE : found.hiddenDesktop ? (req.show ? CANNOT_SHOW_NOTE : HIDDEN_DESKTOP_NOTE) : "";
      if (others.length) {
        othersNote =
          (othersNote ? `${othersNote}\n\n` : "") +
          `Other pages behind port ${req.port}: ${others.map((t) => `"${t.title || shortUrl(t.url)}"`).join(", ")}. ` +
          `Pass \`window\` with part of a title, together with \`port\`, to use one of them.`;
      }
    } catch (error) {
      return fail(`Could not reach an app on port ${req.port}: ${message(error)}. ${PORT_RECIPES}`);
    }
  }
  if (req.url !== undefined) {
    try {
      if (!state) {
        const browser = await launchBrowser();
        try {
          const { session } = await PageSession.attach(browser.port, undefined, browser);
          state = { route: "page", page: session, title: "", url: "about:blank", controls: [], live: newLiveId(), texts: [] };
        } catch (error) {
          await browser.close();
          throw error;
        }
      }
      await state.page.navigate(req.url);
      state.controls = []; // a new page: the old numbers mean nothing here
      state.listKey = undefined;
      state.lastShot = undefined;
      did = `Opened ${req.url}.`;
    } catch (error) {
      if (state) states.set(ctx, state);
      return fail(`Could not open ${req.url}: ${message(error)}`);
    }
  }
  if (!state) {
    return fail(
      "Nothing is open yet. Pass `url` to open a web page or dev server, or `port` to use an Electron/Tauri app. " + PORT_RECIPES,
    );
  }
  // Asked to show it: put it back on screen if it was moved. One on the hidden desktop
  // cannot be, and the model is told so rather than left believing it is visible.
  if (req.show && state.hidden?.length) {
    await restoreAppWindows(state.hidden);
    state.hidden = undefined;
  } else if (req.show && state.hiddenDesktop && !othersNote.includes(CANNOT_SHOW_NOTE)) {
    othersNote = othersNote ? `${othersNote}\n\n${CANNOT_SHOW_NOTE}` : CANNOT_SHOW_NOTE;
  }
  states.set(ctx, state);
  keepAlive(ctx, state);
  const page = () => (state as Extract<UiState, { route: "page" }>).page;
  const live = state.live;
  // Stream the page while this step happens, for a front end that shows it live.
  const onLive = ctx.onLive;
  const stream = onLive
    ? (frame: CastFrame) => onLive({ kind: "frame", live, ts: frame.ts, data: frame.data, mime: "image/jpeg", width: frame.width, height: frame.height })
    : null;
  if (state.castStop) clearTimeout(state.castStop);
  if (stream) await page().startCast(stream);
  const cur = state;
  let targetLabel: string | undefined;
  let failWhy: string | undefined;
  /** Text a step produced for the model to read (an inspection), in order. */
  const notes: string[] = [];
  /** What the page reported during steps that were read along the way. */
  const acc = { errors: [] as string[], warnings: [] as string[], dialogs: [] as string[] };
  const absorb = (s: PageSnapshot): void => {
    acc.errors.push(...(s.errors ?? []));
    acc.warnings.push(...(s.warnings ?? []));
    acc.dialogs.push(...(s.dialogs ?? []));
  };

  // ── act ──
  const verbWord: Record<string, string> = { click: "click", type: "type into", hover: "hover over", key: "press a key in", scroll: "scroll", inspect: "inspect" };

  /** One step on the page: what was done in words, and whether it failed. */
  const runStep = async (r: UiRequest): Promise<{ did: string; failed: boolean; why?: string; label?: string }> => {
    if (r.action === "look") return { did: "", failed: false };
    if (r.action === "back") {
      const res = await page().back(r.settleMs);
      if (!res.startsWith("OK")) {
        const why = res.replace(/^ERR\s*/, "");
        return { did: `Could not go back: ${why}.`, failed: true, why };
      }
      return { did: "Went back.", failed: false };
    }
    if (r.action === "wait") {
      const res = await page().waitFor({ text: r.text || undefined, gone: r.gone, ms: r.waitMs });
      if (!res.startsWith("OK")) {
        const why = res.replace(/^ERR\s*/, "");
        return { did: `Could not wait: ${why}.`, failed: true, why };
      }
      return { did: `Waited: ${res.replace(/^OK\s*/, "")}.`, failed: false };
    }
    if (r.action === "resize") {
      const res = await page().resize(r.width ?? 0, r.height ?? 0, r.mobile);
      return { did: `${res.replace(/^OK\s*/, "").replace(/^./, (c) => c.toUpperCase())}.`, failed: false };
    }
    // A control by its name: read the page again first, since an earlier step of this same
    // call may have opened the menu or the view it is in.
    let n = r.target;
    if (r.name !== undefined) {
      const fresh = await page().read();
      absorb(fresh);
      cur.controls = fresh.controls;
      const found = findControl(cur.controls, r.name);
      if ("error" in found) return { did: `Could not ${verbWord[r.action] ?? r.action} "${r.name}": ${found.error}`, failed: true, why: found.error };
      n = found.n;
    }
    if (n !== undefined && cur.controls.length === 0) {
      const why = "Look at the page first: the numbers come from the latest look.";
      return { did: why, failed: true, why };
    }
    const control = n !== undefined ? cur.controls[n - 1] : undefined;
    if (n !== undefined && !control) {
      const why = `There is no control [${n}] in the latest list (it has ${cur.controls.length}). Look again if the page changed.`;
      return { did: why, failed: true, why };
    }
    if (r.action === "type" && control?.state.includes("password")) {
      const why = `[${n}] is a password field. Never type into one: ask the user to enter it themselves.`;
      return { did: why, failed: true, why };
    }
    const label = control ? `[${n}] ${controlName(control)}` : "";
    targetLabel = control ? controlName(control) : undefined;
    if (r.action === "inspect") {
      const res = await page().inspect(control!.id);
      if (res.startsWith("ERR")) {
        const raw = res.replace(/^ERR\s*/, "");
        const why = raw === "GONE" ? "it is gone: the page changed since the last look" : raw;
        return { did: `Could not inspect ${label}: ${why}.`, failed: true, why, label };
      }
      notes.push(`Inspection of ${label}:\n${res.replace(/^OK\s*/, "").split("\n").map((l) => `  ${l}`).join("\n")}`);
      return { did: `Inspected ${label}.`, failed: false, label };
    }
    const tabsBefore = r.action === "click" || r.action === "key" ? await page().pageIds() : null;
    const res =
      r.action === "key"
        ? await page().pressKey(r.key!, control?.id ?? null, r.settleMs)
        : await page().act(
            control?.id ?? "",
            r.action === "scroll" ? (`scroll-${r.direction}` as PageAction) : (r.action as PageAction),
            r.text,
            r.settleMs,
          );
    let did: string;
    let failed = false;
    let why: string | undefined;
    if (res.startsWith("ERR")) {
      const raw = res.replace(/^ERR\s*/, "");
      why = raw === "GONE" ? "it is gone: the page changed since the last look" : raw;
      failed = true;
      did = `Could not ${verbWord[r.action]} ${label || "the page"}: ${why}.`;
    } else {
      did = describeAction(r.action, label, r.text, r.direction, res.replace(/^OK\s*/, ""), r.key);
    }
    // A link that opened a new tab: carry on in the tab, as a person would.
    if (tabsBefore && !page().closed) {
      const fresh = await page().newPages(tabsBefore);
      if (fresh.length) {
        cur.switching = true;
        let next: PageSession;
        try {
          next = await page().switchTo(fresh[fresh.length - 1]!);
        } finally {
          cur.switching = false;
        }
        cur.page = next;
        watchForClose(ctx, cur, next.port);
        if (stream) await next.startCast(stream);
        did += ` It opened a new page (${shortUrl(next.target.url)}), which is now the one in use.`;
      }
    }
    return { did, failed, why, label };
  };

  const batch = req.steps !== undefined;
  const queue = req.steps ?? [req];
  const log: { line: string; step: UiStepLine }[] = [];
  did = "";
  if (batch && cur.controls.length === 0 && queue.some((s) => s.target !== undefined)) {
    return fail("Look at the page first: the numbers come from the latest look. Or name the control with `name`.");
  }
  for (let i = 0; i < queue.length; i++) {
    const r = queue[i]!;
    const res = await runStep(r);
    if (batch) {
      log.push({
        line: `${i + 1}. ${res.did || "Looked."}`,
        step: { action: r.action, ...(res.label ? { target: res.label.replace(/^\[\d+\] /, "") } : r.name ? { target: `"${r.name}"` } : {}), ...(stepInput(r) ? { input: stepInput(r) } : {}), ok: !res.failed, ...(res.failed && res.why ? { why: res.why } : {}) },
      });
      // What has been done so far, so a long run shows itself one step after another.
      call?.progress(log.map((l) => l.line).join("\n"));
    } else {
      did = res.failed && !res.did.startsWith("Could not") ? `Could not do that: ${res.did}` : res.did;
    }
    if (res.failed) {
      failWhy = res.why;
      if (batch) log.push({ line: `Stopped at step ${i + 1}; ${queue.length - i - 1} later step${queue.length - i - 1 === 1 ? " was" : "s were"} not run.`, step: { action: "stop", ok: false } });
      break;
    }
    if (page().closed) break;
  }
  if (batch) {
    const ran = log.filter((l) => l.step.action !== "stop" && l.step.ok).length;
    did = `Ran ${ran} of ${queue.length} steps:\n${log.map((l) => l.line).join("\n")}`;
    if (failWhy) did = `Could not finish: ${did}`;
  }
  if (page().closed) {
    states.delete(ctx);
    if (did && !did.startsWith("Could not")) return { output: `${did} The page closed.`, summary: `${stripNumbers(did).split("\n")[0]}; the page closed` };
    return fail(`${did ? `${did} ` : ""}The page is gone: the app may have quit.`);
  }

  // ── read it again, and take a picture ──
  const snap = await page().read();
  // Whatever the page ended up on, not only what was asked for: a link or a redirect can
  // take a file:// page to another file. A protected one is never described or pictured.
  const fileBlocked = await fileUrlReason(snap.page?.url ?? "");
  if (fileBlocked) {
    await page().navigate("about:blank").catch(() => {});
    return fail(`Refusing to show ${snap.page?.url}: it is ${fileBlocked}.`);
  }
  if (acc.errors.length || acc.warnings.length || acc.dialogs.length) {
    snap.errors = [...acc.errors, ...(snap.errors ?? [])].slice(0, 12);
    snap.warnings = [...acc.warnings, ...(snap.warnings ?? [])].filter((w, i, all) => all.indexOf(w) === i).slice(0, 6);
    snap.dialogs = [...acc.dialogs, ...(snap.dialogs ?? [])];
  }
  // A look at one control (by the list the model read), before the list is replaced.
  const lookNum = req.name !== undefined ? (() => { const f = findControl(snap.controls, req.name!); return "n" in f ? f.n : undefined; })() : req.target;
  const lookAt = req.action === "look" && !batch && lookNum !== undefined ? (req.name !== undefined ? snap.controls : cur.controls)[lookNum - 1] : undefined;
  const before = cur.texts;
  cur.texts = snap.texts.map((x) => x.text);
  cur.controls = snap.controls;
  cur.title = snap.page?.title || shortUrl(snap.page?.url ?? "");
  cur.url = snap.page?.url ?? cur.url;
  const annotate = req.annotate ? snap.controls.slice(0, 120).map((c, i) => ({ n: i + 1, id: c.id })) : undefined;
  let shot: { image?: ImageRef; size: string; same?: boolean } = await picture(cur.title || "page", (path) => page().screenshot(path, { controlId: lookAt?.id, full: req.full, annotate }));
  // The same list and the same picture as a moment ago are not worth sending twice: a typed
  // letter or a hover that changed nothing costs a line, not the whole screen again.
  const listKey = snap.controls.map((c) => `${c.kind}|${c.name}|${c.value}|${c.state.join(",")}`).join("\n");
  const plainLook = req.action === "look" && !batch;
  // A list is sent whole at least every few results: an old result may have been trimmed from the model's context.
  const listSame = !plainLook && !failWhy && cur.listKey === listKey && snap.controls.length > 0 && (cur.sinceList ?? 0) < 3;
  cur.sinceList = listSame ? (cur.sinceList ?? 0) + 1 : 0;
  const fingerprint = page().lastShot;
  if (!plainLook && !failWhy && !req.full && !req.annotate && cur.lastShot && cur.lastShot === fingerprint && shot.image) shot = { size: shot.size, same: true };
  cur.listKey = listKey;
  cur.lastShot = fingerprint;
  const info = snap.page;
  const where = info && info.scrollMax > 0
    ? ` Scrolled ${info.scrollY} of ${info.scrollMax}px${info.scrollY < info.scrollMax - 2 ? "; there is more below" : ""}.`
    : "";
  const size = snap.emulated ? ` The viewport is set to ${snap.emulated.width}x${snap.emulated.height}${snap.emulated.mobile ? " (phone-style)" : ""}; resize to 0x0 to give it back.` : "";
  const out = render({
    did,
    heading: `Page "${cur.title}" (${shortUrl(cur.url)}): ${countControls(snap)}.${where}${size} Numbers below refer to this list only.`,
    title: cur.title,
    snap,
    shot,
    listSame,
    external: isLocalUrl(cur.url) ? undefined : cur.url,
    extra: [othersNote, ...notes].filter(Boolean).join("\n\n"),
    step: {
      live,
      action: batch ? "steps" : req.action,
      target: batch ? `${queue.length} steps` : targetLabel,
      input: batch ? undefined : stepInput(req),
      app: `${cur.title || "page"} · ${shortUrl(cur.url)}`,
      startedAt,
      failWhy,
      before,
      ...(batch ? { steps: log.map((l) => l.step).filter((s) => s.action !== "stop") } : {}),
    },
  });
  // Keep streaming a moment longer so what the step set moving is caught, then stop:
  // the live view runs while the agent is acting, not while it is thinking.
  const settled = cur;
  settled.castStop = setTimeout(() => void settled.page.stopCast(), CAST_TAIL_MS);
  settled.castStop.unref?.();
  return out;
}

/** How long to wait for an app that is still starting (a first build can take minutes). */
const PORT_WAIT_MS = 180_000;

/**
 * Wait for an app the agent is starting to open its debugging port.
 *
 * The background command that launches an app announces itself as ready when its dev
 * server comes up, which for a compiled app (Tauri) is well before the app has finished
 * building and opened the window that owns the port. Failing at that moment left the
 * model saying "I'll wait for it to come up" and ending its turn, waiting for a wake-up
 * that had already been spent. So while a background command is still running, this
 * waits here instead, saying how long, and gives up only if the command stops or time
 * runs out. With nothing running there is nothing to wait for, and it answers at once.
 *
 * Returns why it gave up, or null when there is a page to attach to.
 */
async function waitForApp(port: number, ctx: ToolContext, call?: ToolCallChannel): Promise<string | null> {
  const started = Date.now();
  let lastWhy = "";
  for (;;) {
    try {
      if (pageTargets(await listTargets(port)).length) return null;
      lastWhy = `port ${port} is open but has no page yet`;
    } catch (error) {
      lastWhy = message(error);
    }
    // It was up before and went away: closed, not building. Unless something was started
    // since, which is the agent restarting it, and that is worth waiting for.
    const was = portHistory.get(port);
    if (was && was.closedAt > 0) {
      const restarted = (ctx.backgroundShells?.running() ?? []).some((sh) => sh.startedAt > was.closedAt);
      if (!restarted) return appClosedMessage(was.title);
    }
    const building = (ctx.backgroundShells?.runningCount() ?? 0) > 0;
    if (!building) {
      return (
        `Could not reach an app on port ${port}: ${lastWhy}, and no background command is running that could be starting it.`
      );
    }
    const waited = Date.now() - started;
    if (waited >= PORT_WAIT_MS) {
      return (
        `Could not reach an app on port ${port} after waiting ${Math.round(waited / 1000)}s: ${lastWhy}. ` +
        `Check the background command's output with shells: the build may have failed, or the port may be different.`
      );
    }
    if (ctx.abortSignal?.aborted) return "Stopped.";
    call?.progress(`Waiting for the app on port ${port} to come up (it may still be building)… ${Math.round(waited / 1000)}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Notice the app going away on its own (the user closed it, or it quit): the live view
 * is told at once, and the port is remembered as closed so nothing waits for it.
 */
function watchForClose(ctx: ToolContext, state: Extract<UiState, { route: "page" }>, port: number): void {
  portHistory.set(port, { closedAt: 0, title: state.title });
  const onLive = ctx.onLive;
  const conn = state.page.conn;
  conn.onClose(() => {
    // Switching to a tab the app opened closes the old connection on purpose.
    if (state.switching || state.page.conn !== conn) return;
    if (state.closing) {
      portHistory.delete(port); // we closed it; restarting it later is ordinary
      return;
    }
    portHistory.set(port, { closedAt: Date.now(), title: state.title });
    if (state.castStop) clearTimeout(state.castStop);
    onLive?.({ kind: "closed", live: state.live });
  });
}

/**
 * After a compaction: what the model should know is still open, or null.
 *
 * The summary may not say an app is open, and the control list the numbers point into
 * is gone from the model's context while this tool still holds it, so a `click 7` after
 * a compaction would press whatever 7 was an hour ago. The numbers are reset here, so
 * the next action is refused until the model looks again, and it is told so.
 */
export function uiLiveState(ctx: ToolContext): string | null {
  const state = states.get(ctx);
  if (!state) return null;
  if (state.route === "page" && state.page.closed) return null;
  state.controls = [];
  if (state.route === "page") {
    state.listKey = undefined; // the model no longer has the list, so it is sent whole again
    state.lastShot = undefined;
  }
  const where =
    state.route === "page"
      ? `${state.title ? `"${state.title}" ` : ""}(${shortUrl(state.url)})`
      : `the window "${state.title}"`;
  return (
    `The ui tool still has ${where} open, as you left it. Its control numbers from before the compaction ` +
    `are gone: call ui with action "look" before acting on it.`
  );
}

/**
 * Stop everything this session's `ui` has going (Esc): the page and any hidden browser,
 * with the app's window put back where it was. Never throws.
 */
export async function stopUi(ctx: ToolContext): Promise<void> {
  const state = states.get(ctx);
  if (!state) return;
  states.delete(ctx);
  try {
    if (state.route === "page") {
      if (state.idle) clearTimeout(state.idle);
      if (state.castStop) clearTimeout(state.castStop);
      state.closing = true;
      await state.page.close();
    }
    await restoreAppWindows(state.hidden ?? []);
  } catch {
    // Stopping must not fail; whatever is left is closed by the app going away.
  }
}

/** Close a page session and forget it. */
async function closeState(ctx: ToolContext, state: Extract<UiState, { route: "page" }>): Promise<void> {
  state.closing = true;
  if (state.idle) clearTimeout(state.idle);
  if (states.get(ctx) === state) states.delete(ctx);
  await state.page.close();
  await restoreAppWindows(state.hidden ?? []);
}

/** A hidden browser left alone for a while is closed, so a session that moved on does not
 *  leave one running until Mindweave exits. */
function keepAlive(ctx: ToolContext, state: Extract<UiState, { route: "page" }>): void {
  if (state.idle) clearTimeout(state.idle);
  state.idle = setTimeout(() => void closeState(ctx, state), IDLE_CLOSE_MS);
  state.idle.unref?.();
}

// ── shared ───────────────────────────────────────────────────────────────────

/** Take a picture into a temp file and check it the way every image is checked. */
async function picture(
  title: string,
  capture: (path: string) => Promise<{ width: number; height: number }>,
): Promise<{ image?: ImageRef; size: string }> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "mindweave-shot-"));
    const path = join(dir, `${safeName(title)}.png`);
    const s = await capture(path);
    const ref = await describeImage(path, (await stat(path)).size);
    if (!isRejection(ref)) return { image: ref, size: `${s.width}x${s.height}` };
  } catch {
    // The list still says what is there; a missing picture is not a failed action.
  }
  return { size: "" };
}

function countControls(snap: UiSnapshot): string {
  return `${snap.controls.length} control${snap.controls.length === 1 ? "" : "s"}`;
}

/** What the page reported by itself: its errors and any dialogs. Pure. */
export function pageReports(snap: PageSnapshot): string {
  const parts: string[] = [];
  if (snap.errors?.length) {
    parts.push(
      `The page reported ${snap.errors.length} error${snap.errors.length === 1 ? "" : "s"} since the last step:\n` +
        snap.errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  if (snap.warnings?.length) {
    parts.push(`The page logged ${snap.warnings.length} warning${snap.warnings.length === 1 ? "" : "s"}:\n` + snap.warnings.map((w) => `  - ${w}`).join("\n"));
  }
  if (snap.dialogs?.length) parts.push(snap.dialogs.map((d) => `A ${d}.`).join("\n"));
  return parts.join("\n\n");
}

/** The one result shape both routes give back. */
function render(o: {
  did: string;
  heading: string;
  title: string;
  snap: UiSnapshot | PageSnapshot;
  shot: { image?: ImageRef; size: string; same?: boolean };
  /** The control list is exactly the one from the last step: say so instead of repeating it. */
  listSame?: boolean;
  /** The page's address when it is not on this machine: its words are framed as data. */
  external?: string;
  extra?: string;
  step: StepInfo;
}): ToolResult {
  const failed = o.did.startsWith("Could not");
  const fullList = controlList(o.snap);
  const list = o.listSame ? `The controls are the same as before: ${o.snap.controls.length}, numbered as in the last list.` : fullList;
  const words = screenText(o.snap);
  const content = [list, words].filter(Boolean).join("\n\n");
  const body = o.external
    ? frameExternal({ tag: "web_page", attrs: { url: o.external }, what: "a web page opened with the ui tool" }, content)
    : content;
  const reports = pageReports(o.snap as PageSnapshot);
  const output = [
    o.did,
    o.heading,
    body,
    reports,
    unnamedNote(o.snap.controls),
    o.extra ?? "",
    o.shot.image ? "A picture of it follows this result." : o.shot.same ? "The picture is identical to the last one: nothing on screen changed." : "No picture could be taken of it this time.",
  ].filter(Boolean).join("\n\n");
  const errs = (o.snap as PageSnapshot).errors?.length ?? 0;
  return {
    output: failed ? `Error: ${output}` : output,
    isError: failed || undefined,
    // The user's row reads without the list numbers, which only mean something to the model.
    summary:
      (o.step.steps ? batchSummary(o.step.steps, failed) : o.did ? stripNumbers(o.did) : `Looked at ${o.title} (${countControls(o.snap)}${o.shot.size ? `, ${o.shot.size}` : ""})`) +
      (errs ? ` · ${errs} page error${errs === 1 ? "" : "s"}` : ""),
    detail: [o.step.steps ? o.did : "", fullList, reports].filter(Boolean).join("\n\n"),
    images: o.shot.image ? [o.shot.image] : undefined,
    ui: stepDisplay(o.step, o.snap, failed),
  };
}

/** One line for a batch on the user's row: "4 steps: click Open menu, type Name, …". Pure. */
export function batchSummary(steps: UiStepLine[], failed: boolean): string {
  const words = steps.map((x) => `${x.action}${x.target ? ` ${x.target.replace(/^[a-z ]+ /, "")}` : ""}`);
  const ok = steps.filter((x) => x.ok).length;
  const head = failed ? `${ok} of ${steps.length} steps` : `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const body = words.join(", ");
  return `${head}: ${body.length > 90 ? `${body.slice(0, 89)}…` : body}`;
}

/** What a step used, for its line in the test: the text typed, the key, the address. */
function stepInput(req: UiRequest): string | undefined {
  if (req.action === "type") return req.text;
  if (req.action === "key") return req.key;
  if (req.action === "scroll") return req.direction;
  if (req.action === "wait") return req.text || req.gone;
  if (req.action === "resize") return req.width && req.height ? `${req.width}×${req.height}` : "back to normal";
  if (req.url) return req.url;
  if (req.port !== undefined) return `port ${req.port}`;
  return undefined;
}

/**
 * One step as the test view draws it (pure): passed or failed, and the one line that
 * says why. A failed action says what stopped it; a page error during the step fails it
 * too, since the click "worked" but the app broke; otherwise the line is what the screen
 * newly says, which is how a person would know the step did something.
 */
export function stepDisplay(step: StepInfo, snap: UiSnapshot | PageSnapshot, failed: boolean): UiDisplay {
  const errors = (snap as PageSnapshot).errors;
  const dialogs = (snap as PageSnapshot).dialogs;
  const had = new Set(step.before);
  const names = new Set(snap.controls.map((c) => c.name));
  const news = snap.texts.map((x) => x.text).find((t) => !had.has(t) && !names.has(t));
  const why = failed
    ? step.failWhy
    : errors?.length
      ? errors[0]
      : news ?? (step.action === "look" ? `${countControls(snap)} on screen` : undefined);
  return {
    live: step.live,
    action: step.action,
    ...(step.target ? { target: step.target } : {}),
    ...(step.input ? { input: step.input.length > 80 ? `${step.input.slice(0, 79)}…` : step.input } : {}),
    ok: !failed && !errors?.length,
    ...(why ? { why } : {}),
    ...(step.target?.endsWith("(no name)") ? { warn: "This control has no accessible name" } : {}),
    ...(errors?.length ? { errors } : {}),
    ...(dialogs?.length ? { dialogs } : {}),
    ...(step.steps?.length ? { steps: step.steps } : {}),
    app: step.app,
    startedAt: step.startedAt,
    endedAt: Date.now(),
  };
}

/** A sentence for the user's row: the model's list numbers mean nothing there. Pure. */
function stripNumbers(did: string): string {
  return did.replace(/\[\d+\] /g, "").replace(/\.$/, "");
}

/** "Clicked [4] button "Go"." in the words of what actually happened. Pure. */
export function describeAction(action: Action, label: string, text: string, direction: string, how?: string, key?: string): string {
  if (action === "key") return `Pressed ${key ?? "the key"}${label ? ` in ${label}` : ""}.`;
  if (action === "hover") return `Hovering over ${label}.`;
  if (action === "type") {
    if (how?.startsWith("picked ")) return `Picked ${how.slice("picked ".length)} in ${label}.`;
    return `Typed "${text.length > 60 ? `${text.slice(0, 59)}…` : text}" into ${label}.`;
  }
  if (action === "scroll") {
    if (how === "brought into view") return `Brought ${label} into view.`;
    return label ? `Scrolled ${direction} in ${label}.` : `Scrolled ${direction}.`;
  }
  // What the control did: a toggle toggled, a tab was selected, a dropdown opened.
  const verb: Record<string, string> = { pressed: "Clicked", toggled: "Toggled", selected: "Selected", expanded: "Opened", collapsed: "Closed" };
  return `${(how && verb[how]) || "Clicked"} ${label}.`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(text: string): ToolResult {
  return { output: `Error: ${text}`, isError: true, summary: text.slice(0, 80) };
}
