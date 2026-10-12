/**
 * clipboard.test.ts — which local command owns the clipboard on each kind of machine, and how the terminal route is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { helpers, osc52 } from "./clipboard.js";

const names = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] => helpers(platform, env).map((h) => h.command);

test("Windows and macOS have one helper each", () => {
  assert.deepEqual(names("win32", {}), ["clip"]);
  assert.deepEqual(names("darwin", {}), ["pbcopy"]);
});

test("Linux tries the helper for the display it is on first, and the other kind after", () => {
  assert.deepEqual(names("linux", { WAYLAND_DISPLAY: "wayland-0" }), ["wl-copy", "xclip", "xsel"]);
  assert.deepEqual(names("linux", { DISPLAY: ":0" }), ["xclip", "xsel", "wl-copy"]);
  assert.ok(names("linux", {}).includes("xclip"), "an X11 helper is tried even from a minimal environment");
});

test("the xclip and xsel arguments select the CLIPBOARD, not the primary selection", () => {
  const list = helpers("linux", { DISPLAY: ":0" });
  assert.deepEqual(list.find((h) => h.command === "xclip")!.args, ["-selection", "clipboard"]);
  assert.deepEqual(list.find((h) => h.command === "xsel")!.args, ["--clipboard", "--input"]);
});

test("over SSH there is no local helper: it would fill the clipboard of a machine nobody is sitting at", () => {
  for (const env of [{ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }, { SSH_TTY: "/dev/pts/0" }, { SSH_CLIENT: "1.2.3.4 22 22" }]) {
    for (const platform of ["darwin", "linux", "win32"] as const) assert.deepEqual(helpers(platform, env), [], `${platform} ${Object.keys(env)[0]}`);
  }
});

test("the terminal sequence carries the text as base64 for the clipboard", () => {
  assert.equal(osc52("hi", {}), "\x1b]52;c;aGk=\x07");
});

test("inside tmux the sequence is wrapped so it gets past tmux, with every escape doubled", () => {
  const wrapped = osc52("hi", { TMUX: "/tmp/tmux-1000/default,1,0" });
  assert.equal(wrapped, "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
});
