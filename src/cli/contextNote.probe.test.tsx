/**
 * contextNote.probe.test.tsx — the note for an automatic compaction is shown whole, wrapped, never cut with "…".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { BlockView } from "./components/BlockView.js";
import { coldCompactionLine } from "../dynamo/contextWindow.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
class FakeStdout extends EventEmitter {
  columns = 80;
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

test("a long compaction note wraps and ends with its last words", async () => {
  const text = coldCompactionLine("idle", "m", 1066 * 60_000);
  const out = new FakeStdout();
  const app = render(<BlockView block={{ kind: "context", id: 1, done: true, text }} columns={80} />, {
    stdout: out as unknown as NodeJS.WriteStream, stdin: stdin(), debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, 120));
  const shown = out.frames[out.frames.length - 1]!.replace(ANSI, "");
  app.unmount();
  assert.ok(!shown.includes("…"), shown);
  assert.ok(shown.includes("latest work were kept."), shown);
});
