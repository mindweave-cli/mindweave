/**
 * emptyArrow.probe.test.tsx — ← and → step between the main agent and its sub-agents, only while the message box is empty.
 *
 * With text in the box they move the caret as they always did; ↑ and ↓ are not used for this at all (they are for the history).
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");

const ESC = String.fromCharCode(27);
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;
const UP = `${ESC}[A`;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true as const;
  write(): boolean {
    return true;
  }
}
class FakeStdin extends EventEmitter {
  isTTY = true as const;
  private queue: string[] = [];
  setRawMode() { return this; }
  ref() { return this; }
  unref() { return this; }
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
  read(): string | null { return this.queue.shift() ?? null; }
  type(s: string): void { this.queue.push(s); this.emit("readable"); }
}

function mount() {
  const stdin = new FakeStdin();
  const calls: number[] = [];
  const sent: string[] = [];
  const instance = render(<PromptInput onSubmit={(t) => sent.push(t)} width={70} placeholder="say something…" onEmptyArrow={(d) => (calls.push(d), true)} />, {
    stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    interactive: true,
    debug: true,
    exitOnCtrlC: false,
  });
  return { stdin, calls, sent, stop: () => instance.unmount() };
}

test("← and → on an empty box are handed to the agent switch", async () => {
  const b = mount();
  await tick();
  b.stdin.type(LEFT);
  await tick();
  b.stdin.type(RIGHT);
  await tick();
  assert.deepEqual(b.calls, [-1, 1]);
  b.stop();
});

test("with text in the box they move the caret and switch nothing", async () => {
  const b = mount();
  await tick();
  b.stdin.type("a");
  await tick();
  b.stdin.type(LEFT);
  await tick();
  b.stdin.type(RIGHT);
  await tick();
  assert.deepEqual(b.calls, [], "an arrow with text in the box is the caret's");
  b.stop();
});

test("↑ is not used for it", async () => {
  const b = mount();
  await tick();
  b.stdin.type(UP);
  await tick();
  assert.deepEqual(b.calls, []);
  b.stop();
});
