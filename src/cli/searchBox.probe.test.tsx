/**
 * searchBox.probe.test.tsx — a long model list searched from the input box, for real.
 *
 * OpenRouter's catalogue is nearly three hundred models, too many to scroll to one. While its
 * picker is open the input box is the search field: ghost text until a letter is typed, the
 * words in the box, a border of its own colour, the list narrowing as it is typed. Esc takes the
 * words away first and closes only on the second press.
 *
 * Driven through a fake terminal with the real PromptInput and the real Picker: keys go in
 * through stdin the way Ink reads them, and every assertion waits for the SCREEN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink loads: chalk fixes its colour support at import time.
process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");
const { Picker } = await import("./components/Picker.js");
const { pickerSearchText } = await import("./pickerSearch.js");

const ESCAPE = String.fromCharCode(27);
const ENTER = "\r";
const BACKSPACE = String.fromCharCode(127);
const DOWN = `${ESCAPE}[B`;
const UP = `${ESCAPE}[A`;
const FRAME_DEADLINE_MS = 10_000;
const TITLE = "Choose an OpenRouter model";
const GHOST = "Search OpenRouter models…";
/** The accent colour as chalk writes it in truecolor (#52BF92). */
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
  /** The latest full frame, as written. */
  raw(): string {
    return this.frames.filter((f) => f.includes(TITLE)).at(-1) ?? "";
  }
  /** The latest full frame with escapes stripped. */
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

const ITEMS = [
  ...Array.from({ length: 288 }, (_, i) => ({ label: `Filler Model ${String(i).padStart(3, "0")}`, description: "Vendor · $1 in / $2 out per M", keywords: `vendor/filler-${i}` })),
  { label: "Claude Opus 4.1", description: "200K · vision · Anthropic", keywords: "anthropic/claude-opus-4.1" },
  { label: "Claude Opus 4.5", description: "200K · vision · Anthropic", keywords: "anthropic/claude-opus-4.5" },
  { label: "Claude Haiku 5.5", description: "200K · vision · Anthropic", keywords: "anthropic/claude-haiku-5.5" },
  { label: "DeepSeek V4.1 Flash", description: "1M · DeepSeek", keywords: "deepseek/deepseek-v4.1-flash" },
];

function mount(options: { searchBox: boolean }) {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const events: { selected: number[]; cancelled: number } = { selected: [], cancelled: 0 };
  const picker = (
    <Picker
      title={TITLE}
      items={ITEMS}
      width={90}
      maxRows={8}
      searchBox={options.searchBox}
      onSelect={(i) => events.selected.push(i)}
      onCancel={() => events.cancelled++}
    />
  );
  const instance = render(
    <PromptInput
      onSubmit={() => {}}
      overlay={picker}
      width={90}
      maxMenuRows={8}
      placeholder="say something…"
      {...(options.searchBox ? { searchPlaceholder: GHOST } : {})}
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

/** Type one character at a time, waiting for the box to show each. */
async function typeText(h: ReturnType<typeof mount>, text: string): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    h.stdin.type(text[i]!);
    const typed = text.slice(0, i + 1);
    await until(h, () => pickerSearchText() === typed && h.stdout.last().includes(typed), `the box to read "${typed}"`);
  }
}

const rowCount = (screen: string) => screen.split("\n").length;
/** The input box's own row (the first line holding the prompt mark), not the list below it. */
const boxRow = (screen: string) => screen.split("\n").find((l) => l.includes(">") && !l.includes("›")) ?? "";

test("it opens as a search: ghost text in the box, a border of its own colour, a hint that says so", async () => {
  const h = mount({ searchBox: true });
  try {
    await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
    const screen = h.stdout.last();
    assert.match(boxRow(screen), /Search OpenRouter models…/, "the box has no ghost text");
    assert.doesNotMatch(screen, /say something/, "the box still offers the ordinary prompt");
    assert.match(screen, /type to search/, "the hint does not say it is a search");
    const topBorder = h.stdout.raw().split("\n").find((l) => l.includes("┌")) ?? "";
    assert.ok(topBorder.includes(ACCENT_SGR), "the box's border is not the accent colour");
    assert.match(screen, /1 of 292/, "the whole catalogue is not listed");
  } finally {
    h.done();
  }
});

test("typing puts the words in the box, takes the ghost text away, and narrows the list as it goes", async () => {
  const h = mount({ searchBox: true });
  try {
    await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
    const before = rowCount(h.stdout.last());
    await typeText(h, "opus");
    const screen = h.stdout.last();
    assert.match(boxRow(screen), /opus/, "the words are not in the input box");
    assert.doesNotMatch(screen, /Search OpenRouter models/, "the ghost text stayed once typing began");
    assert.ok(screen.indexOf("opus") < screen.indexOf(TITLE), "the words are not above the list, in the box");
    assert.match(screen, /Claude Opus 4\.1/);
    assert.match(screen, /Claude Opus 4\.5/);
    assert.doesNotMatch(screen, /Filler Model|Haiku|DeepSeek/, "rows that do not match stayed on screen");
    assert.match(screen, /1 of 2/);
    assert.equal(rowCount(screen), before, "the box changed height while searching");
  } finally {
    h.done();
  }
});

test("a search finds a model by the id behind its name", async () => {
  const h = mount({ searchBox: true });
  try {
    await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
    await typeText(h, "deepseek-v4");
    assert.match(h.stdout.last(), /DeepSeek V4\.1 Flash/);
    assert.match(h.stdout.last(), /1 of 1/);
  } finally {
    h.done();
  }
});

test("Backspace edits the words in the box, forward and back, and the ghost text returns when none are left", async () => {
  const h = mount({ searchBox: true });
  try {
    await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
    await typeText(h, "opus");
    h.stdin.type(BACKSPACE);
    await until(h, () => pickerSearchText() === "opu" && /Opus/.test(h.stdout.last()), "one letter to come off");
    assert.match(boxRow(h.stdout.last()), /opu(?!s)/);
    h.stdin.type(BACKSPACE);
    h.stdin.type(BACKSPACE);
    h.stdin.type(BACKSPACE);
    await until(h, () => pickerSearchText() === "" && h.stdout.last().includes("Search OpenRouter models"), "the ghost text to come back");
    assert.match(h.stdout.last(), /1 of 292/, "the whole list did not come back");
    assert.equal(h.events.cancelled, 0, "Backspace closed the picker while there were words to edit");
    h.stdin.type(BACKSPACE);
    await until(h, () => h.events.cancelled === 1, "Backspace on an empty box to close");
  } finally {
    h.done();
  }
});

test("↓ and ↑ move through the matches, wrapping both ways, and Enter returns the caller's index", async () => {
  const h = mount({ searchBox: true });
  try {
    await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
    await typeText(h, "claude");
    assert.match(h.stdout.last(), /1 of 3/);
    h.stdin.type(DOWN);
    await until(h, () => /^.*›.*Opus 4\.5/m.test(h.stdout.last()), "the second match to be marked");
    h.stdin.type(UP);
    await until(h, () => /^.*›.*Opus 4\.1/m.test(h.stdout.last()), "the first match to be marked again");
    h.stdin.type(UP);
    await until(h, () => /^.*›.*Haiku 5\.5/m.test(h.stdout.last()), "↑ to wrap to the last match");
    h.stdin.type(DOWN);
    await until(h, () => /^.*›.*Opus 4\.1/m.test(h.stdout.last()), "↓ to wrap to the first match");
    h.stdin.type(DOWN);
    await until(h, () => /^.*›.*Opus 4\.5/m.test(h.stdout.last()), "the second match again");
    h.stdin.type(ENTER);
    await until(h, () => h.events.selected.length > 0, "the selection");
    assert.deepEqual(h.events.selected, [289], "Enter returned a position in the matches, not the model's own index");
  } finally {
    h.done();
  }
});

test("Esc leaves the search in two steps: the first takes the words away, the second closes", async () => {
  const h = mount({ searchBox: true });
  try {
    await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
    await typeText(h, "opus");
    h.stdin.type(ESCAPE);
    await until(h, () => pickerSearchText() === "" && h.stdout.last().includes("Search OpenRouter models"), "the first Esc to clear the search");
    assert.equal(h.events.cancelled, 0, "the first Esc closed the picker");
    assert.match(h.stdout.last(), /1 of 292/, "the first Esc did not show the whole list");
    h.stdin.type(ESCAPE);
    await until(h, () => h.events.cancelled === 1, "the second Esc to close the picker");
  } finally {
    h.done();
  }
});

test("Esc with nothing typed closes at once, as it always did", async () => {
  const h = mount({ searchBox: true });
  try {
    await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
    h.stdin.type(ESCAPE);
    await until(h, () => h.events.cancelled === 1, "Esc to close the picker");
  } finally {
    h.done();
  }
});

test("the search is put away with the picker, so the next one starts from nothing", async () => {
  const h = mount({ searchBox: true });
  await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
  await typeText(h, "opus");
  h.done();
  assert.equal(pickerSearchText(), "", "words typed into one picker were left for the next");
});

test("a picker that is not a search is unchanged: the ordinary prompt, and the words on the hint row", async () => {
  const h = mount({ searchBox: false });
  try {
    await until(h, () => h.stdout.last().includes(TITLE), "the picker to open");
    const screen = h.stdout.last();
    assert.doesNotMatch(screen, /Search OpenRouter models/);
    const topBorder = h.stdout.raw().split("\n").find((l) => l.includes("┌")) ?? "";
    assert.ok(!topBorder.includes(ACCENT_SGR), "a picker that is not a search recoloured the box");
    h.stdin.type("o");
    await until(h, () => /opus|Opus/.test(h.stdout.last()) || h.stdout.last().includes("1 of"), "the filter to apply");
    h.stdin.type("p");
    h.stdin.type("u");
    await until(h, () => /\bopu\b/.test(h.stdout.last().split("\n").at(-2) ?? "") || /opu/.test(h.stdout.last()), "the filter to read on the hint row");
    assert.equal(pickerSearchText(), "", "a picker that is not a search wrote into the input box");
  } finally {
    h.done();
  }
});
