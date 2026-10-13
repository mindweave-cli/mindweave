/**
 * commandHint.probe.test.tsx — the ctrl+X offer is on the command's own row.
 *
 * It first sat on the working line at the bottom of the screen, a long way from the command
 * it was about. It now comes after the command's timer, once the command has run for a
 * couple of seconds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { WorkGroup } from "./components/WorkGroup.js";
import type { WorkItem } from "./transcript.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true as const;
  frames: string[] = [];
  write(d: string): boolean {
    this.frames.push(d);
    return true;
  }
}
function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(s, { isTTY: false, setRawMode() {}, ref() {}, unref() {} });
  return s;
}

/** Paint, wait `waitMs`, and return the last frame as text. */
async function paint(items: WorkItem[], opts: { live?: boolean; columns?: number; waitMs?: number } = {}): Promise<string> {
  const out = new FakeStdout();
  out.columns = opts.columns ?? 100;
  const app = render(<WorkGroup id={1} items={items} live={opts.live ?? true} columns={out.columns} />, {
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, opts.waitMs ?? 120));
  const text = out.frames[out.frames.length - 1]!.replace(ANSI, "");
  app.unmount();
  return text;
}

const HINT = /ctrl\+X to run it in the background/;
const running = (startedAt: number, extra: Partial<WorkItem> = {}): WorkItem => ({ toolId: "a", name: "Run", arg: "npm run build", kind: "run", status: "running", startedAt, ...extra });

test("a command that has run for a while offers it on its own row", async () => {
  const text = await paint([running(Date.now() - 5_000)]);
  assert.match(text, /Running 1 command/);
  assert.match(text, HINT);
  const row = text.split("\n").find((l) => /Running 1 command/.test(l))!;
  assert.match(row, HINT, "on the same line as the command's header, not somewhere else");
});

test("a command that has only just started does not, and then does once two seconds pass", async () => {
  const items = [running(Date.now() - 1_000)];
  assert.doesNotMatch(await paint(items, { waitMs: 60 }), HINT, "a command that ends in a moment never needed the offer");
  assert.match(await paint(items, { waitMs: 1_300 }), HINT, "the row wakes itself when the time comes");
});

test("nothing is offered for a finished command, a check on a shell, a read, or a turn that has ended", async () => {
  const old = Date.now() - 9_000;
  assert.doesNotMatch(await paint([running(old, { status: "ok" })]), HINT);
  assert.doesNotMatch(await paint([running(old, { name: "Shell", arg: undefined })]), HINT, "polling a shell is not a command that can move");
  assert.doesNotMatch(await paint([{ toolId: "r", name: "Read", arg: "a.ts", kind: "read", status: "running", startedAt: old }]), HINT);
  assert.doesNotMatch(await paint([running(old)], { live: false }), HINT, "a row from a turn that has ended is not waiting on anything");
});

test("a row too narrow to hold it leaves it out rather than wrapping the header", async () => {
  assert.doesNotMatch(await paint([running(Date.now() - 5_000)], { columns: 60 }), HINT);
});
