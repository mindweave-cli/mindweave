/**
 * approvalText.addLine.probe.test.tsx — the box's typed row, driven for real.
 *
 * `/feedback` reuses this box in a way no other caller does: it asks AGAIN with the typed
 * line added, so the same mounted component is shown a second time. Found by driving the
 * real app — the field kept the text and the cursor, so a second Enter added the same line
 * twice, and getting out of the field needed an arrow key nobody would think to press.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { ApprovalBox } from "./components/ApprovalBox.js";

const ESCAPE = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const DOWN = ESCAPE + "[B";
const ANSI = new RegExp(ESCAPE + "\\[[0-9;?]*[A-Za-z]", "g");

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
  screen(): string {
    return (this.frames.filter((f) => f.includes("Send it")).at(-1) ?? "").replace(ANSI, "");
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

function mount() {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const events = { text: [] as string[], picked: [] as number[] };
  const instance = render(
    <ApprovalBox
      question="Send to the maintainer?"
      options={["Send it", "Don't send"]}
      freeText={{ label: "add a line", placeholder: "your email for a reply" }}
      onSelect={(i) => events.picked.push(i)}
      onSubmitText={(t) => events.text.push(t)}
      onCancel={() => {}}
      width={80}
    />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, interactive: true, debug: true },
  );
  return { stdin, stdout, events, done: () => instance.unmount() };
}

async function until(h: ReturnType<typeof mount>, ok: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. Screen:\n${h.stdout.screen()}`);
    h.stdin.pump();
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function typeText(h: ReturnType<typeof mount>, text: string) {
  for (const ch of text) {
    h.stdin.type(ch);
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("a line typed into the box is handed back, and the field is emptied after", async () => {
  const h = mount();
  try {
    await until(h, () => h.stdout.screen().includes("add a line"), "the box");
    // Keys typed before the box has read the previous one are queued, so each move waits
    // for the screen to show it before the next key goes in.
    h.stdin.type(DOWN);
    await until(h, () => /›\s*\[2\]/.test(h.stdout.screen()), "the highlight on the second answer");
    h.stdin.type(DOWN);
    await until(h, () => /›\s*\[3\]/.test(h.stdout.screen()), "the highlight on the typed row");
    await typeText(h, "me@example.com");
    await until(h, () => h.stdout.screen().includes("me@example.com"), "the typed line on screen");
    h.stdin.type(CR);
    await until(h, () => h.events.text.length > 0, "the typed answer");
    assert.deepEqual(h.events.text, ["me@example.com"]);

    // What the app probe caught: asked again, the field still held the text and the
    // cursor, so Enter added it twice.
    await until(h, () => !h.stdout.screen().includes("me@example.com"), "the field to empty");
    h.stdin.type(CR);
    await until(h, () => h.events.picked.length > 0, "the highlight to be back on an answer");
    assert.deepEqual(h.events.picked, [0], "Enter after a typed line must choose Send it, not retype the line");
    assert.deepEqual(h.events.text, ["me@example.com"], "the same line was submitted twice");
  } finally {
    h.done();
  }
});
