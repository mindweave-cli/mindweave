/**
 * uiPage.test.ts — the page route of `ui`.
 *
 * Two halves. The pure parts (keys, addresses, target choice, argument rules, what the
 * model is told) are tested directly. Then the real thing: a hidden browser opens a page
 * built to contain the problems this route exists to find (a button under an overlay, a
 * console error, an unnamed icon button, a confirm dialog, a link that opens a new tab, a
 * list longer than the screen) and the tool is driven through it the way the model
 * drives it. That half needs a Chromium-family browser and skips when none is installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolContext } from "./types.js";
import { isLocalUrl, parseKey, shortUrl } from "./uiPage.js";
import { pageTargets, type CdpTarget } from "./cdp.js";
import { browserCandidates, findBrowser, parseActivePort } from "./browser.js";
import { describeAction, normalizeUrl, pageReports, parseUiArgs, ui, uiLiveState } from "./ui.js";
import { toolDisplay } from "../cli/toolDisplay.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [], ...overrides } as ToolContext;
}

// ── keys ─────────────────────────────────────────────────────────────────────

test("parseKey: named keys type their character only without Ctrl/Alt/Meta", () => {
  assert.deepEqual(parseKey("Enter"), { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
  assert.deepEqual(parseKey("escape"), { key: "Escape", code: "Escape", keyCode: 27, text: undefined, modifiers: 0 });
  assert.equal(parseKey("Shift+Tab")!.modifiers, 8);
  assert.equal(parseKey("Space")!.code, "Space");
});

test("parseKey: letters, digits, combinations and function keys", () => {
  assert.deepEqual(parseKey("Ctrl+A"), { key: "a", code: "KeyA", keyCode: 65, text: undefined, modifiers: 2 });
  assert.deepEqual(parseKey("Shift+a"), { key: "A", code: "KeyA", keyCode: 65, text: "A", modifiers: 8 });
  assert.equal(parseKey("7")!.code, "Digit7");
  assert.equal(parseKey("F5")!.keyCode, 116);
  assert.equal(parseKey("Hyper+X"), null);
  assert.equal(parseKey("NotAKey"), null);
});

// ── addresses and targets ────────────────────────────────────────────────────

test("normalizeUrl adds http to a bare dev-server address and refuses other schemes", () => {
  assert.equal(normalizeUrl("localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeUrl("127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl(""), null);
});

test("isLocalUrl tells this machine from the open web", () => {
  assert.equal(isLocalUrl("http://localhost:5173/"), true);
  assert.equal(isLocalUrl("http://127.0.0.1:8080/x"), true);
  assert.equal(isLocalUrl("file:///C:/site/index.html"), true);
  assert.equal(isLocalUrl("https://example.com/"), false);
  assert.equal(shortUrl("http://localhost:5173/library?x=1"), "localhost:5173/library");
});

test("pageTargets keeps real pages and drops DevTools, workers and extensions", () => {
  const t = (type: string, url: string, ws = true): CdpTarget => ({ id: url, type, title: url, url, webSocketDebuggerUrl: ws ? "ws://127.0.0.1:1/x" : undefined });
  const kept = pageTargets([
    t("page", "http://localhost:5173/"),
    t("page", "devtools://devtools/bundled/inspector.html"),
    t("service_worker", "http://localhost:5173/sw.js"),
    t("page", "chrome-extension://abc/popup.html"),
    t("page", "tauri://localhost", false),
  ]);
  assert.deepEqual(kept.map((k) => k.url), ["http://localhost:5173/"]);
});

test("browserCandidates: an override wins, and each platform has its usual places", () => {
  assert.deepEqual(browserCandidates("win32", { MINDWEAVE_BROWSER: "C:/b.exe" }), ["C:/b.exe"]);
  const win = browserCandidates("win32", { "PROGRAMFILES(X86)": "C:\\PF86", PROGRAMFILES: "C:\\PF" });
  assert.ok(win[0]!.endsWith("Microsoft\\Edge\\Application\\msedge.exe"));
  assert.ok(win.some((p) => p.includes("Google\\Chrome")));
  assert.ok(browserCandidates("darwin", {}).some((p) => p.includes("Google Chrome.app")));
  assert.ok(browserCandidates("linux", { PATH: "/usr/bin" }).some((p) => p.endsWith("chromium")));
  assert.equal(parseActivePort("53211\n/devtools/browser/abc\n"), 53211);
  assert.equal(parseActivePort(""), null);
});

// ── arguments and what the model is told ─────────────────────────────────────

test("parseUiArgs: the page route's own rules", () => {
  assert.equal(parseUiArgs({ action: "look", url: "localhost:5173" }).ok, true);
  assert.equal(parseUiArgs({ action: "look", port: "9222" }).ok, true);
  assert.equal(parseUiArgs({ action: "look", url: "http://x", port: 9222 }).ok, false);
  assert.equal(parseUiArgs({ action: "look", url: "http://x", window: "App" }).ok, false);
  assert.equal(parseUiArgs({ action: "look", port: 70000 }).ok, false);
  assert.equal(parseUiArgs({ action: "key" }).ok, false);
  assert.equal(parseUiArgs({ action: "key", key: "Enter" }).ok, true);
  assert.equal(parseUiArgs({ action: "hover" }).ok, false);
  assert.equal(parseUiArgs({ action: "back" }).ok, true);
});

test("describeAction covers keys, hover and a dropdown pick", () => {
  assert.equal(describeAction("key", '[2] text box "Search"', "", "down", "pressed", "Enter"), 'Pressed Enter in [2] text box "Search".');
  assert.equal(describeAction("key", "", "", "down", "pressed", "Escape"), "Pressed Escape.");
  assert.equal(describeAction("hover", '[3] button "Menu"', "", "down"), 'Hovering over [3] button "Menu".');
  assert.equal(describeAction("type", '[4] dropdown "Sort"', "Name", "down", 'picked "Name"'), 'Picked "Name" in [4] dropdown "Sort".');
  assert.equal(describeAction("scroll", "", "", "down", "scrolled"), "Scrolled down.");
});

test("pageReports lists the page's errors and dialogs, and is empty when there are none", () => {
  assert.equal(pageReports({ windows: [], controls: [], texts: [], more: 0 }), "");
  const text = pageReports({ windows: [], controls: [], texts: [], more: 0, errors: ["TypeError: x is undefined (app.js:3)"], dialogs: ['confirm dialog: "Delete?" (accepted)'] });
  assert.match(text, /reported 1 error since the last step:\n {2}- TypeError/);
  assert.match(text, /A confirm dialog: "Delete\?" \(accepted\)\./);
});

test("the window route says which route can press keys instead of trying", async () => {
  if (process.platform !== "win32") return;
  const result = await ui.execute({ action: "key", key: "Enter" }, ctx({ requestApproval: async () => "Yes" }));
  assert.equal(result.isError, true);
  assert.match(result.output, /needs the page route/);
  assert.match(result.output, /remote-debugging-port/);
});

test("rows name the page actions", () => {
  assert.deepEqual(toolDisplay("ui", { action: "look", url: "http://localhost:5173/" }), { name: "Look", arg: "localhost:5173", kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "look", port: 9222 }), { name: "Look", arg: "port 9222", kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "key", key: "Enter", target: 2 }), { name: "Key", arg: "Enter #2", kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "hover", target: 3 }), { name: "Hover", arg: "#3", kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "back" }), { name: "Back", kind: "screenshot" });
});

// ── the real thing ───────────────────────────────────────────────────────────

const FIXTURE = `<!doctype html><html><head><title>Fixture Shop</title>
<style>
  #overlay { position: fixed; left: 0; top: 0; width: 400px; height: 60px; background: transparent; }
  .long { height: 30px; }
</style></head><body>
<div style="height:70px"><button id="buy" onclick="setStatus('bought')">Buy</button></div>
<div id="overlay"></div>
<input id="q" aria-label="Search" onkeydown="if (event.key === 'Enter') setStatus('searched ' + this.value)">
<button onclick="setStatus('settings')"><svg width="12" height="12"><circle cx="6" cy="6" r="5"/></svg></button>
<select aria-label="Sort" onchange="setStatus('sorted by ' + this.value)"><option value="date">Date</option><option value="name">Name</option></select>
<button onclick="if (confirm('Delete everything?')) setStatus('deleted')">Delete</button>
<button onclick="undefinedFunction()">Broken</button>
<a href="about:blank#next" target="_blank">Open help</a>
<input type="password" aria-label="Password">
<p id="status">status: idle</p>
<div>${Array.from({ length: 40 }, (_, i) => `<div class="long"><button onclick="setStatus('item ${i + 1}')">Item ${i + 1}</button></div>`).join("")}</div>
<script>function setStatus(s) { document.getElementById('status').textContent = 'status: ' + s; }</script>
</body></html>`;

const browser = findBrowser();

test("drives a real page end to end in a hidden browser", { skip: browser ? false : "no Chromium-family browser installed", timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uipage-test-"));
  const file = join(dir, "shop.html");
  await writeFile(file, FIXTURE, "utf8");
  // A sub-agent context (no approval channel): the page route is allowed there.
  const c = ctx();
  let r = await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
  let listed = r.output;
  try {
    const num = (name: string): number => {
      // A step that changed nothing says so instead of repeating the list, so the numbers come from the last list sent.
      if (/\n\s*\[1\] /.test(r.output)) listed = r.output;
      for (const line of listed.split("\n")) {
        const m = /^\s*\[(\d+)\] [^"]*"([^"]*)"/.exec(line);
        if (m && m[2] === name) return Number(m[1]);
      }
      throw new Error(`no control named ${name} in:\n${listed}`);
    };
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /Page "Fixture Shop"/);
    assert.match(r.output, /status: idle/, "text on screen reaches the model");
    assert.match(r.output, /\(no name\)/, "the icon-only button is called out");
    assert.match(r.output, /1 control has no name/);
    assert.match(r.output, /"Item 40" \(out of view\)/, "items past the fold are listed");
    assert.match(r.output, /password: never typed into/);
    assert.ok(r.images?.length === 1, "a picture comes back");

    // The Buy button sits under a transparent overlay: a person could not click it.
    r = await ui.execute({ action: "click", target: num("Buy") }, c);
    assert.equal(r.isError, true);
    assert.match(r.output, /covered by <div id="overlay">/);

    // Typing and pressing Enter.
    r = await ui.execute({ action: "type", target: num("Search"), text: "halo" }, c);
    assert.match(r.output, /text box "Search" = "halo"/);
    r = await ui.execute({ action: "key", key: "Enter", target: num("Search") }, c);
    assert.match(r.output, /status: searched halo/);

    // A dropdown: the option is picked by its text.
    r = await ui.execute({ action: "type", target: num("Sort"), text: "Name" }, c);
    assert.match(r.output, /Picked "Name"/);
    assert.match(r.output, /status: sorted by name/);

    // A confirm dialog is answered and reported.
    r = await ui.execute({ action: "click", target: num("Delete") }, c);
    assert.match(r.output, /confirm dialog: "Delete everything\?" \(accepted\)/);
    assert.match(r.output, /status: deleted/);

    // A button whose handler throws: the page's own error comes back.
    r = await ui.execute({ action: "click", target: num("Broken") }, c);
    assert.match(r.output, /reported 1 error/);
    assert.match(r.output, /undefinedFunction is not defined/);
    assert.match(r.summary ?? "", /1 page error/);

    // Out of view: clicking scrolls it into view and presses it.
    r = await ui.execute({ action: "click", target: num("Item 40") }, c);
    assert.match(r.output, /status: item 40/);

    // A password field is refused before anything is typed.
    r = await ui.execute({ action: "type", target: num("Password"), text: "hunter2" }, c);
    assert.equal(r.isError, true);
    assert.match(r.output, /password field/);

    // A compaction: the model no longer has the list, so its numbers must not be trusted.
    const after = uiLiveState(c);
    assert.match(after ?? "", /still has "Fixture Shop"/);
    r = await ui.execute({ action: "click", target: 1 }, c);
    assert.equal(r.isError, true);
    assert.match(r.output, /Look at the page first/);

    // A link that opens a new tab: the tool follows it.
    r = await ui.execute({ action: "look" }, c);
    r = await ui.execute({ action: "click", target: num("Open help") }, c);
    assert.match(r.output, /opened a new page/);
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});

test("scrolling works in an app whose content scrolls inside a panel, not the page", { skip: browser ? false : "no Chromium-family browser installed", timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uipage-test-"));
  const file = join(dir, "panel.html");
  const rows = Array.from({ length: 80 }, (_, i) => `<p>Message ${i + 1}</p>`).join("");
  await writeFile(file, `<!doctype html><title>Panel</title><body style="margin:0;height:100vh;overflow:hidden"><div id="chat" style="height:100vh;overflow-y:auto">${rows}</div></body>`, "utf8");
  const c = ctx();
  try {
    let r = await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
    assert.match(r.output, /Scrolled 0 of \d+px; there is more below/, "the panel's scroll is reported, not the page's");
    r = await ui.execute({ action: "scroll", direction: "down" }, c);
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /^Scrolled down\./);
    assert.match(r.output, /Scrolled [1-9]\d* of/);
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});
