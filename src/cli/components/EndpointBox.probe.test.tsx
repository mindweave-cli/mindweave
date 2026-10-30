/**
 * EndpointBox.probe.test.tsx — the custom endpoint's box in the terminal, driven with real keystrokes.
 *
 * What it pins: every setting is reachable by Enter on its row, a typed value reaches the function that saves it (and only
 * then), the key is typed hidden and never drawn, an empty key is not "remove the key", the saved-key row exists only when
 * there is a key, and "remove everything" asks first.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import React from "react";
const { render, Box } = await import("ink");
const { EndpointBox } = await import("./EndpointBox.js");
import type { EndpointFields, EndpointPatch, EndpointResult } from "./EndpointBox.js";

class FakeStdout extends EventEmitter {
  columns = 90;
  rows = 30;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/** A stdin Ink accepts for raw mode, with keystrokes pulled by `read()` the way Ink 7 takes them. */
class FakeStdin extends EventEmitter {
  isTTY = true as const;
  setRawMode() { return this; }
  ref() { return this; }
  unref() { return this; }
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
  private readonly queue: string[] = [];
  read(): string | null { return this.queue.shift() ?? null; }
  type(s: string): void { this.queue.push(s); this.emit("readable"); }
}

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const base: EndpointFields = { address: "", hasKey: false, models: "", window: "", defaultWindow: 128000, connected: false, modelCount: 0 };

interface Rig {
  saved: EndpointPatch[];
  checked: number;
  forgotten: number;
  closed: number;
  fields: EndpointFields;
  press(...keys: string[]): Promise<void>;
  typeText(text: string): Promise<void>;
  screen(): string;
  allFrames(): string;
  stop(): void;
}

function rig(initial: Partial<EndpointFields> = {}, answer: EndpointResult = { ok: true, message: "saved · connected: 2 models" }): Rig {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const r: Rig = {
    saved: [],
    checked: 0,
    forgotten: 0,
    closed: 0,
    fields: { ...base, ...initial },
    async press(...keys) {
      for (const k of keys) {
        stdin.type(k);
        await tick();
      }
    },
    async typeText(text) {
      for (const ch of text) {
        stdin.type(ch);
        await tick(4);
      }
      await tick();
    },
    screen: () => (stdout.frames[stdout.frames.length - 1] ?? "").replace(ANSI, ""),
    allFrames: () => stdout.frames.join("\n").replace(ANSI, ""),
    stop: () => instance.unmount(),
  };
  const instance = render(
    <Box flexDirection="column" width={86}>
      <EndpointBox
        title="Custom endpoint"
        read={() => r.fields}
        onSave={async (patch) => {
          r.saved.push(patch);
          return answer;
        }}
        onCheck={async () => {
          r.checked++;
          return { ok: true, message: "connected: 2 models" };
        }}
        onForget={async () => {
          r.forgotten++;
          return { ok: true, message: "removed" };
        }}
        onClose={() => {
          r.closed++;
        }}
        width={86}
        maxRows={9}
      />
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, interactive: true, debug: true },
  );
  return r;
}

test("the list shows each setting and whether the server is connected", async () => {
  const r = rig({ address: "https://api.together.xyz/v1", hasKey: true, models: "a,b", window: "64000", connected: true, modelCount: 3 });
  await tick();
  const out = r.screen();
  assert.match(out, /Custom endpoint · connected, 3 models/);
  assert.match(out, /Address\s+https:\/\/api\.together\.xyz\/v1/);
  assert.match(out, /Key\s+saved/);
  assert.match(out, /Model ids\s+a, b/);
  assert.match(out, /Window\s+64000/);
  assert.match(out, /Remove the saved key/);
  assert.match(out, /Check the server again/);
  assert.match(out, /Remove everything/);
  r.stop();
});

test("with nothing set the box says so, shows the assumed window, and has no remove-the-key row", async () => {
  const r = rig();
  await tick();
  const out = r.screen();
  assert.match(out, /not connected/);
  assert.match(out, /Address\s+not set/);
  assert.match(out, /Key\s+none/);
  assert.match(out, /128,000 \(assumed\)/);
  assert.doesNotMatch(out, /Remove the saved key/);
  r.stop();
});

test("Enter on Address opens a field, and what is typed reaches the save function as the address", async () => {
  const r = rig();
  await r.press("\r"); // the first row is Address
  assert.match(r.screen(), /Custom endpoint · Address/);
  await r.typeText("https://gw.example.test/v1");
  await r.press("\r");
  await tick(60);
  assert.deepEqual(r.saved, [{ address: "https://gw.example.test/v1" }]);
  assert.match(r.screen(), /saved · connected: 2 models/, "and the box says how it went");
  r.stop();
});

test("the key is typed hidden, saved, and never drawn", async () => {
  const r = rig();
  await r.press(DOWN, "\r"); // the second row is Key
  assert.match(r.screen(), /Custom endpoint · Key/);
  await r.typeText("sk-secret-value");
  await r.press("\r");
  await tick(60);
  assert.deepEqual(r.saved, [{ key: "sk-secret-value" }]);
  assert.doesNotMatch(r.allFrames(), /sk-secret-value/, "the key was drawn on the screen");
  r.stop();
});

test("saving an empty key does nothing: removing it is a row of its own", async () => {
  const r = rig({ hasKey: true });
  await r.press(DOWN, "\r", "\r");
  await tick(40);
  assert.deepEqual(r.saved, []);
  r.stop();
});

test("the remove-the-saved-key row clears only the key", async () => {
  const r = rig({ hasKey: true, address: "https://x.test/v1" });
  await r.press(DOWN, DOWN, DOWN, DOWN, "\r"); // address, key, models, window, then the key's own row
  await tick(60);
  assert.deepEqual(r.saved, [{ key: null }]);
  r.stop();
});

test("a field opens with what is stored, and saving it empty clears it", async () => {
  const r = rig({ models: "a,b" });
  await r.press(DOWN, DOWN, "\r"); // Model ids
  assert.match(r.screen(), /a,b/, "opens with the stored ids");
  const BACKSPACE = String.fromCharCode(127);
  await r.press(BACKSPACE, BACKSPACE, BACKSPACE, "\r");
  await tick(60);
  assert.deepEqual(r.saved, [{ models: null }]);
  r.stop();
});

test("Esc in a field goes back to the list without saving", async () => {
  const r = rig();
  await r.press("\r");
  await r.typeText("https://abandoned.example.test");
  await r.press(ESC);
  await tick(60);
  assert.deepEqual(r.saved, []);
  assert.match(r.screen(), /Address\s+not set/, "back on the list");
  assert.equal(r.closed, 0, "one Esc leaves the field, not the box");
  r.stop();
});

test("Esc on the list closes the box", async () => {
  const r = rig();
  await r.press(ESC);
  await tick(60);
  assert.equal(r.closed, 1);
  r.stop();
});

test("Check the server again asks, and shows the answer", async () => {
  const r = rig();
  await r.press(DOWN, DOWN, DOWN, DOWN, "\r"); // no key row here, so the fifth row is Check
  await tick(60);
  assert.equal(r.checked, 1);
  assert.match(r.screen(), /connected: 2 models/);
  r.stop();
});

test("Remove everything asks first, and n keeps it", async () => {
  const r = rig({ address: "https://x.test/v1" });
  await r.press(DOWN, DOWN, DOWN, DOWN, DOWN, "\r"); // Remove everything is the sixth row
  assert.match(r.screen(), /remove everything\?/);
  await r.press("n");
  await tick(40);
  assert.equal(r.forgotten, 0);
  assert.match(r.screen(), /Address\s+https:\/\/x\.test\/v1/, "back on the list, nothing removed");
  r.stop();
});

test("Remove everything, confirmed with y, forgets", async () => {
  const r = rig({ address: "https://x.test/v1" });
  await r.press(DOWN, DOWN, DOWN, DOWN, DOWN, "\r", "y");
  await tick(60);
  assert.equal(r.forgotten, 1);
  r.stop();
});

test("a refused change shows the reason, in the box", async () => {
  const r = rig({}, { ok: false, message: "That does not look like an address." });
  await r.press("\r");
  await r.typeText("nonsense");
  await r.press("\r");
  await tick(60);
  assert.match(r.screen(), /That does not look like an address\./);
  r.stop();
});

test("the field looks like the chat input: a > marker, ghost text while empty, and the key shown as stars", async () => {
  const r = rig();
  await r.press("\r");
  assert.match(r.screen(), /> https:\/\/…\/v1/, "the marker and the ghost text, as in the chat box");
  await r.press(ESC, DOWN, "\r");
  await r.typeText("abc");
  assert.match(r.screen(), /> \*\*\*/, "the key is one star per character");
  assert.doesNotMatch(r.screen(), /abc/);
  r.stop();
});

test("the caret moves with the arrows and typing goes in at the caret", async () => {
  const r = rig();
  await r.press("\r");
  await r.typeText("ac");
  await r.press(`${ESC}[D`); // left
  await r.typeText("b");
  await r.press("\r");
  await tick(60);
  assert.deepEqual(r.saved, [{ address: "abc" }]);
  r.stop();
});

test("a paste with a line break is kept to one line", async () => {
  const r = rig();
  await r.press("\r");
  await r.press("https://x.test/v1\n");
  await r.press("\r");
  await tick(60);
  assert.deepEqual(r.saved, [{ address: "https://x.test/v1" }]);
  r.stop();
});

const LOCAL = { keyed: false, usesModels: false, usesWindow: false, emptyAddress: "this computer, the usual port", addressExample: "192.168.1.20:1234", addressHelp: "only if LM Studio runs on another computer" };

test("a server found by itself shows only its address, and says an empty one means this computer", async () => {
  const r = rig(LOCAL);
  await tick();
  const out = r.screen();
  assert.match(out, /Address\s+this computer, the usual port/);
  assert.doesNotMatch(out, /Key\s/);
  assert.doesNotMatch(out, /Model ids/);
  assert.doesNotMatch(out, /Window/);
  assert.match(out, /Check the server again/);
  assert.match(out, /Use this computer again/);
  r.stop();
});

test("its address field gives its own example and help, and saves the address", async () => {
  const r = rig(LOCAL);
  await r.press("\r");
  assert.match(r.screen(), /only if LM Studio runs on another computer/);
  assert.match(r.screen(), /> 192\.168\.1\.20:1234/, "the ghost text is the example for that server");
  await r.typeText("10.0.0.5:1234");
  await r.press("\r");
  await tick(60);
  assert.deepEqual(r.saved, [{ address: "10.0.0.5:1234" }]);
  r.stop();
});

test("Use this computer again asks first, in its own words, and then forgets", async () => {
  const r = rig({ ...LOCAL, address: "http://10.0.0.5:1234" });
  await r.press(DOWN, DOWN, "\r"); // address, check, then the last row
  assert.match(r.screen(), /use this computer again\?/);
  assert.match(r.screen(), /looked for on this computer again/);
  await r.press("y");
  await tick(60);
  assert.equal(r.forgotten, 1);
  r.stop();
});
