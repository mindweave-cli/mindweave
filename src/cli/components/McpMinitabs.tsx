/**
 * McpMinitabs.tsx — what `/mcp` shows.
 *
 * Two minitabs, the same shape `/key` proved: a flat SERVERS list ("+ Add a server" first,
 * then every server you have), and picking one drops into its own MANAGE screen with
 * everything you can do to it — Enable/Disable, Reconnect, Review blocked tools, Edit,
 * Remove — each one applied the instant you press Enter. Nothing here stages a change for
 * a later "save": there is nothing left to save once an action has already run.
 *
 * Add and Edit share one small step-through form (type, name, command/URL, env, where to
 * save it, then a review) rather than two — editing a server IS adding one, with the name
 * fixed and the fields pre-filled, so building two forms would only be two places for the
 * same bug. Both end at `onSubmit`, which runs the one validator (`parseAddSpec`) every
 * other way of adding a server already goes through — the typed `/mcp add` and the
 * `mcp_server` tool — so this cannot accept something they would reject.
 *
 * ANOTHER STEP-THROUGH FORM'S KEYS, and why they differ from the list/manage screens: a
 * text field already owns Left/Right (moving the cursor inside what you're typing) and
 * Enter (submitting that field), so this form cannot ALSO bind those to "change step"
 * without breaking the one thing you came to do — fix a typo in the middle of a command
 * line. PageUp goes back a step instead, because nothing here ever needs it for anything
 * else, and Escape always cancels the whole form outright rather than stepping back one —
 * one job per key, everywhere in this form, which is what `/key`'s Esc-doubles-as-back
 * cannot promise once a key is also expected to move a text cursor.
 */
import { Box, Text, useInput } from "ink";
import { useRef, useState, type ReactNode } from "react";
import { stripMouse } from "../mouse.js";
import { MiniTabPanel as Panel, MiniTabRow as Row, miniTabPosition as position, miniTabWindowStart as windowStart, MINITAB_WINDOW as WINDOW } from "./minitabs.js";
import type { ConnectionStatus } from "../../mcp/connection.js";
import type { McpServerConfig } from "../../mcp/config.js";
import { parseAddSpec, splitArgs, type AddScope, type AddSpec } from "../../mcp/configWrite.js";

const ACTION_REVIEW_BLOCKED = "Review blocked tools";
const ACTION_SIGN_IN = "Sign in (opens your browser)";
const ACTION_SIGN_OUT = "Sign out";
const ACTION_ENABLE = "Enable";
const ACTION_DISABLE = "Disable";
const ACTION_RECONNECT = "Reconnect";
const ACTION_EDIT = "Edit (command, URL, env)";
const ACTION_REMOVE = "Remove";
const ACTION_BACK = "Back";

// "MCP servers" is the longer of the two titles that alternate on the same tab bar
// ("MCP servers" on Servers, "Manage" or a server's own name on Manage) — reserving its
// width keeps the tab bar in the same column switching either way, instead of it sliding
// left when the shorter title is showing.
const TITLE_WIDTH = "MCP servers".length;

const ESCAPE_BYTE = String.fromCharCode(27);

/** One field of the guided form, held as plain strings until submit — parsing and every
 *  real validation happen exactly once, at `parseAddSpec`, not spread across each field. */
export interface WizardDraft {
  type: "stdio" | "http";
  name: string;
  /** The whole command line ("npx -y @x/server-y") for stdio, or the bare URL for http —
   *  typed the same way it would be after `/mcp add name`, so `splitArgs` does the rest. */
  commandLine: string;
  /** Space-separated KEY=VALUE pairs. stdio only. */
  env: string;
  /** Comma-separated "Name: value" pairs — an http server's auth headers. Not
   *  space-separated like `env`: a header's VALUE routinely contains spaces of its own
   *  ("Bearer abc123"), which a space-separated list could not tell from a new pair. */
  headers: string;
  scope: AddScope;
}

export type WizardStep = "command" | "env" | "headers" | "scope" | "review";

/**
 * Which fields this form needs.
 *
 * There is no "pick a transport" step and no "server name" step, and both absences are
 * the point. Choosing "A command" and then being asked for a NAME is a form arguing with
 * itself: you said what you wanted to enter, so the next thing you do should be entering
 * it. So the two transports are the two rows of the FIRST field — ↑/↓ says which one you
 * mean and you type straight into it — and the name is worked out from what you typed
 * (see `deriveName`), shown on the review before anything is written.
 */
export function stepsFor(type: WizardDraft["type"]): WizardStep[] {
  return ["command", type === "stdio" ? "env" : "headers", "scope", "review"];
}

/** The ghost text in each transport's field — also what that row reads as when it is not
 *  the one you are typing into. */
export const CMD_GHOST = "A command (runs locally, e.g. npx …)";
export const URL_GHOST = "A URL (http/https server)";

/**
 * The server's name, worked out from what was typed, because nothing should have to be
 * typed twice. `npx -y @modelcontextprotocol/server-github` is already carrying "github"
 * and `https://mcp.linear.app/mcp` is already carrying "linear" — asking for the name
 * separately is asking someone to repeat themselves.
 *
 * Always returns SOMETHING for a non-empty command, even if it is just the first word:
 * a blank name is refused by `parseAddSpec`, and a dead end on the review step with no
 * name field left to fix it in would be unescapable.
 */
export function deriveName(draft: WizardDraft): string {
  const raw = draft.commandLine.trim();
  if (!raw) return "";
  if (draft.type === "http") {
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      return "";
    }
    const labels = host.split(".").filter(Boolean);
    // Drop the parts every host has ("www.", "api.", an "mcp." subdomain) and the public
    // suffix, so mcp.linear.app reads as the thing it is: linear.
    const meaningful = labels.slice(0, Math.max(1, labels.length - 1)).filter((l) => !["www", "api", "mcp"].includes(l));
    return tidyName(meaningful[0] ?? labels[0] ?? "");
  }
  // stdio: the last thing that is not a flag is the package or script being run.
  const words = splitArgs(raw).filter((w) => !w.startsWith("-"));
  const last = words[words.length - 1] ?? "";
  return tidyName(last.split(/[/\\]/).pop() ?? last);
}

/** Strip the parts of a package name that say "this is an MCP server" rather than WHICH
 *  one, and fall back to the original if that would leave nothing at all. */
function tidyName(raw: string): string {
  const trimmed = raw
    .replace(/\.[a-z0-9]+$/i, "") // a file extension: server.py -> server
    .replace(/^server[-_]/i, "")
    .replace(/[-_]?(mcp|server)$/i, "");
  return trimmed || raw;
}

export function blankDraft(): WizardDraft {
  return { type: "stdio", name: "", commandLine: "", env: "", headers: "", scope: "project" };
}

/** Parse "Name: value, Name2: value2" into the header map `parseAddSpec` expects. Each
 *  pair is split on the FIRST colon only, matching typed `--header 'Name: value'`. */
function parseHeaderPairs(text: string): [string, string][] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const colon = pair.indexOf(":");
      return colon > 0 ? ([pair.slice(0, colon).trim(), pair.slice(colon + 1).trim()] as [string, string]) : null;
    })
    .filter((p): p is [string, string] => p !== null);
}

/** The text a step is editing, or null when the step is a choice rather than a field. One
 *  place that mapping lives, so the key handler and the render cannot disagree about which
 *  field a keystroke belongs to. */
function fieldOf(draft: WizardDraft, step: WizardStep): string | null {
  if (step === "command") return draft.commandLine;
  if (step === "env") return draft.env;
  if (step === "headers") return draft.headers;
  return null;
}

/** The same mapping, writing. */
function withField(draft: WizardDraft, step: WizardStep, value: string): WizardDraft {
  if (step === "command") return { ...draft, commandLine: value };
  if (step === "env") return { ...draft, env: value };
  if (step === "headers") return { ...draft, headers: value };
  return draft;
}

/** The form's starting point when editing a server already on disk. */
export function draftFromConfig(config: McpServerConfig, scope: AddScope): WizardDraft {
  if (config.type === "http") {
    const headers = Object.entries(config.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ");
    return { type: "http", name: config.name, commandLine: config.url, env: "", headers, scope };
  }
  const env = Object.entries(config.env ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  return { type: "stdio", name: config.name, commandLine: [config.command, ...config.args].join(" "), env, headers: "", scope };
}

/** The same argv `/mcp add` would receive, so ONE parser (`parseAddSpec`) validates every
 *  route to a server config — this form cannot accept something typed add would reject. */
export function argvFromDraft(draft: WizardDraft): string[] {
  // Editing carries the server's existing name; adding has none, so it comes from what
  // was typed. Either way ONE name reaches the validator, and it is the one the review
  // step showed.
  const name = draft.name.trim() || deriveName(draft);
  const argv: string[] = [];
  if (draft.scope === "global") argv.push("--global");
  if (draft.type === "http") {
    argv.push("--http");
    for (const [k, v] of parseHeaderPairs(draft.headers)) argv.push("--header", `${k}: ${v}`);
    argv.push(name, draft.commandLine.trim());
    return argv;
  }
  for (const pair of draft.env.trim().split(/\s+/).filter(Boolean)) argv.push("--env", pair);
  argv.push(name, ...splitArgs(draft.commandLine));
  return argv;
}

type Mode =
  // Two tabs, switched with ←/→ directly — no Enter needed to move between them, the
  // same way every other left/right-driven control in this app works. `selected` is
  // which server Manage is showing; it survives moving back to Servers and forward
  // again, so arrowing over to check something and back does not lose your place.
  | { kind: "tabs"; tab: 0 | 1; serverSel: number; manageSel: number; selected: string | null }
  // Not a third tab — a full-screen step-through reached FROM a tab (Add from Servers,
  // Edit from Manage), and `returnTab` is where Esc or a finished submit puts you back.
  | { kind: "wizard"; editing: string | null; step: number; draft: WizardDraft; error: string | null; returnTab: 0 | 1 }
  // Signing in, with the browser off doing its thing. A MODE rather than a closed box and
  // a stream of transcript lines, because the whole of it belongs to this screen: it is
  // about one server, it is over in a few seconds, and the 400-character URL it sometimes
  // has to offer is unreadable noise anywhere else. Esc aborts it through `signal`.
  | { kind: "signing"; name: string; url: string | null; copied: boolean; error: string | null; done: string | null };

export interface McpMinitabsProps {
  /** Read fresh every render — the same discipline `/key`'s `keysOf` follows, so an
   *  action taken a moment ago (Disable, Remove, a reconnect landing) is what shows. */
  servers: ConnectionStatus[];
  blockedCountFor: (name: string) => number;
  /** The server's LIVE config, for Edit's starting values and for flipping `disabled`. */
  configFor: (name: string) => McpServerConfig | undefined;
  /** One path for Add AND Edit — see the file header for why. */
  onSubmit: (spec: AddSpec) => void;
  onSetDisabled: (name: string, disabled: boolean) => void;
  onRemove: (name: string) => void;
  onReconnect: (name: string) => void;
  onReviewBlocked: (name: string) => void;
  /** Names of servers we hold a credential for, so the screen offers "Sign out" rather
   *  than a second "Sign in". Read fresh by the parent, like every other fact here. */
  signedIn?: ReadonlySet<string>;
  /**
   * Run the sign-in, reporting back INTO this box rather than through the transcript.
   *
   * `onUrl` is called only when the browser has not come back after a few seconds, and
   * the URL it carries is offered here as something to copy — never printed, because it
   * is unreadable and the successful path never needs it. Resolves with the line to show
   * on success; rejects with the sentence to show on failure.
   */
  onSignIn?: (name: string, handlers: { onUrl: (url: string) => void; signal: AbortSignal }) => Promise<string>;
  onSignOut?: (name: string) => void;
  /** Put the authorize URL on the clipboard, for the machine whose browser never opened. */
  onCopyLink?: (url: string) => void;
  width: number;
  maxRows?: number;
  onClose: () => void;
  active?: boolean;
}

export function McpMinitabs({
  servers,
  blockedCountFor,
  configFor,
  onSubmit,
  onSetDisabled,
  onRemove,
  onReconnect,
  onReviewBlocked,
  signedIn,
  onSignIn,
  onSignOut,
  onCopyLink,
  width,
  maxRows = WINDOW,
  onClose,
  active = true,
}: McpMinitabsProps) {
  const win = Math.max(2, maxRows - 1);
  const [mode, setMode] = useState<Mode>({ kind: "tabs", tab: 0, serverSel: 0, manageSel: 0, selected: null });
  /** The in-flight sign-in, so Esc can abort THIS one rather than a stale closure's. */
  const signInAbort = useRef<AbortController | null>(null);
  /**
   * Who is signed in, as of the last thing that happened HERE.
   *
   * The prop is read once when the box opens, which was fine until signing in and out
   * moved inside the box: after either, the prop describes a world one action out of date,
   * and the action list offered the wrong row — most visibly, no way back in after signing
   * out. `null` means nothing has changed yet and the prop is still the truth.
   */
  const [credentialed, setCredentialed] = useState<ReadonlySet<string> | null>(null);
  const holdsCredential = (name: string): boolean => (credentialed ?? signedIn)?.has(name) ?? false;
  const noteCredential = (name: string, held: boolean): void =>
    setCredentialed((prev) => {
      const next = new Set(prev ?? signedIn ?? []);
      if (held) next.add(name);
      else next.delete(name);
      return next;
    });

  // The Servers tab's rows — "+ Add a server" first, then every server. Built once so
  // both the key handler and the render read the identical list.
  const serverRows: { label: string; detail?: string; add?: boolean }[] = [
    { label: "+ Add a server", add: true },
    ...servers.map((s) => ({ label: s.name, detail: serverDetail(s, blockedCountFor(s.name)) })),
  ];

  // The server Manage is showing — from `mode.selected` normally, or `mode.editing` while
  // the wizard is mid-edit, so the title and hint keep naming the right server even though
  // editing does not live in `mode.tab`'s state at all.
  const selectedName = mode.kind === "tabs" ? mode.selected : mode.kind === "signing" ? mode.name : mode.editing;
  // Falling back to the FIRST server matters: → from the "+ Add a server" row used to land
  // on a Manage tab with nothing selected and nothing to do. Managing the first server is
  // the useful thing to show there, and the empty state below is then only for the case
  // that really is empty — no servers at all.
  const selected = servers.find((s) => s.name === selectedName) ?? servers[0];
  const actions = selected ? actionsFor(selected, blockedCountFor(selected.name), holdsCredential(selected.name)) : [];

  /** ← one step. From the FIRST step there is no earlier step, so it closes the form and
   *  hands focus back to the list beside it — which makes ← the single key that walks all
   *  the way out of here, however deep you are, without ever needing Esc. */
  function stepBack(w: Extract<Mode, { kind: "wizard" }>) {
    if (w.step === 0) return cancelWizard(w);
    setMode({ ...w, step: w.step - 1, error: null });
  }
  function stepForward(w: Extract<Mode, { kind: "wizard" }>) {
    const steps = stepsFor(w.draft.type);
    if (w.step >= steps.length - 1) return;
    setMode({ ...w, step: w.step + 1, error: null });
  }
  function cancelWizard(w: Extract<Mode, { kind: "wizard" }>) {
    setMode({ kind: "tabs", tab: w.returnTab, serverSel: 0, manageSel: 0, selected: w.editing });
  }
  function trySubmit(w: Extract<Mode, { kind: "wizard" }>) {
    const parsed = parseAddSpec(argvFromDraft(w.draft));
    if (!parsed.ok) return setMode({ ...w, error: parsed.error });
    onSubmit(parsed.spec);
    // Land back on Servers after Add (there is nothing yet to manage the moment it is
    // written — the connect is async); land on Manage, still on the same server, after
    // an Edit, since that is the screen you were already looking at.
    setMode(
      w.editing
        ? { kind: "tabs", tab: 1, serverSel: 0, manageSel: 0, selected: w.editing }
        : { kind: "tabs", tab: 0, serverSel: 0, manageSel: 0, selected: null },
    );
  }

  /**
   * Start a sign-in and STAY on this screen while it runs.
   *
   * The abort controller is what makes Esc mean something here: the browser may never come
   * back, and without it the only way out of a forgotten sign-in is the five-minute
   * timeout. It is held in a ref rather than state because the key handler needs the
   * current one, and a stale closure would abort the wrong attempt.
   */
  function startSignIn(name: string) {
    if (!onSignIn) return;
    const controller = new AbortController();
    signInAbort.current = controller;
    setMode({ kind: "signing", name, url: null, copied: false, error: null, done: null });
    void onSignIn(name, {
      onUrl: (url) => setMode((m) => (m.kind === "signing" && m.name === name ? { ...m, url } : m)),
      signal: controller.signal,
    }).then(
      (message) => {
        noteCredential(name, true);
        setMode((m) => (m.kind === "signing" && m.name === name ? { ...m, done: message } : m));
      },
      (error: unknown) =>
        setMode((m) =>
          m.kind === "signing" && m.name === name ? { ...m, error: String((error as Error)?.message ?? error) } : m,
        ),
    );
  }

  /** → (or Enter on a real server row): switch to Manage. Always switches, even with
   *  nothing to manage yet — that is what lets the tab show its own empty state ("add a
   *  server first") instead of → silently doing nothing, which read as the tab bar being
   *  broken rather than as there being nothing there yet. */
  function goToManage(m: Extract<Mode, { kind: "tabs" }>, serverSelOverride?: number) {
    const row = serverRows[serverSelOverride ?? m.serverSel];
    const name = row && !row.add ? row.label : m.selected;
    setMode({ ...m, tab: 1, selected: name, manageSel: 0 });
  }

  function commitServers(m: Extract<Mode, { kind: "tabs" }>) {
    const row = serverRows[m.serverSel];
    if (!row) return;
    if (row.add) return setMode({ kind: "wizard", editing: null, step: 0, draft: blankDraft(), error: null, returnTab: 0 });
    goToManage(m);
  }

  function commitManage(m: Extract<Mode, { kind: "tabs" }>) {
    if (!selected) return;
    const chosen = actions[m.manageSel] ?? ACTION_BACK;
    // The parent closes this whole overlay to run the approval channel — see the file
    // header on why a second dialog cannot share this box with the manage screen.
    if (chosen === ACTION_REVIEW_BLOCKED) return onReviewBlocked(selected.name);
    if (chosen === ACTION_SIGN_IN) return startSignIn(selected.name);
    if (chosen === ACTION_SIGN_OUT) {
      noteCredential(selected.name, false);
      setMode({ ...m, manageSel: 0 });
      return onSignOut?.(selected.name);
    }
    // These three change the action list's own SHAPE (Reconnect appears/disappears,
    // Enable/Disable swaps) without leaving the tab, so the highlight is reset rather
    // than risking it pointing at a row that moved or is no longer there.
    if (chosen === ACTION_ENABLE) {
      setMode({ ...m, manageSel: 0 });
      return onSetDisabled(selected.name, false);
    }
    if (chosen === ACTION_DISABLE) {
      setMode({ ...m, manageSel: 0 });
      return onSetDisabled(selected.name, true);
    }
    if (chosen === ACTION_RECONNECT) {
      setMode({ ...m, manageSel: 0 });
      return onReconnect(selected.name);
    }
    if (chosen === ACTION_EDIT) {
      const config = configFor(selected.name);
      const scope: AddScope = "project"; // the caller resolves the real file; this only seeds the picker
      return setMode({
        kind: "wizard",
        editing: selected.name,
        step: 0,
        draft: config ? draftFromConfig(config, scope) : blankDraft(),
        error: null,
        returnTab: 1,
      });
    }
    if (chosen === ACTION_REMOVE) {
      onRemove(selected.name);
      return setMode({ kind: "tabs", tab: 0, serverSel: 0, manageSel: 0, selected: null });
    }
    // ACTION_BACK — the same place ← already goes; kept as a row for the same reason
    // /key's actions screen keeps one, even though Esc/⌫ also work.
    return setMode({ ...m, tab: 0 });
  }

  useInput(
    (input, key) => {
      // `key.escape` is Ink's own read of the byte; `input === ESCAPE_BYTE` is a direct
      // check of the raw byte itself as a fallback. They should never disagree, but this
      // overlay turns mouse tracking on for drag-select elsewhere in the app, and a
      // solitary Escape arriving in the same chunk as a mouse report is exactly the kind
      // of ambiguous byte sequence a terminal's own parser can misclassify — checking the
      // raw byte too costs nothing and closes that gap if it is ever the cause.
      const isEscape = key.escape || input === ESCAPE_BYTE;
      // ONE job for Esc, everywhere in this box: close it. Not "cancel the form", not
      // "step back one" — those are ← now. A key that means something different depending
      // on how deep you are is a key you have to think about, and this one is also the
      // least reliable byte a terminal sends (a lone ESC that arrives sharing a chunk with
      // anything else is not recognised as ESC at all), so nothing you NEED in order to
      // get out may depend on it. ← walks all the way back to the list on its own.
      if (mode.kind === "signing") {
        // Esc while it is still running ABANDONS the attempt rather than closing the box:
        // there is a browser tab open and a port held, and leaving both running while the
        // screen disappears is the shape of bug that makes a second attempt fail too.
        // Once it has finished, Esc is Esc again.
        const finished = mode.done !== null || mode.error !== null;
        if (isEscape) {
          if (finished) return onClose();
          signInAbort.current?.abort();
          return setMode({ kind: "tabs", tab: 1, serverSel: 0, manageSel: 0, selected: mode.name });
        }
        if (key.return || key.leftArrow) {
          if (!finished) signInAbort.current?.abort();
          return setMode({ kind: "tabs", tab: 1, serverSel: 0, manageSel: 0, selected: mode.name });
        }
        // The link is offered to COPY rather than printed: it is 400 characters, and the
        // only machine that needs it is one whose browser never opened.
        if (mode.url && (input === "c" || input === "C")) {
          onCopyLink?.(mode.url);
          return setMode({ ...mode, copied: true });
        }
        return;
      }

      if (isEscape) return onClose();

      if (mode.kind === "wizard") {
        const steps = stepsFor(mode.draft.type);
        const kind = steps[mode.step]!;

        // ← means BACK on every step without exception, and → means forward. They are not
        // shared with a text cursor, because this form has no mid-string cursor to share
        // them with: typing appends and Backspace deletes, which is all these one-line
        // fields need. That is the trade that buys ← exactly one meaning everywhere in
        // this box — the thing that kept going wrong when "back" moved from key to key
        // depending on which step you were standing on.
        if (key.leftArrow || key.pageUp) return stepBack(mode);
        if (key.rightArrow || key.return) return kind === "review" ? trySubmit(mode) : stepForward(mode);

        // ↑/↓ pick between the two rows a step offers — which transport you are typing
        // (adding only: editing one does not change its transport), or which scope.
        if (key.upArrow || key.downArrow) {
          if (kind === "command" && mode.editing === null) {
            return setMode({ ...mode, draft: { ...mode.draft, type: mode.draft.type === "stdio" ? "http" : "stdio" } });
          }
          if (kind === "scope") {
            return setMode({ ...mode, draft: { ...mode.draft, scope: mode.draft.scope === "project" ? "global" : "project" } });
          }
          return;
        }

        const current = fieldOf(mode.draft, kind);
        if (current === null) return; // scope and review have nothing to type into
        if (key.backspace || key.delete) {
          return setMode({ ...mode, draft: withField(mode.draft, kind, current.slice(0, -1)), error: null });
        }
        const typed = key.ctrl || key.meta || key.tab ? "" : stripMouse(input);
        if (typed) setMode({ ...mode, draft: withField(mode.draft, kind, current + typed), error: null });
        return;
      }

      if (key.backspace || key.delete) return onClose();
      if (key.leftArrow) return setMode({ ...mode, tab: 0 });
      if (key.rightArrow) return goToManage(mode);

      if (mode.tab === 0) {
        const count = serverRows.length;
        if (count === 0) return;
        if (key.upArrow) return setMode({ ...mode, serverSel: (mode.serverSel - 1 + count) % count });
        if (key.downArrow) return setMode({ ...mode, serverSel: (mode.serverSel + 1) % count });
        if (key.return) return commitServers(mode);
        const n = Number.parseInt(input, 10);
        if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, count)) return commitServers({ ...mode, serverSel: n - 1 });
        return;
      }
      // tab 1 — Manage
      const count = actions.length;
      if (count === 0) return;
      if (key.upArrow) return setMode({ ...mode, manageSel: (mode.manageSel - 1 + count) % count });
      if (key.downArrow) return setMode({ ...mode, manageSel: (mode.manageSel + 1) % count });
      if (key.return) return commitManage(mode);
      const n = Number.parseInt(input, 10);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, count)) return commitManage({ ...mode, manageSel: n - 1 });
    },
    { isActive: active },
  );

  // Which of the two real tabs is "behind" the current screen — the list you'll land back
  // on after the wizard, or the one you're looking at right now. The tab bar reads off of
  // this everywhere, wizard included: it must never go away, because that is the whole
  // complaint the wizard used to earn ("opens a different window and the taskbar is gone").
  const activeTab = mode.kind === "wizard" ? mode.returnTab : mode.kind === "signing" ? 1 : mode.tab;
  const tabsBar = [{ active: activeTab === 0 }, { active: activeTab === 1 }];
  const serverSel = mode.kind === "tabs" ? mode.serverSel : 0;
  const manageSel = mode.kind === "tabs" ? mode.manageSel : 0;

  // TWO PANES while a form is open, one box and one tab bar over both: the list keeps the
  // LEFT, the form takes the RIGHT. Stacking the form under the list is what this replaced,
  // and the reason is that a form row directly below a list row reads as one more list row
  // — you cannot tell what you are looking at. Side by side, the list is plainly context
  // and the form is plainly the thing you are filling in. With no form open the list has
  // the whole width back, exactly as before, so nothing moves for the common case.
  const inner = Math.max(12, width - 4);
  const PANE_GAP = 3;
  const wizard = mode.kind === "wizard" ? mode : null;
  // MANAGE is always two panes, for the same reason a form is: the left is the list you
  // are working from and the right is what you are doing to it. That makes both tabs the
  // same shape — left never changes meaning, right is always the work — so moving between
  // them is not learning a second layout. Only tab 1 with no form open is a single pane,
  // because there the list IS the whole screen and nothing is being done to it yet.
  const twoPane = wizard !== null || activeTab === 1;
  const leftPane = twoPane ? Math.max(18, Math.min(34, Math.floor(inner * 0.42))) : inner;
  const rightPane = twoPane ? Math.max(16, inner - leftPane - PANE_GAP) : 0;
  // A server's status ("connected · 3 tools") needs a second column the narrowed left pane
  // may not have room for. Dropped rather than truncated to four characters: a status
  // clipped to "conn" is worse than no status while you are looking at a form anyway.
  const leftDetail = leftPane >= 46;
  const wizardView = wizard ? wizardBody(wizard, rightPane) : null;
  const hint =
    (mode.kind === "signing" ? signInView(mode).hint : undefined) ?? wizardView?.hint ?? "←/→ tab · ↑/↓ move · Enter select · Esc closes";

  /** The list on the left, the form on the right, a dim rule between them. `rows` is how
   *  tall the rule is drawn — the taller of the two panes, so it spans the whole body.
   *  `topPad` is blank lines above the RIGHT pane, matching whatever blank line the left
   *  list opens with, so the first row of each pane lands on the same screen line. Without
   *  it the two panes sit one row out of step and read as unrelated. */
  function TwoPane({ left, right, rows, topPad = 0 }: { left: ReactNode; right: ReactNode; rows: number; topPad?: number }) {
    return (
      <Box flexShrink={0} flexDirection="row" width={inner}>
        <Box flexShrink={0} flexDirection="column" width={leftPane}>{left}</Box>
        <Box flexShrink={0} flexDirection="column" width={PANE_GAP}>
          {Array.from({ length: rows }).map((_, i) => (
            <Box key={i} flexShrink={0}><Text dimColor>{" │ "}</Text></Box>
          ))}
        </Box>
        <Box flexShrink={0} flexDirection="column" width={rightPane}>
          {Array.from({ length: topPad }).map((_, i) => (
            <Box key={`pad${i}`} flexShrink={0}><Text> </Text></Box>
          ))}
          {right}
        </Box>
      </Box>
    );
  }

  /** One row of the form: the `›` marker if it is the row you are on, then its content. */
  function FieldRow({ on, pane, children }: { on: boolean; pane: number; children: ReactNode }) {
    return (
      <Box flexShrink={0} width={pane}>
        <Text color={on ? "cyan" : undefined} bold={on}>{on ? " › " : "   "}</Text>
        {children}
      </Box>
    );
  }

  /**
   * What you have typed, or the GHOST of what you could type, with the block cursor.
   *
   * The placeholder is not a label beside an empty box — it is the text sitting IN the
   * field, dim, and it is gone the moment there is a real character to show instead.
   */
  function Ghost({ value, placeholder }: { value: string; placeholder: string }) {
    if (value.length > 0) {
      return (
        <>
          <Text wrap="truncate-end">{value}</Text>
          <Text inverse> </Text>
        </>
      );
    }
    return (
      <>
        <Text inverse dimColor>{placeholder.slice(0, 1)}</Text>
        <Text dimColor wrap="truncate-end">{placeholder.slice(1)}</Text>
      </>
    );
  }

  /**
   * The sign-in, reported where it is happening.
   *
   * Three states and no URL in any of them until it is asked for. The successful path is
   * over in seconds and says one line; the stuck path offers the link to COPY, because a
   * 400-character query string is something to paste, never something to read; the failed
   * path says what the server said, which is almost always the whole explanation.
   */
  function signInView(s: Extract<Mode, { kind: "signing" }>): { rows: number; hint: string; node: ReactNode } {
    const line = (text: string, color?: string, dim = false) => (
      <Box flexShrink={0} width={rightPane}>
        <Text color={color} dimColor={dim} wrap="truncate-end">{`  ${text}`}</Text>
      </Box>
    );
    if (s.error) {
      return {
        rows: 3,
        hint: "Enter or Esc go back",
        node: (
          <>
            {line(`Could not sign in to ${s.name}.`, "yellow")}
            <Box flexShrink={0}><Text> </Text></Box>
            {line(s.error, undefined, true)}
          </>
        ),
      };
    }
    if (s.done) {
      return { rows: 1, hint: "Enter or Esc go back", node: line(s.done, "green") };
    }
    return {
      rows: 3,
      hint: s.url ? "c copy the link · Esc cancels" : "Esc cancels",
      node: (
        <>
          {line(`Waiting for your browser…`)}
          <Box flexShrink={0}><Text> </Text></Box>
          {s.copied
            ? line("Link copied. Paste it into a browser.", "green")
            : s.url
              ? line("Nothing opened? Press c to copy the link.", undefined, true)
              : line(`Approve ${s.name} in the window that opened.`, undefined, true)}
        </>
      ),
    };
  }

  function wizardBody(w: Extract<Mode, { kind: "wizard" }>, pane: number): { rows: number; hint: string; node: ReactNode } {
    const steps = stepsFor(w.draft.type);
    const kind = steps[w.step]!;
    // ← is back and → is forward on every single step, so every hint says exactly that,
    // and Esc is only ever named for the one thing it does: closing the box.
    const stepHint =
      kind === "review"
        ? "→ saves and connects · ← back · Esc closes"
        : kind === "scope"
          ? "↑/↓ choose · → next · ← back · Esc closes"
          : kind === "command" && w.editing === null
            ? "type it · ↑/↓ swaps kind · → next · ← back · Esc closes"
            : "type it · → next · ← back · Esc closes";

    if (kind === "command") {
      // The two transports ARE the two rows of this one field. Whichever is selected is
      // the one you are typing into; the other stays as its own ghost description, so the
      // alternative is still readable without being a separate step you had to get past.
      // Editing shows only the transport the server already has — a server does not change
      // transport by being edited, and offering the swap here would imply it could.
      const stdio = w.draft.type === "stdio";
      const rowFor = (mine: boolean, ghost: string) => (
        <FieldRow on={mine} pane={pane}>
          {mine ? <Ghost value={w.draft.commandLine} placeholder={ghost} /> : <Text dimColor wrap="truncate-end">{ghost}</Text>}
        </FieldRow>
      );
      return {
        rows: w.editing === null ? 2 : 1,
        hint: stepHint,
        node:
          w.editing !== null ? (
            rowFor(true, stdio ? CMD_GHOST : URL_GHOST)
          ) : (
            <>
              {rowFor(stdio, CMD_GHOST)}
              {rowFor(!stdio, URL_GHOST)}
            </>
          ),
      };
    }
    if (kind === "env" || kind === "headers") {
      const env = kind === "env";
      return {
        rows: 1,
        hint: stepHint,
        node: (
          <FieldRow on pane={pane}>
            <Text bold color="cyan">{env ? "env " : "headers "}</Text>
            <Ghost
              value={env ? w.draft.env : w.draft.headers}
              placeholder={env ? "GITHUB_TOKEN=ghp_xxxx (optional)" : "Authorization: Bearer xyz (optional)"}
            />
          </FieldRow>
        ),
      };
    }
    if (kind === "scope") {
      return {
        rows: 2,
        hint: stepHint,
        node: (
          <>
            <Row on={w.draft.scope === "project"} n={1} showNumber={false} leftDim left="This project only (.mindweave/mcp.json)" width={pane + 4} />
            <Row on={w.draft.scope === "global"} n={2} showNumber={false} leftDim left="Every project (~/.mindweave/mcp.json)" width={pane + 4} />
          </>
        ),
      };
    }
    const rows: [string, string][] = [
      ["Name", w.draft.name.trim() || deriveName(w.draft)],
      [w.draft.type === "http" ? "URL" : "Command", w.draft.commandLine],
      ...(w.draft.type === "stdio" && w.draft.env.trim() ? ([["Env", w.draft.env.trim()]] as [string, string][]) : []),
      ...(w.draft.type === "http" && w.draft.headers.trim() ? ([["Headers", w.draft.headers.trim()]] as [string, string][]) : []),
      ["Save to", w.draft.scope === "global" ? "Every project" : "This project only"],
    ];
    return {
      rows: rows.length + (w.error ? 2 : 0),
      hint: stepHint,
      node: (
        <>
          {rows.map(([k, v]) => (
            <Box key={k} flexShrink={0} width={pane}>
              <Box flexShrink={0} width={10}><Text dimColor>{k}</Text></Box>
              <Text wrap="truncate-end">{v}</Text>
            </Box>
          ))}
          {w.error ? (
            <Box flexShrink={0} width={pane} marginTop={1}>
              <Text color="yellow" wrap="truncate-end">{`  ${w.error}`}</Text>
            </Box>
          ) : null}
        </>
      ),
    };
  }

  /**
   * The LEFT pane, on both tabs: the list, spaced, with one row marked.
   *
   * One function rather than one per tab, because "the left pane is the list" is the whole
   * reason the two tabs read as one screen. `paneW` is the only thing that differs between
   * a single-pane tab 1 and either tab beside a right pane. Returns its own height so the
   * rule between the panes can be drawn to the taller of the two — which is what makes the
   * rule grow as you add servers instead of stopping short of them.
   */
  function listPane(rows: { label: string; detail?: string; add?: boolean }[], anchor: number, paneW: number) {
    const from = windowStart(anchor, rows.length, win);
    const shown = rows.slice(from, from + win);
    return {
      height: Math.max(0, shown.length * 2 - 1) + 1,
      node: (
        <>
          <Box flexShrink={0}><Text> </Text></Box>
          {shown.map((r, i) => (
            <Box key={r.label} flexShrink={0} flexDirection="column">
              <Row
                on={from + i === anchor}
                n={from + i + 1}
                showNumber={false}
                left={r.label}
                leftColor={r.add ? "yellow" : undefined}
                // A status needs a second column the narrowed pane may not have room for.
                // Dropped rather than clipped to "conn", which says less than nothing.
                right={paneW >= 46 ? r.detail : undefined}
                width={paneW + 4}
              />
              {i < shown.length - 1 ? <Box flexShrink={0}><Text> </Text></Box> : null}
            </Box>
          ))}
        </>
      ),
    };
  }

  if (activeTab === 1) {
    if (!selected) {
      // Genuinely nothing to manage — no servers exist at all. (→ from the "+ Add a
      // server" row no longer lands here: it manages the first server instead.)
      return (
        <Panel title="Manage" tabs={tabsBar} titleWidth={TITLE_WIDTH} rows={3} maxRows={maxRows} width={width} hint={hint}>
          <Box flexShrink={0}><Text> </Text></Box>
          <Box flexShrink={0}><Text dimColor>  Nothing to manage yet.</Text></Box>
          <Box flexShrink={0}><Text dimColor>  ← add a server on the Servers tab first.</Text></Box>
        </Panel>
      );
    }
    // Left: every server, the managed one marked. Right: what you can do to it — or the
    // edit form, once you pick Edit. Same shape as tab 1, one row down the same column.
    const managed = servers.findIndex((s) => s.name === selected.name);
    const left = listPane(
      servers.map((s) => ({ label: s.name, detail: serverDetail(s, blockedCountFor(s.name)) })),
      Math.max(0, managed),
      leftPane,
    );
    const from = windowStart(manageSel, actions.length, win);
    const shownActions = actions.slice(from, from + win);
    const signing = mode.kind === "signing" ? signInView(mode) : null;
    const right = signing ? signing.node : wizardView ? wizardView.node : (
      shownActions.map((a, i) => (
        <Row key={a} on={from + i === manageSel} n={from + i + 1} showNumber={false} left={a} width={rightPane + 4} />
      ))
    );
    const rightHeight = signing ? signing.rows : wizardView ? wizardView.rows : shownActions.length;
    const bodyHeight = Math.max(left.height, rightHeight + 1);
    return (
      <Panel
        title="Manage"
        tabs={tabsBar}
        titleWidth={TITLE_WIDTH}
        counter={wizardView ? "" : position(manageSel, actions.length, win)}
        rows={bodyHeight}
        maxRows={maxRows}
        width={width}
        hint={hint}
      >
        <TwoPane rows={bodyHeight} topPad={1} left={left.node} right={right} />
      </Panel>
    );
  }

  // The anchor with a form open is "+ Add a server" (row 0) — the row the form came from.
  const left = listPane(serverRows, wizardView ? 0 : serverSel, wizardView ? leftPane : inner);
  return (
    <Panel
      title="MCP servers"
      tabs={tabsBar}
      titleWidth={TITLE_WIDTH}
      counter={wizardView ? "" : position(serverSel, serverRows.length, win)}
      rows={wizardView ? Math.max(left.height, wizardView.rows + 1) : left.height}
      maxRows={maxRows}
      width={width}
      hint={hint}
    >
      {wizardView ? (
        <TwoPane rows={Math.max(left.height, wizardView.rows + 1)} topPad={1} left={left.node} right={wizardView.node} />
      ) : (
        left.node
      )}
    </Panel>
  );
}

/** What can be done to one server, in the order it is shown. */
export function actionsFor(server: ConnectionStatus, blocked: number, signedIn = false): string[] {
  const acts: string[] = [];
  if (blocked > 0) acts.push(ACTION_REVIEW_BLOCKED);
  // WHETHER A CREDENTIAL IS HELD decides this, not the connection state, and that is the
  // correction: gating Sign in on `needs-auth` left signing out as a one-way door. Signing
  // out deliberately leaves the connection running — the token is not refused until the
  // next call — so the server sits there `connected` with no credential and no way to get
  // one back. Offered for any http server without a token instead; a local command server
  // has no authorization server to send anyone to, so it never appears there.
  if (server.type === "http" && !signedIn) acts.push(ACTION_SIGN_IN);
  acts.push(server.state === "disabled" ? ACTION_ENABLE : ACTION_DISABLE);
  if (server.state === "failed" || server.state === "needs-auth") acts.push(ACTION_RECONNECT);
  // Below Reconnect: it is the rarer thing to want, and it is destructive in the small way
  // that logging out always is.
  if (signedIn) acts.push(ACTION_SIGN_OUT);
  acts.push(ACTION_EDIT, ACTION_REMOVE, ACTION_BACK);
  return acts;
}

/** The list row's dim detail — facts only, no call-to-action verb: Enter always opens the
 *  manage screen now, whatever the server's state, so a verb here would describe the old
 *  flat list's behaviour rather than this one's. */
export function serverDetail(s: ConnectionStatus, blocked: number): string {
  if (blocked > 0) return `${blocked} tool${blocked === 1 ? "" : "s"} blocked`;
  switch (s.state) {
    case "connected": {
      // Prompts are counted separately because they are the user's to invoke, not the
      // model's: a server offering only prompts would otherwise read as "0 tools" and
      // look broken.
      const counts = [
        `${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`,
        ...(s.promptCount ? [`${s.promptCount} prompt${s.promptCount === 1 ? "" : "s"}`] : []),
        ...(s.offersResources ? ["resources"] : []),
      ].join(", ");
      // The negotiated revision is worth surfacing: "legacy" is why a server may be
      // missing capabilities, and it is otherwise invisible.
      const proto = s.version ? ` · ${s.version}${s.legacy ? " (legacy)" : ""}` : "";
      return `connected · ${counts}${proto}`;
    }
    case "pending":
      return "connecting…";
    case "needs-auth":
      // Names the fix rather than the state. This is the one row where a user genuinely
      // does not know what to do next, and "needs authentication" describes the problem
      // to someone already looking at a screen full of problems.
      return "sign in to connect";
    case "disabled":
      return "disabled";
    default:
      return s.error ? `error · ${clip(s.error, 40)}` : "failed";
  }
}

/** A server's own error text is unbounded — this keeps a long one from being the thing
 *  that overflows the row (`MiniTabRow` also truncates `right`, but clipping the source
 *  string is what keeps the SUMMARY line in `note()`/`say()` readable too, not just the
 *  box row). */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}
