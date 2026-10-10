/**
 * openWrap.probe.test.tsx — an opened row shows a long line whole, carried on underneath.
 * Closed, the same line is cut at the edge as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { ToolLine } from "./components/ToolLine.js";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 24;
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

/** Waits until something has been drawn, however slow the machine is. */
async function firstFrame(out: { frames: string[] }): Promise<void> {
  const until = Date.now() + 5000;
  while (out.frames.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}

const TAIL = "ENDOFTHELONGLINE";
const LONG = `[Working directory is now gamo-app. ${"x".repeat(90)} ${TAIL}`;
const detail = `$ cd gamo-app\n(no output)\n${LONG}\n✓ 0 · 1s`;

async function paint(expanded: boolean): Promise<string> {
  const out = new FakeStdout();
  const app = render(
    <ToolLine id={1} full={detail} expanded={expanded} name="Run" arg="cd gamo-app" status="ok" action="run" detail={detail} detailKind="shell" columns={60} />,
    { stdout: out as unknown as NodeJS.WriteStream, stdin: fakeStdin(), debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  await firstFrame(out);
  const text = out.frames[out.frames.length - 1]!.replace(ANSI, "");
  app.unmount();
  return text;
}

test("opened, a long line carries on underneath instead of being cut", async () => {
  assert.ok((await paint(true)).includes(TAIL));
});

test("closed, a long line is still cut at the edge", async () => {
  assert.ok(!(await paint(false)).includes(TAIL));
});

async function paintDiff(detailText: string, full: string | undefined, expanded: boolean): Promise<string> {
  const out = new FakeStdout();
  const app = render(
    <ToolLine id={2} full={full} expanded={expanded} name="Update" arg="main.js" status="ok" action="edit" detail={detailText} detailKind="diff" columns={60} />,
    { stdout: out as unknown as NodeJS.WriteStream, stdin: fakeStdin(), debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  await firstFrame(out);
  const text = out.frames[out.frames.length - 1]!.replace(ANSI, "");
  app.unmount();
  return text;
}

test("an opened diff line carries on with a blank mark, so it is not read as another change", async () => {
  const long = `+ ${"a".repeat(35)}${"b".repeat(35)}`;
  const text = await paintDiff(long, long + "\n+ more", true);
  const rows = text.split("\n").filter((l) => /[ab]{5}/.test(l));
  assert.equal(rows.length, 2);
  assert.ok(rows[0]!.includes("+ aaa"), rows[0]);
  assert.ok(!rows[1]!.includes("+"), rows[1]);
});

test("a row with nothing to open says its hidden lines were not saved", async () => {
  const text = await paintDiff("+ one\n… (825 more lines)", undefined, false);
  assert.ok(text.includes("825 more lines, not saved in this chat"), text);
});

test("a row that can open does not carry the marker at all", async () => {
  const text = await paintDiff("+ one\n… (825 more lines)", "+ one\n+ two", false);
  assert.ok(!text.includes("825 more"), text);
});
