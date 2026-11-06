/**
 * updateWait.probe.test.tsx — the screen shown while /update installs.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { UpdateWait, clock } from "./components/UpdateWait.js";

test("the running time reads m:ss", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(42.9), "0:42");
  assert.equal(clock(125), "2:05");
  assert.equal(clock(-3), "0:00");
});

test("the screen tells the person to wait and not to touch anything", () => {
  const out: string[] = [];
  const stream = {
    write: (s: string) => void out.push(s),
    columns: 88, rows: 30, on: () => {}, off: () => {}, removeListener: () => {},
  } as unknown as NodeJS.WriteStream;
  const app = render(<UpdateWait rows={30} version="3.5.0" current=" v3.4.5" startedAt={Date.now() - 42_000} />, {
    stdout: stream, patchConsole: false, interactive: true,
  });
  app.unmount();
  const ESC = String.fromCharCode(27);
  const text = out.join("").replace(new RegExp(ESC + "\[[0-9;?]*[A-Za-z]", "g"), "").replace(/\s+/g, " ");
  assert.match(text, /Updating Mindweave to v3\.5\.0/);
  assert.match(text, /Please wait/);
  assert.match(text, /Do not close the app and do not press anything/);
  assert.match(text, /comes back here by itself, ready to use/);
  assert.match(text, /Installing v3\.5\.0/);
  assert.match(text, /0:4\d/, "the running time is shown");
});

test("while the wait screen is up, the chat's keys are off and the screen is a gate", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok(
    src.indexOf("if (updating) {") > 0 && src.indexOf("if (updating) {") < src.indexOf("if (trustOpen) {"),
    "the wait screen must be a gate, like the others",
  );
  const handlers = src.match(/isActive: ready && overlay === null[^}]*\}/g) ?? [];
  assert.ok(handlers.length >= 2);
  for (const h of handlers) assert.match(h, /updating === null/, "a key handler still listens during the update: " + h);
});

test("an installed update shows as a tag at the right end of the status row, not as a chat line", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("↑ v${updateReady} ready · /update, or restart it yourself"), "names the version and both ways to restart");
  assert.ok(!/backgroundColor={ACCENT}/.test(src), "the tag is green text, not a filled block");
  assert.ok(!src.includes("is already installed. Restart into it now?"), "an installed update is not asked about again");
  assert.match(src, /updateReady && \(!busy \|\| width >= 100\)/, "the tag is shown while idle, and on a wide screen while working");
  assert.ok(!/is installed\. Type \/update/.test(src), "the one-time chat line came back");
  assert.match(src, /stagedAhead\(readLauncherState\(\), appVersion\(\)\)/, "a copy staged by another window shows at start, not half a minute later");
});
