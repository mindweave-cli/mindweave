/**
 * screenshot.test.ts — window matching, list parsing, and the refusal paths.
 *
 * Nothing here opens a window. The capture itself is Win32 talking to a live
 * desktop and CI has no interactive session, so mocking it would only assert the
 * mock. What IS tested is everything that decides WHICH window gets photographed
 * and whether the tool proceeds at all — the part where a mistake is a privacy
 * event rather than a wrong answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import { parseWindowList, type WindowInfo } from "./screenshotWin.js";
import { ambiguousMessage, pickWindow, listTitles, safeName, screenshot, needsApproval, tieNote } from "./screenshot.js";

function win(title: string, handle = "1", foreground = false): WindowInfo {
  return { handle, title, foreground };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [], ...overrides } as ToolContext;
}

const IS_WINDOWS = process.platform === "win32";

// ── parseWindowList ──────────────────────────────────────────────────────────

test("parseWindowList reads handles, titles and the focus marker", () => {
  const windows = parseWindowList("-123\tVS Code\r\n*456\tGoogle Chrome\r\n");
  assert.deepEqual(windows, [
    { handle: "123", title: "VS Code", foreground: false },
    { handle: "456", title: "Google Chrome", foreground: true },
  ]);
});

test("parseWindowList skips anything that isn't a window line", () => {
  // PowerShell can put a warning or a blank line on stdout; neither is a window,
  // and guessing at a malformed line is how a wrong handle gets captured.
  const windows = parseWindowList("WARNING: something\n\n-7\tReal Window\nnot-a-handle\ttitle\n-8\t\n");
  assert.deepEqual(
    windows.map((w) => w.title),
    ["Real Window"],
  );
});

test("parseWindowList keeps tabs out of titles but not spaces", () => {
  const windows = parseWindowList("-9\tmy app — main window\n");
  assert.equal(windows[0]!.title, "my app — main window");
});

// ── pickWindow ───────────────────────────────────────────────────────────────

test("pickWindow with no query takes the focused window", () => {
  const pick = pickWindow(undefined, [win("Chrome", "1"), win("Editor", "2", true)]);
  assert.equal(pick.kind, "match");
  assert.equal(pick.kind === "match" && pick.window.title, "Editor");
});

test("pickWindow prefers an exact title over a longer window that contains it", () => {
  // The real case: "Mindweave" must not lose to "Mindweave — Settings" just
  // because both contain the word.
  const pick = pickWindow("mindweave", [win("Mindweave — Settings", "1"), win("Mindweave", "2")]);
  assert.equal(pick.kind === "match" && pick.window.title, "Mindweave");
});

test("pickWindow prefers a prefix over a mid-string match", () => {
  const pick = pickWindow("vite", [win("My App - vite dev server", "1"), win("Vite + React", "2")]);
  assert.equal(pick.kind === "match" && pick.window.title, "Vite + React");
});

test("pickWindow matches case-insensitively on a substring", () => {
  const pick = pickWindow("LOCALHOST", [win("app — localhost:5173", "1"), win("Notes", "2")]);
  assert.equal(pick.kind === "match" && pick.window.handle, "1");
});

test("pickWindow refuses to guess between equally good matches", () => {
  const pick = pickWindow("chrome", [win("Chrome — A", "1"), win("Chrome — B", "2")]);
  assert.equal(pick.kind, "ambiguous");
  assert.equal(pick.kind === "ambiguous" && pick.candidates.length, 2);
});

test("pickWindow breaks a tie toward the window the user is looking at", () => {
  const pick = pickWindow("chrome", [win("Chrome — A", "1"), win("Chrome — B", "2", true)]);
  assert.equal(pick.kind === "match" && pick.window.handle, "2");
});

test("a tie-broken match carries the windows it beat", () => {
  // Otherwise a capture decided by focus is indistinguishable from one where the title
  // named a single window, and a caller after a DIFFERENT window has nothing telling it
  // that its query cannot express the difference.
  const pick = pickWindow("chrome", [win("Chrome — A", "1"), win("Chrome — B", "2", true)]);
  assert.deepEqual(pick.kind === "match" && pick.tied.map((w) => w.handle), ["1"]);
});

test("an unambiguous match beat nothing", () => {
  const pick = pickWindow("editor", [win("Chrome", "1"), win("Editor", "2")]);
  assert.deepEqual(pick.kind === "match" && pick.tied, []);
});

test("the tie is reported in the result, with what would change it", () => {
  // The observed failure: five identical calls in a row, each returning the same window,
  // because a plain "Captured …" gave the caller no reason to do anything differently.
  const note = tieNote("Changelog", [win("Changelog — Chrome", "1"), win("Changelog — Chrome", "2")]);
  assert.match(note, /2 other windows/);
  assert.match(note, /Calling again will pick the same one/);
  assert.match(note, /focus it first|name a title only it has/);
});

test("no tie, no note", () => {
  assert.equal(tieNote("editor", []), "");
});

test("pickWindow reports no match with the candidates it did see", () => {
  const pick = pickWindow("photoshop", [win("Chrome", "1"), win("Editor", "2")]);
  assert.equal(pick.kind, "none");
  assert.equal(pick.kind === "none" && pick.candidates.length, 2);
});

test("pickWindow reports none when nothing is open at all", () => {
  assert.equal(pickWindow("anything", []).kind, "none");
  assert.equal(pickWindow(undefined, []).kind, "none");
});

// ── listTitles / safeName ────────────────────────────────────────────────────

test("listTitles names the focused window and caps a long list", () => {
  const many = Array.from({ length: 15 }, (_, i) => win(`Window ${i}`, String(i), i === 0));
  const text = listTitles(many);
  assert.match(text, /Window 0 {2}\(focused\)/);
  assert.match(text, /… and 3 more/);
});

test("safeName turns a window title into a usable filename", () => {
  assert.equal(safeName("Vite + React — localhost:5173"), "vite-react-localhost-5173");
  assert.equal(safeName("///"), "window");
  assert.ok(safeName("x".repeat(200)).length <= 40);
});

// ── the tool's refusal paths ─────────────────────────────────────────────────
//
// The two permission-flow tests below are Windows-specific by construction, not by
// accident. Off Windows the tool refuses at its FIRST line — capture is a Win32
// path and there is nothing to fall back to — so the approval channel and the
// window matcher are never reached and neither assertion can hold. Running them
// anyway produced a red suite on Linux that said nothing about the product. The
// non-Windows behaviour gets its own test rather than being left uncovered.

test("screenshot refuses when there is no way to ask permission", async (t) => {
  if (!IS_WINDOWS) {
    t.skip("the approval path is only reached on Windows; see the platform-refusal test");
    return;
  }
  // A sub-agent or a non-interactive run has no approval channel. It must not
  // inherit permission to photograph the desktop by default.
  const result = await screenshot.execute({ window: "anything" }, ctx());
  assert.equal(result.isError, undefined); // nothing broke; retrying won't help
  assert.match(result.output, /needs their approval/);
});

test("screenshot does not capture when the user says no", async (t) => {
  if (!IS_WINDOWS) {
    t.skip("window matching is only reached on Windows; see the platform-refusal test");
    return;
  }
  let captured = false;
  const result = await screenshot.execute(
    { window: "definitely-no-such-window-xyzzy" },
    ctx({
      requestApproval: async () => {
        captured = true;
        return "No";
      },
    }),
  );
  // The window never matched, so approval was never even reached — which is the
  // ordering that matters: no window is named to the user before it is resolved.
  assert.equal(captured, false);
  assert.equal(result.isError, true);
});

test("off Windows, screenshot degrades before asking for anything", async (t) => {
  if (IS_WINDOWS) {
    t.skip("this is the non-Windows path");
    return;
  }
  let asked = false;
  const result = await screenshot.execute(
    { window: "anything" },
    ctx({
      requestApproval: async () => {
        asked = true;
        return "Yes";
      },
    }),
  );
  // Degrading, not erroring: an unsupported platform is a fact about the machine,
  // not a mistake the model should retry or work around.
  assert.equal(asked, false, "the user must not be prompted for a capture that cannot happen");
  assert.equal(result.isError, undefined);
  assert.match(result.output, /Windows-only/);
});

test("screenshot is offered as a read-only tool", () => {
  assert.equal(screenshot.readOnly, true);
});

test("only a guarded session is asked before a capture", () => {
  // Auto-accept means auto-accept. A tool that prompted anyway made the mode a
  // promise the app did not keep, and the user had to answer for every look at a
  // window they had asked it to check.
  assert.equal(needsApproval({ guarded: true }), true);
  assert.equal(needsApproval({ guarded: false }), false);
  assert.equal(needsApproval({}), false, "a context with no mode set is the default one");
});

// ── Waiting for a window that is still opening ───────────────────────────────

test("a named window that appears late is still found", async () => {
  // The case this exists for: a browser is launched and asked for in the same breath.
  // Start-Process returns at once and the window is drawn a second or two later, so a
  // single listing sees nothing and the model's workaround — capturing some OTHER
  // window — produces a picture that says nothing about what it was asked to check.
  let calls = 0;
  const windows = () => {
    calls++;
    return calls < 3 ? [{ handle: "1", title: "Editor", foreground: true }] : [
      { handle: "1", title: "Editor", foreground: false },
      { handle: "2", title: "mockup.html - Chrome", foreground: true },
    ];
  };

  // The wait is a loop around pickWindow, so this asserts the shape it depends on:
  // "none" while absent, a match once present.
  assert.equal(pickWindow("mockup", windows()).kind, "none");
  assert.equal(pickWindow("mockup", windows()).kind, "none");
  const found = pickWindow("mockup", windows());
  assert.equal(found.kind, "match");
  assert.equal(found.kind === "match" && found.window.title, "mockup.html - Chrome");
});

test("giving up says NOT to capture a different window, and offers the focused-window path", async (t) => {
  if (!IS_WINDOWS) {
    t.skip("window listing is only reached on Windows");
    return;
  }
  // The failure that let a wrong-window capture be reported as a real check. The error
  // has to close that door explicitly, because the model's instinct is to substitute —
  // and it must point at the escape hatch that actually works for a custom-title-bar app:
  // omit `window` to capture the focused one.
  const result = await screenshot.execute({ window: "nothing-like-this-xyzzy" }, {
    cwd: process.cwd(),
    requestApproval: async () => "Yes, capture it",
    autoAccept: true,
  } as never);
  assert.equal(result.isError, true);
  assert.match(result.output, /do NOT capture a different named window/i);
  assert.match(result.output, /omit `window`|focused/i);
});

test("with no window named and none focused, the message says that instead of a fake match count", () => {
  // Real session: `screenshot {}` came back as `"(focused window)" matches 5 windows`.
  const pick = pickWindow(undefined, [win("Manicule", "1"), win("cmd.exe", "2")]);
  assert.equal(pick.kind, "ambiguous");
  const text = ambiguousMessage(undefined, pick.kind === "ambiguous" ? pick.candidates : []);
  assert.match(text, /No window had focus/);
  assert.match(text, /Manicule/);
  assert.doesNotMatch(text, /\(focused window\)" matches/);
});

test("a named query that matches several windows still says how many", () => {
  assert.match(ambiguousMessage("vite", [win("Vite A", "1"), win("Vite B", "2")]), /"vite" matches 2 windows/);
});
