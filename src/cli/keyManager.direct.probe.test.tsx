/**
 * keyManager.direct.probe.test.tsx — /key opened straight onto a provider, driven with real keystrokes.
 *
 * Reached by picking a provider that has no key in /provider: the pick is made, so the key field is what shows. Esc from there
 * used to walk back through two screens the person never opened (that provider's empty key list, then the list of every
 * provider), so a single Esc looked like the app opening more things. It closes.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import React from "react";
const { render, Box } = await import("ink");
const { KeyManager } = await import("./components/KeyManager.js");
import type { KeyRow, ProviderRow } from "./keyManager.js";
import { providerRows } from "./keyManager.js";

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
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const META: ProviderRow = { id: "meta", label: "Meta", apiKeyEnv: "MODEL_API_KEY", count: 0 };
const GEMINI: ProviderRow = { id: "gemini", label: "Gemini", apiKeyEnv: "GEMINI_API_KEY", count: 1 };
const GEMINI_KEYS: KeyRow[] = [{ label: "Gemini", apiKeyEnv: "GEMINI_API_KEY", slot: 1, hint: "…a4f2", active: true }];

async function open(startProvider: ProviderRow, keys: KeyRow[]) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  let closed = 0;
  const instance = render(
    <Box flexDirection="column" width={80}>
      <KeyManager
        providers={[META, GEMINI]}
        keysOf={() => keys}
        nextSlot={() => keys.length + 1}
        reveal={() => ""}
        width={80}
        onActivate={() => {}}
        onSave={() => {}}
        onRemove={() => {}}
        onClose={() => { closed++; }}
        startProvider={startProvider}
        maxRows={9}
      />
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, interactive: true, debug: true },
  );
  await tick();
  return {
    esc: async () => { stdin.type(ESC); await tick(60); },
    screen: () => (stdout.frames[stdout.frames.length - 1] ?? "").replace(ANSI, ""),
    closed: () => closed,
    stop: () => instance.unmount(),
  };
}

test("a provider with no key, picked in /provider: the key field shows, and one Esc closes it", async () => {
  const box = await open(META, []);
  assert.match(box.screen(), /Meta · add a key/);
  await box.esc();
  assert.equal(box.closed(), 1, "Esc did not close it");
  assert.doesNotMatch(box.screen(), /no key yet|Keys\b.*of/, "it walked on to a screen that was never opened");
  box.stop();
});

test("a provider with keys, opened straight onto: Esc from its key list closes", async () => {
  const box = await open(GEMINI, GEMINI_KEYS);
  assert.match(box.screen(), /Gemini · 1 key/);
  await box.esc();
  assert.equal(box.closed(), 1);
  box.stop();
});

test("the key list is for providers that take a key: a server set up by an address is not in it", () => {
  const ids = providerRows({}).map((r) => r.id);
  assert.ok(ids.includes("deepseek"));
  assert.ok(!ids.includes("custom"), "the custom endpoint keeps its key in its own box, not in a slot here");
  assert.ok(!ids.includes("ollama") && !ids.includes("lmstudio") && !ids.includes("llamacpp"));
});
