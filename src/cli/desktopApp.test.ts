import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_PAGE_URL, appAnnouncement, browserCommand, openInBrowser } from "./desktopApp.js";

test("the session-start line names the command to run and says it is free and open source", () => {
  const line = appAnnouncement();
  assert.match(line, /\/app/);
  assert.match(line, /Windows, macOS and Linux/);
  assert.match(line, /free and open source/);
});

test("each system opens a link with its own command", () => {
  assert.deepEqual(browserCommand("win32", "https://x.test/"), { cmd: "cmd", args: ["/c", "start", "", "https://x.test/"] });
  assert.deepEqual(browserCommand("darwin", "https://x.test/"), { cmd: "open", args: ["https://x.test/"] });
  assert.deepEqual(browserCommand("linux", "https://x.test/"), { cmd: "xdg-open", args: ["https://x.test/"] });
});

test("openInBrowser launches the page detached, and never anything but https", () => {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const fake = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  }) as never;
  assert.equal(openInBrowser(APP_PAGE_URL, "linux", fake), true);
  assert.equal(calls[0]!.cmd, "xdg-open");
  assert.equal(calls[0]!.opts.detached, true);
  assert.equal(calls[0]!.opts.stdio, "ignore");
  assert.equal(openInBrowser("http://insecure.test/", "linux", fake), false);
  assert.equal(openInBrowser("file:///etc/passwd", "linux", fake), false);
  assert.equal(openInBrowser("javascript:alert(1)", "linux", fake), false);
  assert.equal(calls.length, 1, "nothing but the https link was launched");
});

test("a machine that cannot launch a browser gets false instead of an exception", () => {
  const boom = (() => {
    throw new Error("no such command");
  }) as never;
  assert.equal(openInBrowser(APP_PAGE_URL, "linux", boom), false);
});
