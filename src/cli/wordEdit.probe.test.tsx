/**
 * wordEdit.probe.test.tsx — the chunk-editing chords, driven as real keystrokes.
 *
 * wordEdit.test.ts pins the boundary maths, which is a different claim from "the key does
 * something when you press it". A chord can be computed perfectly and still be dead
 * because a handler above it claimed the same key, or because the terminal never reports
 * it in the form the binding expects. That is only visible by pushing bytes at a live
 * component and reading the frame that comes back, which is what this does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink loads: chalk fixes its colour support at import time from the real
// process.stdout, not the stream it is handed.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/** Ink 7 pulls input with `read()` on a `readable` event; an emitter that only emits
 *  `data` has no listeners at all and every key is silently dropped. */
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

/** The bytes a terminal actually sends, checked against Ink's parser rather than assumed.
 *  Ctrl+Backspace is absent because it arrives indistinguishable from a bare Backspace,
 *  which is exactly why it is not bound. */
const KEY = {
  ctrlW: "\x17",
  ctrlK: "\x0b",
  ctrlU: "\x15",
  altBackspace: "\x1b\x7f",
  ctrlDelete: "\x1b[3;5~",
  ctrlLeft: "\x1b[1;5D",
  ctrlRight: "\x1b[1;5C",
  backspace: "\x7f",
};

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\[[0-9;?]*[A-Za-z]", "g");
const BAR = "\u2502";
/** One half of the caret's blink. Sampling longer than this guarantees an on-beat. */
const BLINK_MS = 530;

/**
 * Type `text`, then send `keys`, and return what the input row holds afterwards.
 *
 * Read from a frame drawn AFTER the keys have settled, and on a beat where the caret is
 * lit, so the bar can be removed and what is left is exactly the buffer.
 */
async function afterKeys(text: string, ...keys: string[]): Promise<string> {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const instance = render(<PromptInput onSubmit={() => {}} width={80} placeholder="" />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    interactive: true,
    debug: true,
  });

  // One character at a time: a single large chunk trips the paste assembler, which
  // buffers and flushes on a timer, and this would become a test of pasting.
  for (const ch of text) {
    stdin.type(ch);
    await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 20));
  for (const k of keys) {
    stdin.type(k);
    await new Promise((r) => setTimeout(r, 20));
  }

  // Settle first, and THROW AWAY everything drawn up to here. The frames from typing are
  // real frames of a half-typed line, and reading them is how this returned the state
  // after the first keystroke instead of the last.
  await new Promise((r) => setTimeout(r, 40));
  const rowOf = (frame: string) => frame.replace(ANSI, "").split(/\r?\n/).find((r) => r.includes(">"));

  // The settled frame is the one to read, and it is guaranteed to be an ON-beat: the
  // caret restarts its cycle lit on every keystroke, so the frame drawn after the last
  // key has the bar in it. Sampling for a blink afterwards is belt and braces — a window
  // shorter than a full cycle can otherwise contain only the off-beat, which is exactly
  // how this came back with a space where the caret should be.
  const rows: string[] = [];
  const settled = rowOf(stdout.frames[stdout.frames.length - 1] ?? "");
  if (settled !== undefined) rows.push(settled);
  stdout.frames.length = 0;

  const deadline = Date.now() + BLINK_MS * 1.4;
  while (Date.now() < deadline) {
    for (const frame of stdout.frames.splice(0)) {
      const row = rowOf(frame);
      if (row !== undefined) rows.push(row);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  instance.unmount();

  const bars = (s: string) => s.split(BAR).length - 1;
  const onBeat = rows.reduce((best, r) => (bars(r) > bars(best) ? r : best), rows[0] ?? "");
  // Drop the box border, the caret, the prompt marker and the padding.
  return onBeat.split(BAR).join("").replace(/^\s*>\s?/, "").trimEnd();
}

test("Ctrl+W deletes the word behind the cursor, not the whole line", async () => {
  assert.equal(await afterKeys("fix the failing test", KEY.ctrlW), "fix the failing");
});

test("Ctrl+W twice takes two words", async () => {
  assert.equal(await afterKeys("fix the failing test", KEY.ctrlW, KEY.ctrlW), "fix the");
});

test("a dropped path goes in ONE press", async () => {
  // The case that started this: a path is one thing you want gone, not eight.
  assert.equal(await afterKeys("look at C:/Users/dev/Pictures/shot.png", KEY.ctrlW), "look at");
});

test("Alt+Backspace does the same as Ctrl+W", async () => {
  assert.equal(await afterKeys("one two three", KEY.altBackspace), "one two");
});

test("Ctrl+Delete takes the word AHEAD of the cursor", async () => {
  // The cursor is at the end, so walk it back over "three" first.
  assert.equal(await afterKeys("one two three", KEY.ctrlLeft, KEY.ctrlDelete), "one two");
});

test("Ctrl+K clears from the cursor to the end of the line", async () => {
  assert.equal(await afterKeys("keep this drop this", KEY.ctrlLeft, KEY.ctrlLeft, KEY.ctrlK), "keep this");
});

test("Ctrl+Left moves by a word, so typing lands before it", async () => {
  assert.equal(await afterKeys("alpha beta", KEY.ctrlLeft, "X"), "alpha Xbeta");
});

test("Ctrl+Left then Ctrl+Right returns the cursor where it started", async () => {
  // If the pair were not mirrors, the marker would land somewhere other than the end.
  assert.equal(await afterKeys("alpha beta", KEY.ctrlLeft, KEY.ctrlRight, "!"), "alpha beta!");
});

test("plain Backspace still deletes exactly one character", async () => {
  // The chord handlers sit above this one; a mistake in their order would eat a word.
  assert.equal(await afterKeys("hello", KEY.backspace), "hell");
});

test("Ctrl+U still clears the line", async () => {
  assert.equal(await afterKeys("throw all of this away", KEY.ctrlU), "");
});

test("typing a plain w is not Ctrl+W", async () => {
  assert.equal(await afterKeys("wow"), "wow");
});
