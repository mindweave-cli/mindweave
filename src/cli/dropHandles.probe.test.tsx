/**
 * dropHandles.probe.test.tsx — a dropped file is short IN THE BOX, not just in theory.
 *
 * dropHandles.test.ts proves the substitution is correct on a string. That is a different
 * claim from "the path never appears in the input", which depends on the drop arriving
 * through the paste assembler and on the handler being reached at all. A drop is not a
 * keystroke: the terminal wraps it in bracketed-paste markers and it can arrive split
 * across chunks, so this pushes the real bytes at a live component and reads the frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDropHandles } from "./dropHandles.js";

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

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");
const BAR = "\u2502";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const WIN_PATH = "C:\\Users\\dev\\Pictures\\Screenshots\\Screenshot 2026-09-06 091037.png";

/**
 * Drop `dropped` into the box (as a real bracketed paste), optionally after typing
 * `before`, and return the row the box ends up showing.
 *
 * The last frame is the whole answer: nothing in the input animates, so once the drop has
 * settled the screen stops changing.
 */
async function boxAfterDrop(before: string, dropped: string): Promise<string> {
  const handles = createDropHandles((p) => p);
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const instance = render(
    <PromptInput
      onSubmit={() => {}}
      width={80}
      placeholder=""
      onDroppedPaths={(text) => handles.register(text)}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      interactive: true,
      debug: true,
    },
  );

  for (const ch of before) {
    stdin.type(ch);
    await new Promise((r) => setTimeout(r, 2));
  }
  stdin.type(PASTE_START + dropped + PASTE_END);
  await new Promise((r) => setTimeout(r, 60));

  await new Promise((r) => setTimeout(r, 40));
  const last = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  const row = last.replace(ANSI, "").split(/\r?\n/).find((r) => r.includes(">")) ?? "";
  // Drop the box border, the caret and the prompt marker. The settled frame is an ON-beat
  // (the caret restarts lit on every input), so the caret is a bar here and comes out with
  // the border rather than leaving the extra space an off-beat frame would.
  return row.split(BAR).join("").replace(/^\s*>\s?/, "").trimEnd();
}

test("a dropped image shows as mwimg1, and the path is nowhere in the box", async () => {
  const row = await boxAfterDrop("look at ", `"${WIN_PATH}"`);
  assert.equal(row, "look at mwimg1");
  assert.ok(!row.includes("Screenshot"), "the file name leaked into the input");
  assert.ok(!row.includes("C:"), "the path leaked into the input");
});

test("a dropped text file shows as mwfile1", async () => {
  assert.equal(await boxAfterDrop("read ", '"C:\\src\\notes.txt"'), "read mwfile1");
});

test("an unquoted drop is shortened too", async () => {
  assert.equal(await boxAfterDrop("open ", "/home/me/notes.md"), "open mwfile1");
});

test("the handle is short enough that a long path no longer wraps the box", async () => {
  // The complaint underneath this feature: one dropped screenshot pushed the line past
  // the width of the terminal on its own.
  const row = await boxAfterDrop("", `"${WIN_PATH}"`);
  assert.ok(WIN_PATH.length > 60, "sanity: the path really is long");
  assert.ok(row.length < 12, `still long: ${JSON.stringify(row)}`);
});

test("an ordinary paste that is not a path is left exactly as pasted", async () => {
  assert.equal(await boxAfterDrop("say ", "hello there"), "say hello there");
});
