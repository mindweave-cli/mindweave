/**
 * pickerFilter.probe.test.tsx — typing into an open picker, for real.
 *
 * A provider with hundreds of models is only usable if one of them can be found without
 * scrolling. This drives the real Picker through a fake terminal: keys go in through
 * stdin the way Ink 7 reads them (`readable` + `read()`, never `data`), and every
 * assertion waits for the SCREEN rather than sleeping, so a slow machine is slow rather
 * than wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { Picker } from "./components/Picker.js";

const ESCAPE = String.fromCharCode(27);
const ENTER = "\r";
const BACKSPACE = String.fromCharCode(127);
const FRAME_DEADLINE_MS = 10_000;
const TITLE = "Choose a model";

class FakeStdout extends EventEmitter {
  columns = 90;
  rows = 30;
  isTTY = true;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
  /** The latest full frame (debug mode writes whole frames), escapes stripped. */
  last(): string {
    const frame = this.frames.filter((f) => f.includes(TITLE)).at(-1) ?? "";
    return frame.replace(new RegExp(ESCAPE + "\\[[0-9;?]*[A-Za-z]", "g"), "");
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
  ...Array.from({ length: 30 }, (_, i) => ({ label: `Filler Model ${i}`, description: "Vendor · $1 in / $2 out per M" })),
  { label: "DeepSeek V4.1 Flash", description: "DeepSeek · $0.15 in / $0.6 out per M" },
  { label: "Claude Fable 5.1", description: "Anthropic · $10 in / $50 out per M" },
  { label: "Claude Fable 5", description: "Anthropic · $10 in / $50 out per M" },
];

function mount(initialFilter?: string) {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const events: { selected: number[]; cancelled: number } = { selected: [], cancelled: 0 };
  const instance = render(
    <Picker
      title={TITLE}
      items={ITEMS}
      width={90}
      maxRows={8}
      initialFilter={initialFilter}
      onSelect={(i) => events.selected.push(i)}
      onCancel={() => events.cancelled++}
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
    await until(h, () => h.stdout.last().includes(typed), `the filter to read "${typed}"`);
  }
}

const rowCount = (screen: string) => screen.split("\n").length;

test("typing narrows the list, and Enter picks the caller's index for the matching row", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Filler Model 0"), "the picker to open");
    const before = rowCount(h.stdout.last());
    await typeText(h, "fable 5.1");
    const screen = h.stdout.last();
    assert.match(screen, /Claude Fable 5\.1/);
    assert.doesNotMatch(screen, /Filler Model/, "rows that do not match stayed on screen");
    assert.doesNotMatch(screen, /DeepSeek/);
    assert.equal(rowCount(screen), before, "the box changed height while filtering");
    h.stdin.type(ENTER);
    await until(h, () => h.events.selected.length > 0, "the selection");
    assert.deepEqual(h.events.selected, [31], "Enter returned the filtered position instead of the caller's index");
  } finally {
    h.done();
  }
});

test("words match in any order, across label and description", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Filler Model 0"), "the picker to open");
    await typeText(h, "flash deepseek");
    assert.match(h.stdout.last(), /DeepSeek V4\.1 Flash/);
    assert.match(h.stdout.last(), /1 of 1/);
  } finally {
    h.done();
  }
});

test("Backspace edits the filter while there is one, and only then closes", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Filler Model 0"), "the picker to open");
    await typeText(h, "cl");
    h.stdin.type(BACKSPACE);
    h.stdin.type(BACKSPACE);
    await until(h, () => h.stdout.last().includes("Filler Model 0"), "the full list to come back");
    assert.equal(h.events.cancelled, 0, "Backspace closed the picker while it still had a filter to edit");
    h.stdin.type(BACKSPACE);
    await until(h, () => h.events.cancelled === 1, "an empty-filter Backspace to close the picker");
  } finally {
    h.done();
  }
});

test("scrolling the mouse wheel over the picker types nothing into the filter", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.last().includes("Filler Model 0"), "the picker to open");
    // What a terminal sends per wheel notch once reporting is on: SGR mouse reports.
    for (let i = 0; i < 6; i++) h.stdin.type(`${ESCAPE}[<65;43;30M`);
    h.stdin.type(`${ESCAPE}[<64;43;30M${ESCAPE}[<65;43;30M`);
    // Then a real key, so there is something to wait for once the wheel bytes are read.
    await typeText(h, "deep");
    const screen = h.stdout.last();
    assert.doesNotMatch(screen, /\[<6[45]/, "wheel reports were typed into the filter");
    assert.match(screen, /DeepSeek V4\.1 Flash/, "the filter did not match what was really typed");
  } finally {
    h.done();
  }
});

test("a pre-filled filter opens on exactly the matches", async () => {
  const h = mount("claude fable");
  try {
    await until(h, () => h.stdout.last().includes("Claude Fable 5.1"), "the pre-filtered picker");
    const screen = h.stdout.last();
    assert.match(screen, /Claude Fable 5\b/);
    assert.doesNotMatch(screen, /Filler Model|DeepSeek/);
    assert.match(screen, /1 of 2/);
  } finally {
    h.done();
  }
});
