/**
 * menuContinuity.probe.test.tsx — one box, from the command list to what it opens.
 *
 * Everything the input can open — the command list, every picker, the key manager — shares
 * a single box under the input, and the point of sharing it is that moving between them is
 * a change of contents, not a box closing and another opening.
 *
 * Submitting clears the input, which closes the command list, and the surface the command
 * opens can only arrive after the work it does first. That left a render in between with
 * nothing to put in the box, so the box unmounted: its frame left the screen and came back,
 * visible as a flick on the way into every picker.
 *
 * Counted on real frames, because the gap is one render wide. Nothing about reading the
 * component shows whether a frame exists at that instant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Text } from "ink";

// Before Ink loads: chalk fixes its colour support at import time from the real
// process.stdout, not the stream it is handed.
process.env.FORCE_COLOR = "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/** Ink pulls input with `read()` after a `readable`, so a keystroke has to be queued and
 *  announced; emitting `data` at it is silently ignored. */
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
}

/** Top-left corners in the finished frame — one per box on screen. `debug` renders the
 *  whole screen each time, so this counts what is displayed, not what has accumulated. */
function boxes(frame: string): number {
  return (frame.match(/┌/g) ?? []).length;
}

/**
 * The most recent composited frame.
 *
 * Not simply the last write: Ink also writes bare terminal control sequences (bracketed
 * paste on and off, cursor moves), and one of those arriving after the frame would be read
 * as a screen with nothing on it. Every real frame carries the input box, so requiring a
 * box edge selects frames and rejects control writes without hiding the case this probe
 * exists for — a MISSING box still leaves the input's own edges behind.
 */
function lastFrame(frames: string[]): string {
  return frames.filter((f) => f.includes("└")).at(-1) ?? "";
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test("the box stays on screen from the command list through to what the command opens", async () => {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const completions = [{ name: "/provider", description: "switch provider" }];

  // `opening` is what App sets, synchronously, when a command that opens a surface here is
  // submitted — the same update that clears the input.
  let opening = false;
  // App marks the open from inside its own submit handler, so the mark and the clear that
  // closes the command list belong to the same update. Marking it afterwards would be a
  // different test: it would allow the empty render the hold exists to prevent.
  const view = () => (
    <PromptInput
      onSubmit={() => {
        opening = true;
        draw();
      }}
      opening={opening}
      completions={completions}
      width={60}
      placeholder="say something…"
    />
  );
  const draw = () => instance.rerender(view());

  const instance = render(view(), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    interactive: true,
    debug: true,
  });

  try {
    const last = () => lastFrame(stdout.frames);
    const rows = (frame: string) => frame.split(/\r?\n/).filter((r) => r.trim().length > 0).length;

    // Closed: the input box alone.
    await settle();
    assert.equal(boxes(last()), 1, "with nothing open there is just the input box");

    // The command list open: the input box and the box under it.
    stdin.type("/");
    await settle();
    assert.equal(boxes(last()), 2, "typing `/` opens the box under the input");
    const withList = rows(last());

    // Submit. The input clears and the command list closes; the picker is still a moment
    // away. This is the render the flick came from.
    stdin.type("\r");
    await settle();
    assert.equal(boxes(last()), 2, "the box holds its frame while the surface is on its way");
    // Holding the frame is only worth doing if the frame keeps its size while it is held: a
    // box that survives the transition but changes height moves the input and the chat above
    // it, which is what made the flick noticeable in the first place.
    assert.equal(rows(last()), withList, "and holds the size the command list had");

    // The surface arrives and takes the same box.
    opening = false;
    instance.rerender(
      <PromptInput
        onSubmit={() => {}}
        overlay={<Text>Switch provider</Text>}
        completions={completions}
        width={60}
        placeholder="say something…"
      />,
    );
    await settle();
    const arrived = last();
    assert.equal(boxes(arrived), 2, "the surface renders in the box that was already there");
    assert.ok(arrived.includes("Switch provider"), "and it is the surface's own content inside it");
  } finally {
    instance.unmount();
  }
});
