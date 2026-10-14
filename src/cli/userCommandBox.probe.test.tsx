/**
 * userCommandBox.probe.test.tsx — the input box when a line starts with `!`.
 *
 * A line that is a shell command is not a message, and the box says so: another colour for the
 * border and the prompt mark (amber, which neither the ordinary box nor a search uses), for as
 * long as the line starts with `!`, and nothing different the rest of the time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink loads: chalk fixes its colour support at import time.
process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");

const ESCAPE = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);
/** The colours as chalk writes them in truecolor: amber (#EAB767), the accent (#52BF92). */
const AMBER = "38;2;234;183;103";
const ACCENT = "38;2;82;191;146";

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
  raw(): string {
    return this.frames.filter((f) => f.includes("└")).at(-1) ?? "";
  }
}
class FakeStdin extends EventEmitter {
  isTTY = true as const;
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

function mount(overlay?: unknown) {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const sent: string[] = [];
  const instance = render(
    <PromptInput onSubmit={(t) => sent.push(t)} width={80} placeholder="say something…" {...(overlay ? { overlay: overlay as never } : {})} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      interactive: true,
      debug: true,
      exitOnCtrlC: false,
    },
  );
  return { stdin, stdout, sent, done: () => instance.unmount() };
}
type H = ReturnType<typeof mount>;

async function until(h: H, ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    h.stdin.pump();
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** The input box's top border and its first text row, as written (colours included). */
const top = (h: H) => h.stdout.raw().split("\n").find((l) => l.includes("┌")) ?? "";
const first = (h: H) => h.stdout.raw().split("\n").find((l) => l.includes("│") && l.includes(">")) ?? "";
const typed = (h: H) => h.stdout.raw().replace(new RegExp(ESCAPE + "\[[0-9;?]*[A-Za-z]", "g"), "");

test("an ordinary box is neither amber nor accent", async () => {
  const h = mount();
  try {
    await until(h, () => typed(h).includes("say something"), "the box");
    assert.ok(!top(h).includes(AMBER));
    assert.ok(!top(h).includes(ACCENT));
  } finally {
    h.done();
  }
});

test("typing ! turns the border and the mark amber, at the first character", async () => {
  const h = mount();
  try {
    await until(h, () => typed(h).includes("say something"), "the box");
    h.stdin.type("!");
    await until(h, () => top(h).includes(AMBER), "the border to turn amber");
    assert.ok(first(h).includes(AMBER), "the > in front of the text is amber too");
    h.stdin.type("g");
    h.stdin.type("i");
    await until(h, () => typed(h).includes("!gi"), "the text");
    assert.ok(top(h).includes(AMBER), "it stays amber while the command is typed");
  } finally {
    h.done();
  }
});

test("taking the ! away turns it back, and a ! anywhere but the start does nothing", async () => {
  const h = mount();
  try {
    await until(h, () => typed(h).includes("say something"), "the box");
    h.stdin.type("!");
    await until(h, () => top(h).includes(AMBER), "amber");
    h.stdin.type(BACKSPACE);
    await until(h, () => !top(h).includes(AMBER), "the border to go back");
    for (const c of "hi !") h.stdin.type(c);
    await until(h, () => typed(h).includes("hi !"), "the text");
    assert.ok(!top(h).includes(AMBER), "a ! in the middle of a message is just a character");
  } finally {
    h.done();
  }
});

test("spaces before the ! still make it a command", async () => {
  const h = mount();
  try {
    await until(h, () => typed(h).includes("say something"), "the box");
    h.stdin.type(" ");
    h.stdin.type("!");
    await until(h, () => top(h).includes(AMBER), "amber after a leading space");
  } finally {
    h.done();
  }
});

test("Enter sends the line as typed, ! and all, for the app to run", async () => {
  const h = mount();
  try {
    await until(h, () => typed(h).includes("say something"), "the box");
    for (const c of "!git status") h.stdin.type(c);
    await until(h, () => typed(h).includes("!git status"), "the text");
    h.stdin.type("\r");
    await until(h, () => h.sent.length === 1, "the line to be sent");
    assert.equal(h.sent[0], "!git status");
    await until(h, () => !top(h).includes(AMBER), "the box to go back once sent");
  } finally {
    h.done();
  }
});
