/**
 * workDot.probe.test.tsx — a work row has a dot only while the work goes on.
 *
 * Commands, tests, reads and searches pulse while they run and lose the dot once they are done, leaving just the words:
 * `Ran 2 commands ▸`.
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
const stdin = (): NodeJS.ReadStream => {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(s, { isTTY: false, setRawMode() {}, ref() {}, unref() {} });
  return s;
};
async function paint(items: WorkItem[], live: boolean): Promise<string> {
  const out = new FakeStdout();
  const app = render(<WorkGroup id={1} items={items} live={live} columns={100} />, { stdout: out as unknown as NodeJS.WriteStream, stdin: stdin(), debug: true, exitOnCtrlC: false, patchConsole: false });
  await new Promise((r) => setTimeout(r, 120));
  const text = out.frames[out.frames.length - 1]!.replace(ANSI, "");
  app.unmount();
  return text;
}
const run = (id: string, status: WorkItem["status"]): WorkItem => ({ toolId: id, name: "Run", arg: `cmd ${id}`, kind: "run", status, startedAt: Date.now() - 2000 });

test("a finished row of commands is its words alone, with no dot", async () => {
  const text = await paint([run("a", "ok"), run("b", "ok")], false);
  assert.match(text, /Ran 2 commands/);
  assert.doesNotMatch(text, /●/);
});

test("while the commands run the dot is there", async () => {
  const text = await paint([run("a", "running")], true);
  assert.match(text, /Running/);
  assert.match(text, /●/);
});
