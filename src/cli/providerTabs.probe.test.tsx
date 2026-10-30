/**
 * providerTabs.probe.test.tsx — /provider and /key as one screen with two tabs, driven with real keystrokes.
 *
 * [1] Providers: every provider and whether it is ready; Enter uses one (a provider with no key goes to adding one first, and is
 * used as soon as the key is saved); → opens its keys. [2] Keys: that provider's keys, edited and removed as before.
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import React from "react";
const { render, Box } = await import("ink");
const { KeyManager } = await import("./components/KeyManager.js");
const { Text } = await import("ink");
import type { KeyRow, ProviderRow } from "./keyManager.js";
import { providerChoices } from "./keyManager.js";

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
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
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const DOWN = `${ESC}[B`;
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const row = (id: string, label: string, extra: Partial<ProviderRow> = {}): ProviderRow => ({ id, label, apiKeyEnv: `${id.toUpperCase()}_API_KEY`, count: 0, kind: "key", ready: false, status: "3 models · no key yet", ...extra });
const DEEPSEEK = row("deepseek", "DeepSeek", { count: 2, ready: true, active: true, status: "3 models · 2 keys", keysUrl: "https://platform.deepseek.com/api_keys" });
const META = row("meta", "Meta", { keysUrl: "https://example.test/keys" });
const CUSTOM = row("custom", "Custom endpoint", { kind: "setup", status: "0 models · not set up" });
const PROVIDERS = [DEEPSEEK, META, CUSTOM];
const KEYS: KeyRow[] = [
  { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", slot: 1, hint: "…a4f2", active: true },
  { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", slot: 2, hint: "…9c1b", active: false },
];

async function open() {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const log = { used: [] as string[], saved: [] as string[], removed: 0, setup: [] as string[], closed: 0 };
  const instance = render(
    <Box flexDirection="column" width={90}>
      <KeyManager
        providers={PROVIDERS}
        keysOf={(p) => (p.id === "deepseek" ? KEYS : [])}
        nextSlot={(p) => (p.id === "deepseek" ? 3 : 1)}
        reveal={() => "sk-the-real-secret"}
        width={90}
        maxRows={10}
        onActivate={() => {}}
        onSave={(p, slot, key) => void log.saved.push(`${p.id}:${slot}:${key}`)}
        onRemove={() => void log.removed++}
        onUse={(p) => void log.used.push(p.id)}
        setupTab={(p, back, tabs) => {
          if (p.id !== "custom") return null;
          log.setup.push(p.id);
          // Stands in for the endpoint settings: the tab bar is the manager's, and going back is the manager's.
          return <Text>{`Custom endpoint settings ${tabs.map((t) => (t.active ? "[x]" : "[ ]")).join("")}`}</Text>;
        }}
        onClose={() => void log.closed++}
      />
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, interactive: true, debug: true },
  );
  await tick();
  return {
    log,
    press: async (...keys: string[]) => {
      for (const k of keys) {
        stdin.type(k);
        await tick(40);
      }
    },
    type: async (text: string) => {
      for (const ch of text) {
        stdin.type(ch);
        await tick(5);
      }
      await tick();
    },
    screen: () => (stdout.frames[stdout.frames.length - 1] ?? "").replace(ANSI, ""),
    all: () => stdout.frames.join("\n").replace(ANSI, ""),
    stop: () => instance.unmount(),
  };
}

test("the first tab lists every provider with what it offers, the active one marked, and both tabs in the title", async () => {
  const b = await open();
  const s = b.screen();
  assert.match(s, /Providers\s+\[1\] \[2\]/);
  assert.match(s, /DeepSeek\s+✓\s+3 models · 2 keys/);
  assert.match(s, /Meta\s+3 models · no key yet/);
  assert.match(s, /Custom endpoint\s+0 models · not set up/, "a provider set up by an address is on the list too");
  b.stop();
});

test("Enter on a provider that is ready uses it", async () => {
  const b = await open();
  await b.press("\r");
  assert.deepEqual(b.log.used, ["deepseek"]);
  b.stop();
});

test("Enter on a provider with no key asks for one, and uses the provider as soon as it is saved", async () => {
  const b = await open();
  await b.press(DOWN, "\r");
  assert.match(b.screen(), /Meta · add a key/);
  assert.match(b.screen(), /Get a key at https:\/\/example\.test\/keys/);
  assert.match(b.screen(), /Meta is used as soon as the key is saved/);
  assert.deepEqual(b.log.used, [], "it was used before it had a key");
  await b.type("sk-new-key");
  assert.match(b.screen(), /> \*{10}/, "the key is one star per character");
  await b.press("\r");
  assert.deepEqual(b.log.saved, ["meta:1:sk-new-key"]);
  assert.deepEqual(b.log.used, ["meta"]);
  assert.doesNotMatch(b.all(), /sk-new-key/, "the key was drawn on the screen");
  b.stop();
});

test("Esc from that add screen goes back to the provider list, not out of the manager", async () => {
  const b = await open();
  await b.press(DOWN, "\r", ESC);
  await tick(60);
  assert.match(b.screen(), /Providers/);
  assert.equal(b.log.closed, 0);
  assert.deepEqual(b.log.saved, []);
  assert.deepEqual(b.log.used, []);
  b.stop();
});

test("→ opens the highlighted provider's keys, ← and Esc come back, Esc on the list closes", async () => {
  const b = await open();
  await b.press(RIGHT);
  assert.match(b.screen(), /DeepSeek · 2 keys\s+\[1\] \[2\]/);
  assert.match(b.screen(), /key 1\s+…a4f2\s+● active/);
  assert.match(b.screen(), /Add a new key/);
  assert.match(b.screen(), /Get a key at https:\/\/platform\.deepseek\.com\/api_keys/, "the keys tab says where to get one");
  assert.match(b.screen(), /DEEPSEEK_API_KEY/);
  await b.press(LEFT);
  assert.match(b.screen(), /Providers/);
  await b.press(RIGHT, ESC);
  await tick(60);
  assert.match(b.screen(), /Providers/);
  assert.equal(b.log.closed, 0, "Esc on the keys tab closed the manager");
  await b.press(ESC);
  await tick(60);
  assert.equal(b.log.closed, 1);
  b.stop();
});

test("a provider set up by an address has its settings as the second tab, from → and from Enter while it is not ready", async () => {
  const b = await open();
  await b.press(DOWN, DOWN, RIGHT);
  assert.match(b.screen(), /Custom endpoint settings \[ \]\[x\]/, "its settings are the second tab");
  assert.doesNotMatch(b.screen(), /add a key/);
  b.stop();
  const c = await open();
  await c.press(DOWN, DOWN, "\r");
  assert.match(c.screen(), /Custom endpoint settings/, "Enter on one that is not ready opens its settings, it does not try to use it");
  assert.deepEqual(c.log.used, []);
  c.stop();
});

test("a key is edited and removed from the keys tab, as before", async () => {
  const b = await open();
  await b.press(RIGHT, "\r"); // key 1's actions
  assert.match(b.screen(), /DeepSeek · key 1/);
  assert.match(b.screen(), /Show the key/);
  await b.press("\r"); // Show
  assert.match(b.screen(), /sk-the-real-secret/);
  await b.press(DOWN, "\r"); // Edit it (key 1 is already active, so there is no "make active" row)
  assert.match(b.screen(), /DeepSeek · edit key/);
  assert.match(b.screen(), /This replaces key 1 \(…a4f2\)/);
  await b.type("sk-replacement");
  await b.press("\r");
  assert.deepEqual(b.log.saved, ["deepseek:1:sk-replacement"]);
  assert.deepEqual(b.log.used, [], "editing a key is not a request to switch provider");
  assert.match(b.screen(), /DeepSeek · 2 keys/, "back on the keys tab");
  await b.press("\r", DOWN, DOWN, "\r"); // key 1 → Show, Edit, Remove
  assert.equal(b.log.removed, 1);
  b.stop();
});

test("the key field is edited like the chat box: the caret moves, text goes in at it, a paste loses its line breaks", async () => {
  const b = await open();
  await b.press(DOWN, "\r");
  await b.type("ac");
  await b.press(LEFT);
  await b.type("b");
  await b.press("\r");
  assert.deepEqual(b.log.saved, ["meta:1:abc"]);
  const c = await open();
  await c.press(DOWN, "\r");
  await c.press("sk-1\n2");
  await c.press("\r");
  assert.deepEqual(c.log.saved, ["meta:1:sk-12"]);
  b.stop();
  c.stop();
});

test("typing narrows the provider list by name or by what it says about itself", async () => {
  const b = await open();
  await b.type("no key");
  const s = b.screen();
  assert.match(s, /Meta/);
  assert.doesNotMatch(s, /DeepSeek/);
  b.stop();
});

test("providerChoices: every provider, the ready ones first, each said plainly", () => {
  const rows = providerChoices("deepseek", (env) => env === "DEEPSEEK_API_KEY");
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes("custom") && ids.includes("ollama") && ids.includes("lmstudio") && ids.includes("llamacpp"));
  const deepseek = rows.find((r) => r.id === "deepseek")!;
  assert.equal(deepseek.active, true);
  assert.equal(deepseek.ready, true);
  assert.equal(deepseek.kind, "key");
  assert.match(deepseek.status ?? "", /models? · /);
  assert.equal(rows.find((r) => r.id === "custom")!.kind, "setup");
  assert.equal(rows.find((r) => r.id === "ollama")!.kind, "local");
  assert.match(rows.find((r) => r.id === "custom")!.status ?? "", /not set up/);
  const firstUnready = rows.findIndex((r) => !r.ready);
  assert.ok(rows.slice(firstUnready).every((r) => !r.ready), "a ready provider sits below one that is not");
});

test("the real endpoint settings, as the second tab: the tab bar is shown and ← goes back", async () => {
  const { EndpointBox } = await import("./components/EndpointBox.js");
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  let closed = 0;
  const fields = { address: "", hasKey: false, models: "", window: "", defaultWindow: 128000, connected: false, modelCount: 0 };
  const instance = render(
    <Box flexDirection="column" width={90}>
      <EndpointBox
        title="Custom endpoint"
        read={() => fields}
        onSave={async () => ({ ok: true, message: "saved" })}
        onCheck={async () => ({ ok: true, message: "ok" })}
        onForget={async () => ({ ok: true, message: "removed" })}
        onClose={() => void closed++}
        width={90}
        maxRows={10}
        tabs={[{ active: false }, { active: true }]}
        titleWidth={34}
        backWord="← or Esc  providers"
      />
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, interactive: true, debug: true },
  );
  await tick();
  const screen = (stdout.frames[stdout.frames.length - 1] ?? "").replace(ANSI, "");
  assert.match(screen, /Custom endpoint · not connected\s+\[1\] \[2\]/);
  assert.match(screen, /← or Esc  providers/);
  stdin.type(LEFT);
  await tick(60);
  assert.equal(closed, 1);
  instance.unmount();
});

test("← and Backspace leave the key field while it is empty, and move the caret or delete once something is typed", async () => {
  const b = await open();
  await b.press(DOWN, "\r");
  assert.match(b.screen(), /Meta · add a key/);
  await b.press(LEFT);
  await tick(60);
  assert.match(b.screen(), /Providers/, "← on an empty field did not go back");
  assert.equal(b.log.closed, 0);
  await b.press(DOWN, "\r");
  assert.match(b.screen(), /Meta · add a key/);
  await b.press(String.fromCharCode(127));
  await tick(60);
  assert.match(b.screen(), /Providers/, "Backspace on an empty field did not go back");
  await b.press(DOWN, "\r", "x", LEFT);
  assert.match(b.screen(), /Meta · add a key/, "← with text typed left the field");
  b.stop();
});

test("→ on a provider with no key opens the key field, and going back from it lands on the provider list, not an empty key list", async () => {
  const b = await open();
  await b.press(DOWN, RIGHT);
  assert.match(b.screen(), /Meta · add a key/);
  await b.press(LEFT);
  await tick(60);
  assert.match(b.screen(), /Providers/);
  assert.doesNotMatch(b.screen(), /no key yet\s+\[1\]/, "the empty key list was shown");
  await b.press(DOWN, RIGHT, ESC);
  await tick(60);
  assert.match(b.screen(), /Providers/);
  assert.equal(b.log.closed, 0);
  b.stop();
});
