/**
 * keySearch.probe.test.tsx — /key, searched from the input box, for real.
 *
 * The provider list of the keys manager is searched the way the model and provider lists are:
 * the input box is the search field (ghost text, its own border colour), the list narrows as
 * words are typed, Esc takes the words away before it closes. The screens under that list are
 * not searches, so the box goes back to being the ordinary prompt there, and comes back with
 * the list.
 *
 * The real PromptInput and the real KeyManager, through a fake terminal: keys go in through
 * stdin the way Ink reads them, and every assertion waits for the SCREEN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink loads: chalk fixes its colour support at import time.
process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");
const { KeyManager } = await import("./components/KeyManager.js");
const { pickerSearchText, pickerSearchActive } = await import("./pickerSearch.js");
import type { KeyRow, ProviderRow } from "./keyManager.js";

const ESCAPE = String.fromCharCode(27);
const ENTER = "\r";
const BACKSPACE = String.fromCharCode(127);
const FRAME_DEADLINE_MS = 10_000;
const GHOST = "Search providers…";
const ACCENT_SGR = "38;2;82;191;146";

class FakeStdout extends EventEmitter {
  columns = 90;
  rows = 40;
  isTTY = true;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
  raw(): string {
    return this.frames.filter((f) => f.includes("└")).at(-1) ?? "";
  }
  last(): string {
    return this.raw().replace(new RegExp(ESCAPE + "\\[[0-9;?]*[A-Za-z]", "g"), "");
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  type(key: string): void {
    this.queue.push(key);
    this.emit("readable");
  }
  pump(): void {
    if (this.queue.length > 0) this.emit("readable");
  }
}

const NAMES = ["DeepSeek", "Gemini", "GLM", "OpenRouter", "Anthropic", "Cerebras", "Groq", "Kimi", "Meta", "MiniMax", "Mistral", "OpenAI", "Qwen", "Tencent", "xAI"];
const PROVIDERS: ProviderRow[] = NAMES.map((label, i) => ({ id: label.toLowerCase(), label, apiKeyEnv: `${label.toUpperCase()}_API_KEY`, count: i < 4 ? 1 : 0 }));
const KEYS: KeyRow[] = [{ label: "x", apiKeyEnv: "X", slot: 1, hint: "…a4f2", active: true }];

function mount() {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const events = { closed: 0 };
  const instance = render(
    <PromptInput
      onSubmit={() => {}}
      width={90}
      maxMenuRows={8}
      placeholder="say something…"
      searchPlaceholder={GHOST}
      overlay={
        <KeyManager
          providers={PROVIDERS}
          keysOf={() => KEYS}
          nextSlot={() => 2}
          reveal={() => "secret"}
          width={90}
          maxRows={8}
          onActivate={() => {}}
          onSave={() => {}}
          onRemove={() => {}}
          onClose={() => events.closed++}
        />
      }
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      interactive: true,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  return { stdin, stdout, events, done: () => instance.unmount() };
}

async function until(h: ReturnType<typeof mount>, ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + FRAME_DEADLINE_MS;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. The screen was:\n${h.stdout.last()}`);
    h.stdin.pump();
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function typeText(h: ReturnType<typeof mount>, text: string): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    h.stdin.type(text[i]!);
    const typed = text.slice(0, i + 1);
    await until(h, () => pickerSearchText() === typed && h.stdout.last().includes(typed), `the box to read "${typed}"`);
  }
}

/** The input box's own row: the first line with the prompt mark that is not a list row. */
const boxRow = (screen: string) => screen.split("\n").find((l) => l.includes(">") && !l.includes("›")) ?? "";
const topBorder = (h: ReturnType<typeof mount>) => h.stdout.raw().split("\n").find((l) => l.includes("┌")) ?? "";
const rowCount = (screen: string) => screen.split("\n").length;

test("the provider list opens as a search: ghost text in the box, its own border colour, the hint says so", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
    const screen = h.stdout.last();
    assert.match(boxRow(screen), /Search providers…/, "no ghost text in the box");
    assert.doesNotMatch(screen, /say something/);
    assert.match(screen, /type to search/);
    assert.ok(topBorder(h).includes(ACCENT_SGR), "the box's border is not the accent colour");
    assert.match(screen, /DeepSeek/);
    assert.match(screen, /1 of 15/, "the whole list is not there");
  } finally {
    h.done();
  }
});

test("typing narrows the list and puts the words in the box, in the same size of box", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
    const before = rowCount(h.stdout.last());
    await typeText(h, "mi");
    const screen = h.stdout.last();
    assert.match(boxRow(screen), /mi/);
    assert.doesNotMatch(screen, /Search providers/, "the ghost text stayed");
    // "mi" is in Gemini, Kimi, MiniMax and Mistral, and in nothing else.
    for (const name of ["Gemini", "Kimi", "MiniMax", "Mistral"]) assert.match(screen, new RegExp(name));
    assert.doesNotMatch(screen, /DeepSeek|Qwen|Groq|OpenRouter/, "rows that do not match stayed");
    assert.equal(rowCount(screen), before, "the box changed height");
  } finally {
    h.done();
  }
});

test("rows are numbered from one again in the narrowed list, and Enter opens the one marked", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
    await typeText(h, "mistral");
    assert.match(h.stdout.last(), /\b1\s+Mistral/, "the match is not numbered 1");
    h.stdin.type(ENTER);
    await until(h, () => h.stdout.last().includes("Add a Mistral key") || h.stdout.last().includes("Mistral ·") || h.stdout.last().includes("no key") === false && /Mistral/.test(h.stdout.last()) && !h.stdout.last().includes("Keys"), "Mistral's own screen");
    assert.doesNotMatch(h.stdout.last(), /DeepSeek|Groq/, "it opened something other than the list");
  } finally {
    h.done();
  }
});

test("with nothing typed a digit is still the shortcut for that row", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
    h.stdin.type("2");
    await until(h, () => /Gemini · /.test(h.stdout.last()), "the second provider to open");
    assert.equal(pickerSearchText(), "", "the shortcut was typed as a search as well");
  } finally {
    h.done();
  }
});

test("once words are typed, digits are part of them", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
    await typeText(h, "g2");
    assert.match(h.stdout.last(), /nothing matches/);
    assert.doesNotMatch(h.stdout.last(), /Gemini · /, "the digit opened a provider");
  } finally {
    h.done();
  }
});

test("Esc takes the words away first, and closes only when there are none", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
    await typeText(h, "kimi");
    h.stdin.type(ESCAPE);
    await until(h, () => pickerSearchText() === "" && h.stdout.last().includes("Search providers"), "the first Esc to clear the search");
    assert.equal(h.events.closed, 0, "the first Esc closed the manager");
    assert.match(h.stdout.last(), /DeepSeek/, "the whole list did not come back");
    h.stdin.type(ESCAPE);
    await until(h, () => h.events.closed === 1, "the second Esc to close");
  } finally {
    h.done();
  }
});

test("Backspace edits the words, then closes when there are none", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
    await typeText(h, "gl");
    h.stdin.type(BACKSPACE);
    await until(h, () => pickerSearchText() === "g", "a letter to come off");
    assert.equal(h.events.closed, 0);
    h.stdin.type(BACKSPACE);
    await until(h, () => pickerSearchText() === "" && h.stdout.last().includes("Search providers"), "the ghost text to return");
    assert.equal(h.events.closed, 0, "Backspace closed the manager while there were words to edit");
    h.stdin.type(BACKSPACE);
    await until(h, () => h.events.closed === 1, "Backspace on an empty box to close");
  } finally {
    h.done();
  }
});

test("the screens under the list are not searches: the box is the ordinary prompt there, and the search is back with the list", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
    h.stdin.type("1");
    await until(h, () => /DeepSeek · /.test(h.stdout.last()) && !pickerSearchActive(), "a provider's keys to open");
    await until(h, () => !topBorder(h).includes(ACCENT_SGR), "the box to stop being a search");
    assert.doesNotMatch(h.stdout.last(), /Search providers/, "the search ghost text is on a screen that is not a search");
    h.stdin.type(ESCAPE);
    await until(h, () => pickerSearchActive() && h.stdout.last().includes("Search providers"), "the search to return with the list");
    assert.equal(h.events.closed, 0, "going back closed the manager");
    assert.ok(topBorder(h).includes(ACCENT_SGR), "the border did not come back");
  } finally {
    h.done();
  }
});

test("the search is put away with the manager", async () => {
  const h = mount();
  await until(h, () => h.stdout.last().includes("Keys"), "the list to open");
  await typeText(h, "kimi");
  h.done();
  assert.equal(pickerSearchText(), "");
  assert.equal(pickerSearchActive(), true);
});
