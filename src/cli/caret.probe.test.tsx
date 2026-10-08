/**
 * caret.probe.test.tsx — the caret takes no column, and nothing animates.
 *
 * Three shapes were tried before this one, and each was wrong in the same place: a
 * terminal grid has no room BETWEEN two cells, so anything the app draws has to live in
 * one. Standing on a character hid it for half of every blink. Taking a column of its own
 * opened a space between the characters it sat between — the one thing a real text field
 * never does, and the complaint that ended the experiment.
 *
 * Nothing is drawn now. The terminal's own cursor is parked at the caret after each frame
 * (see caretPark.ts): no column, no timer of ours, and whatever blink the user already
 * chose in their terminal. What is asserted here is the absence — no gap, no glyph, no
 * motion — which only shows up across real frames, so the frames are watched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink loads: chalk fixes its colour support at import time from the real
// process.stdout, not the stream it is handed.
process.env.FORCE_COLOR = "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");

class FakeStdout extends EventEmitter {
  columns = 50;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/** A stdin Ink accepts for raw mode. Without this it replaces the UI with an error
 *  frame, and a probe reading "the last frame" would measure that instead. */
class FakeStdin extends EventEmitter {
  isTTY = true as const;
  setRawMode() { return this; }
  ref() { return this; }
  unref() { return this; }
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
  /** Keystrokes waiting to be pulled. Ink 7 takes input by calling `read()` on a
   *  `readable` event, not by listening for `data` — an emitter that only emits `data`
   *  has no listeners at all and every key is silently dropped. */
  private readonly queue: string[] = [];
  read(): string | null { return this.queue.shift() ?? null; }
  type(s: string): void { this.queue.push(s); this.emit("readable"); }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");
const BAR = "│";
/** Long enough that any animation would have shown itself several times over. */
const WATCH_MS = 2000;

interface Watched {
  /** Every DISTINCT value the prompt row took while being watched. Empty is the
   *  CORRECT result now: an idle input renders nothing at all. */
  rows: string[];
  readings: number;
  /** The row as it stands once the input has settled — the last frame actually drawn. */
  settled: string;
}

/**
 * Type `text` one character at a time, then send each of `keys` as ONE chunk, then watch
 * the prompt row.
 *
 * Keys are separate from text because an escape sequence is not a sequence of keystrokes:
 * typing a left arrow character by character sends ESC, then "[", then "D", which is
 * three pieces of nonsense rather than one key.
 */
async function watch(text: string, marker: string, ...keys: string[]): Promise<Watched> {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const instance = render(<PromptInput onSubmit={() => {}} width={50} placeholder="type here" />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    interactive: true,
    debug: true,
  });

  for (const ch of text) {
    stdin.type(ch);
    await new Promise((r) => setTimeout(r, 3));
  }
  for (const k of keys) {
    stdin.type(k);
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 40));

  const rowOf = (frame: string): string =>
    frame.replace(ANSI, "").split(/\r?\n/).find((r) => r.includes(marker)) ?? "";

  // The settled row: the LAST frame drawn, which is the input as it now stands. Taken
  // before the watch window, because there may be no frames during it at all — nothing
  // animates any more, and that is the point.
  const settled = rowOf(stdout.frames[stdout.frames.length - 1] ?? "");
  stdout.frames.length = 0;

  const rows: string[] = [];
  let readings = 0;
  const deadline = Date.now() + WATCH_MS;
  while (Date.now() < deadline) {
    for (const frame of stdout.frames.splice(0)) {
      const row = rowOf(frame);
      if (!row) continue;
      readings++;
      if (row !== rows[rows.length - 1]) rows.push(row);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  instance.unmount();
  return { rows, readings, settled };
}

const LEFT = "[D";

test("the text has NO GAP where the caret sits", async () => {
  // The complaint that ended the drawn caret. With the cursor walked into the middle of
  // the word, "abc" must still read as "abc" — a column taken for a caret would split it.
  const seen = await watch("abc", ">", LEFT, LEFT);
  assert.notEqual(seen.settled, "", "the input never drew a row at all");
  for (const row of [seen.settled, ...seen.rows]) {
    assert.ok(row.includes("abc"), `the caret broke the text apart: ${JSON.stringify(row)}`);
  }
});

test("no caret glyph is drawn into the row", async () => {
  // The bars in a row are the box border, one each side. A third would be a drawn caret,
  // which is the thing that took a column.
  const seen = await watch("hi", ">");
  assert.notEqual(seen.settled, "", "the input never drew a row at all");
  for (const row of [seen.settled, ...seen.rows]) {
    const bars = row.split(BAR).length - 1;
    assert.ok(bars <= 2, `a caret glyph is still being drawn: ${JSON.stringify(row)}`);
  }
});

test("nothing animates: an idle input never changes on its own", async () => {
  // There is no blink of ours left to run. Whatever blinks is the terminal's cursor,
  // under the user's own settings, and it costs this process nothing.
  const seen = await watch("hello", ">");
  const distinct = [...new Set(seen.rows)];
  assert.ok(distinct.length <= 1, `the row changed on its own: ${JSON.stringify(distinct.slice(0, 3))}`);
});
