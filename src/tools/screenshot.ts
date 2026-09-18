/**
 * screenshot.ts — let the agent SEE a running window.
 *
 * This closes the loop v1.5 tried to close with process liveness. "Did the app
 * come up" was answered by "the process is still alive", which is not the same
 * question: a window that renders a stack trace is alive. Looking at it answers
 * it properly, and the same applies to a layout that is subtly wrong, a chart
 * with no data, or a dialog nobody expected.
 *
 * CAPTURE ONLY. There is no clicking, typing, or moving anything, and that is a
 * scope decision rather than a missing feature. Seeing closes the verification
 * loop; acting is a different product with a far larger risk surface, and it does
 * not belong in a small core.
 *
 * ## Privacy is the design, not a footnote
 *
 * A screenshot is the one tool here that can capture things the agent was never
 * pointed at — another project, an inbox, a password manager, a token sitting in
 * a scrollback — and then send them to a model provider. So:
 *
 *  - **One window, never the screen.** There is no full-desktop mode. The blast
 *    radius of a mistake is one window instead of everything open.
 *  - **In a guarded session the user approves the specific window, by title, before
 *    anything is captured.** Not after, and not once for the session. In an
 *    auto-accept session it captures without asking, like every other tool there:
 *    a mode that exists to stop confirming is not a mode with one exception in it,
 *    and the narrowness above is what makes that safe to say.
 *  - **No approval channel means no capture, in any mode.** A context that cannot ask
 *    (a sub-agent, a non-interactive run) is refused rather than defaulted to yes.
 *    The channel is what marks a session the user is sitting in front of.
 *
 * ## Where the picture goes
 *
 * The tool returns a ref, not bytes, and the engine decides what to do with it —
 * hand it to a model that can see, or tell one that can't where the file is. That
 * split is `feedback-universal-core-only`: the capability is stated once and core
 * degrades, rather than every tool learning which providers have eyes.
 */
import { mkdtemp } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { describeImage, isRejection } from "../memory/images.js";
import { formatBytes } from "./webFetch.js";
import { captureWindow, listWindows, type WindowInfo } from "./screenshotWin.js";

/** How many titles to name when a match fails, so the model can retry precisely. */
const MAX_LISTED = 12;

/** What matching a `window` argument against the open windows produced. */
export type WindowPick =
  /** `tied` holds the other windows the query fitted exactly as well, which focus was
   *  used to choose between. Empty when the match was the only candidate. */
  | { kind: "match"; window: WindowInfo; tied: WindowInfo[] }
  | { kind: "none"; candidates: WindowInfo[] }
  | { kind: "ambiguous"; candidates: WindowInfo[] };

/**
 * Choose the window to capture. Pure, and the whole of the matching policy.
 *
 * Ranked rather than first-wins, because a substring hits chrome ("Settings")
 * far more often than it hits the thing meant. An exact title beats a prefix
 * beats a substring, and an unambiguous winner at any tier ends it — so
 * "Mindweave" picks the editor window titled exactly that even while three other
 * windows mention it. A genuine tie is reported rather than guessed: capturing
 * the wrong window is a privacy event, not just a wrong answer.
 */
export function pickWindow(query: string | undefined, windows: WindowInfo[]): WindowPick {
  if (windows.length === 0) return { kind: "none", candidates: [] };

  if (!query) {
    const focused = windows.find((w) => w.foreground);
    return focused
      ? { kind: "match", window: focused, tied: windows.filter((w) => w !== focused) }
      : { kind: "ambiguous", candidates: windows };
  }

  const needle = query.trim().toLowerCase();
  const titled = windows.map((w) => ({ w, t: w.title.toLowerCase() }));
  const tiers = [
    titled.filter(({ t }) => t === needle),
    titled.filter(({ t }) => t.startsWith(needle)),
    titled.filter(({ t }) => t.includes(needle)),
  ];

  for (const tier of tiers) {
    if (tier.length === 1) return { kind: "match", window: tier[0]!.w, tied: [] };
    if (tier.length > 1) {
      // Several equally good matches, but if exactly one has focus the user is
      // looking at it, and that is a better answer than refusing.
      //
      // The losers are carried out with the winner. Resolving a tie silently makes a
      // successful capture indistinguishable from one where the title could only ever
      // name a single window, so a caller who wanted one of the OTHERS has no way to
      // learn that its query cannot express the difference — and repeats the same call
      // expecting a different picture.
      const focused = tier.filter(({ w }) => w.foreground);
      if (focused.length === 1) {
        return { kind: "match", window: focused[0]!.w, tied: tier.filter(({ w }) => !w.foreground).map(({ w }) => w) };
      }
      return { kind: "ambiguous", candidates: tier.map(({ w }) => w) };
    }
  }
  return { kind: "none", candidates: windows };
}

/**
 * Say that the capture was a tie decided by focus, and that repeating it will not
 * decide it differently (pure).
 *
 * Without this a tie-broken capture reads exactly like an unambiguous one. A caller
 * wanting one of the other windows sees a plain success, changes nothing, and calls
 * again — the same window comes back, because focus has not moved and nothing in the
 * result ever said that focus was what chose it. So this names the number, and names the
 * two things that would actually change the answer.
 */
export function tieNote(query: string | undefined, tied: WindowInfo[]): string {
  if (tied.length === 0) return "";
  const others = tied.length === 1 ? "1 other window" : `${tied.length} other windows`;
  return (
    ` ${others} match${tied.length === 1 ? "es" : ""} ${query ? `"${query}"` : "as well"} just as closely; ` +
    `this one had focus. Calling again will pick the same one — to reach another, focus it first ` +
    `or name a title only it has.`
  );
}

/**
 * What to say when the window cannot be decided (pure).
 *
 * With no title given, "ambiguous" only ever means that NO window had focus when the list
 * was taken (focus is briefly nowhere while it moves between windows). It used to read
 * `"(focused window)" matches 5 windows`, describing a search that never happened.
 */
export function ambiguousMessage(query: string | undefined, candidates: WindowInfo[]): string {
  if (!query) {
    return (
      `No window had focus at that moment, so there is no focused window to capture. ` +
      `Name the one you want:\n${listTitles(candidates)}`
    );
  }
  return (
    `"${query}" matches ${candidates.length} windows, so it is not clear which to capture. ` +
    `Name one more precisely:\n${listTitles(candidates)}`
  );
}

/** Render window titles for an error the model can act on without another call. */
export function listTitles(windows: WindowInfo[]): string {
  if (windows.length === 0) return "No capturable windows are open.";
  const shown = windows.slice(0, MAX_LISTED);
  const lines = shown.map((w) => `  - ${w.title}${w.foreground ? "  (focused)" : ""}`);
  const hidden = windows.length - shown.length;
  if (hidden > 0) lines.push(`  … and ${hidden} more`);
  return `Open windows:\n${lines.join("\n")}`;
}

/**
 * Whether a capture has to be confirmed before it happens.
 *
 * The session's own flag decides, exactly as it does for every mutating tool: a guarded
 * session asks, an auto-accept session does not. Prompting unconditionally made this the
 * one action that interrupted a mode chosen to stop interrupting, which is how a mode
 * stops being believed. What keeps that safe is the scope, not the prompt — one named
 * window, never the screen, and never from a context that has nobody to ask.
 */
export function needsApproval(ctx: Pick<ToolContext, "guarded">): boolean {
  return ctx.guarded === true;
}

export const screenshot: Tool = {
  name: "screenshot",
  deferred: true,
  // An observation: it changes nothing about the project. The privacy gate below is
  // explicit, and like every other gate it is the session's mode that decides whether
  // it asks.
  readOnly: true,
  description:
    "Take a picture of one open window and look at it. Use it to check that an app " +
    "actually came up and renders correctly — a running process is not proof of that — " +
    "or to see a layout, a chart, or an error dialog for yourself. " +
    "Pass `window` with part of the window's title; leave it out to capture the window " +
    "the user is currently focused on. For an app you just launched, or one with a custom " +
    "title bar that shows a blank OS title (common for desktop apps), omit `window` to grab " +
    "the focused window rather than guessing its title. " +
    "It photographs whatever that window is showing, so call it when looking will " +
    "genuinely tell you something, not as a routine check. " +
    "Windows only, one window at a time — the whole screen is never captured, and " +
    "nothing can be clicked or typed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      window: {
        type: "string",
        description:
          "Part of the target window's title, e.g. \"Vite\" or \"localhost\". " +
          "Omit to capture whichever window has focus.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const query = typeof args.window === "string" && args.window.trim() ? args.window.trim() : undefined;

    if (process.platform !== "win32") {
      return degrade(
        `Screenshots are Windows-only for now, and this is ${process.platform}. ` +
          `Ask the user to describe what they see, or check the app another way.`,
        "screenshot unsupported on this platform",
      );
    }

    // No way to ask means no capture. A sub-agent or a non-interactive run must not
    // silently inherit permission to photograph the user's desktop.
    if (!ctx.requestApproval) {
      return degrade(
        "Cannot take a screenshot from here: capturing the user's screen needs their " +
          "approval and there is no way to ask in this context. Ask the user to run it " +
          "in the main session, or verify another way.",
        "cannot ask to screenshot",
      );
    }

    let windows: WindowInfo[];
    let pick: WindowPick;
    try {
      // Listed ONCE, not waited on. A blocking wait for a named window punishes every
      // wrong name and every custom-title-bar app with the same multi-second stall, and
      // it does not actually solve the case it was built for: a just-launched app whose
      // title has not populated yet is not waited into existence either. The window is
      // there or it is not; if it is still coming up, the model is told to try again,
      // which is cheaper and does not freeze the turn.
      windows = await listWindows(ctx.abortSignal);
      pick = pickWindow(query, windows);
    } catch (error) {
      return fail(`Could not list open windows: ${message(error)}`);
    }

    if (pick.kind === "none") {
      return fail(
        query
          ? `No open window's title contains "${query}". ${listTitles(pick.candidates)}\n` +
              `Three things to try, in order: if you just launched the app, its window may need a ` +
              `moment — call again. If it has a custom title bar (many desktop apps, and Tauri or ` +
              `Electron with window decorations off, show a blank OS title), omit \`window\` to ` +
              `capture whichever window is focused. Or name one of the windows listed above. ` +
              `Do NOT capture a different named window as a stand-in: a picture of something else ` +
              `cannot tell you anything about "${query}".`
          : `There is no window to capture. ${listTitles(pick.candidates)}`,
      );
    }
    if (pick.kind === "ambiguous") return fail(ambiguousMessage(query, pick.candidates));

    const target = pick.window;
    // The window is resolved BEFORE this either way, so the user is never asked about a
    // capture that was never going to happen.
    if (needsApproval(ctx)) {
      const choice = await ctx.requestApproval(
        `Take a screenshot of "${target.title}"? The image is sent to the model.`,
        ["Yes, capture it", "No"],
      );
      if (!choice.startsWith("Yes")) {
        return degrade(
          `The user declined the screenshot of "${target.title}". Do not ask again for the ` +
            `same window; verify another way or ask them what they see.`,
          "screenshot declined",
        );
      }
    }

    try {
      const dir = await mkdtemp(join(tmpdir(), "mindweave-shot-"));
      const path = join(dir, `${safeName(target.title)}.png`);
      const size = await captureWindow(target.handle, path, ctx.abortSignal);
      const bytes = (await stat(path)).size;

      // The same validation a user's attachment goes through — caps and dimension
      // limits live in one place rather than being re-implemented per producer.
      const ref = await describeImage(path, bytes);
      if (isRejection(ref)) return fail(`Captured "${target.title}" but cannot use the image: ${ref.reason}`);

      return {
        output:
          `Captured "${target.title}" (${size.width}x${size.height}). ` +
          `The image follows this result — look at it and say what you see.` +
          tieNote(query, pick.tied),
        summary: `screenshot of ${target.title} (${size.width}x${size.height})`,
        // The facts about the capture itself, which the model's own output does not
        // carry: what was taken, how big it is, and WHEN — the timestamp is what tells
        // the user whether this is the state they just put the window into.
        detail: [
          `${size.width}×${size.height} • PNG • ${formatBytes(bytes)}`,
          `Captured: ${new Date().toTimeString().slice(0, 8)}`,
        ].join("\n"),
        images: [ref],
      };
    } catch (error) {
      return fail(`Could not capture "${target.title}": ${message(error)}`);
    }
  },
};

/** A window title, reduced to something safe to put in a filename. */
export function safeName(title: string): string {
  const cleaned = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned.toLowerCase() || "window";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Not an error: nothing broke and retrying will not change the answer. */
function degrade(output: string, summary: string): ToolResult {
  return { output, summary };
}

function fail(text: string): ToolResult {
  return { output: `Error: ${text}`, isError: true, summary: text.slice(0, 80) };
}
