/** hiddenDesktop.test.ts — which commands start an app where the user cannot see it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HIDDEN_MARK, runsFlaggedScript, wantsHiddenDesktop, windowArgs } from "./hiddenDesktop.js";

const IS_WINDOWS = process.platform === "win32";

test("runsFlaggedScript follows the package script a command runs, and the scripts it runs", () => {
  const scripts = {
    start: "electron . --remote-debugging-port=9222",
    dev: "npm run start",
    build: "tsc",
    web: "vite",
    tauri: "tauri",
    loop: "npm run loop",
  };
  assert.equal(runsFlaggedScript("npm start", scripts, 3), true);
  assert.equal(runsFlaggedScript("npm run dev", scripts, 3), true);
  assert.equal(runsFlaggedScript("pnpm dev", scripts, 3), true);
  assert.equal(runsFlaggedScript("cd app; yarn run start", scripts, 3), true);
  assert.equal(runsFlaggedScript("npm run build", scripts, 3), false);
  assert.equal(runsFlaggedScript("npm run web", scripts, 3), false);
  assert.equal(runsFlaggedScript("npm install", scripts, 3), false);
  // A script that runs itself ends at the depth limit instead of looping.
  assert.equal(runsFlaggedScript("npm run loop", scripts, 3), false);
});

test("the WebView2 variable counts, in a script as in a command", () => {
  const scripts = { app: "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222&& tauri dev" };
  assert.equal(runsFlaggedScript("npm run app", scripts, 3), true);
});

test("a hidden-desktop handle carries the desktop to the script; a plain one does not", () => {
  assert.deepEqual(windowArgs("123"), { handle: "123", desktop: [] });
  const hidden = windowArgs(`${HIDDEN_MARK}456`);
  assert.equal(hidden.handle, "456");
  assert.equal(hidden.desktop[0], "-Desktop");
  assert.match(hidden.desktop[1]!, /^mindweave-\d+$/);
});

test("wantsHiddenDesktop: the test flags, the package script, and the explicit choice", { skip: !IS_WINDOWS && "Windows only" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mw-hidden-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "electron . --remote-debugging-port=9222", web: "vite" } }));
    assert.equal(wantsHiddenDesktop("npx electron . --remote-debugging-port=9222", dir), true);
    assert.equal(wantsHiddenDesktop('$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"; npm run tauri dev', dir), true);
    assert.equal(wantsHiddenDesktop("npm start", dir), true);
    assert.equal(wantsHiddenDesktop("npm run web", dir), false);
    assert.equal(wantsHiddenDesktop("git status", dir), false);
    // The agent's own choice wins both ways: false for an app the user asked to see.
    assert.equal(wantsHiddenDesktop("npm start", dir, false), false);
    assert.equal(wantsHiddenDesktop("dotnet run", dir, true), true);
    // No package.json is simply no script to follow.
    assert.equal(wantsHiddenDesktop("npm start", join(dir, "missing")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
