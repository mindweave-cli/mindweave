/**
 * uiRow.probe.test.tsx — a UI test's row while it runs, and once it is done.
 *
 * Running: the dot breathes and the row is a header and ONE changing line, the step it is
 * on. Done: the steps, then a line about the page, then the way to open the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { ToolLine } = await import("./components/ToolLine.js");
const { PULSE_STEP_MS } = await import("./components/PulseDot.js");

const COLUMNS = 90;
const ESC = String.fromCharCode(27);
const plain = (raw: string) => raw.replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"), "");

class FakeStdout extends EventEmitter {
  columns = COLUMNS;
  rows = 30;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  return stdin;
}

function mount(props: Record<string, unknown>) {
  const stdout = new FakeStdout();
  const instance = render(<ToolLine name="Steps" arg="3 steps" status="ok" action="screenshot" columns={COLUMNS} {...(props as object)} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  return { stdout, instance };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("while it runs the row is the header and the one step it is on, not the log growing", () => {
  const log = ["1. Clicked [18] text box.", '2. Typed "One paragraph here.', "", 'And a second one." into [18].'].join("\n");
  const { stdout, instance } = mount({ status: "running", live: true, detail: log, detailKind: "shell" });
  const rows = plain(stdout.frames.at(-1) ?? "").split("\n").filter((r) => r.trim() !== "");
  instance.unmount();
  assert.equal(rows.length, 2, `a header and one line, got ${JSON.stringify(rows)}`);
  assert.match(rows[1]!, /2\. Typed/, "the latest step");
  assert.ok(rows[1]!.includes("↵") && rows[1]!.includes("And a second one"), "a typed line break is one row, not two");
  assert.ok(!rows.join("\n").includes("1. Clicked"), "earlier steps are not repeated while running");
});

test("a note that is not a numbered step still shows, as the one line", () => {
  const { stdout, instance } = mount({ status: "running", live: true, detail: "Waiting for the app on port 3000 to come up… 4s", detailKind: "shell" });
  const text = plain(stdout.frames.at(-1) ?? "");
  instance.unmount();
  assert.ok(text.includes("Waiting for the app on port 3000"));
});

test("the dot breathes while the test runs, and is still once it is done", async () => {
  const dotCodes = (raw: string): string => {
    const at = raw.indexOf("●");
    assert.ok(at > 0, "no dot on screen");
    return raw.slice(Math.max(0, at - 24), at);
  };
  const running = mount({ status: "running", live: true, detail: "1. Clicked it." , detailKind: "shell" });
  const first = dotCodes(running.stdout.frames.at(-1) ?? "");
  // Until its shade moves, however slow the machine is: the check is that it does, not when.
  let later = first;
  for (const until = Date.now() + 5000; later === first && Date.now() < until; ) {
    await sleep(PULSE_STEP_MS / 2);
    later = dotCodes(running.stdout.frames.at(-1) ?? "");
  }
  assert.ok(running.stdout.frames.length > 1, "the dot redrew itself");
  assert.notEqual(first, later, "its shade moved");
  running.instance.unmount();

  const done = mount({ status: "ok", live: false, detail: "1. Clicked it.\npage: 3 elements — 3 buttons" });
  const a = dotCodes(done.stdout.frames.at(-1) ?? "");
  await sleep(PULSE_STEP_MS * 3 + 80);
  const b = dotCodes(done.stdout.frames.at(-1) ?? "");
  assert.equal(a, b, "a finished row's dot does not move");
  assert.equal(done.stdout.frames.length, 1, "and nothing redraws");
  done.instance.unmount();
});

test("when it is done: the steps, the page in one line, and the way to open the rest", () => {
  const detail = ["1. Clicked [18] text box.", "2. Typed it.", "3. Waited.", "page: 19 elements — 14 buttons, 2 tabs, 2 dropdowns"].join("\n");
  const full = [detail, ...Array.from({ length: 19 }, (_, i) => `[${i + 1}] button "B${i}"`)].join("\n");
  const { stdout, instance } = mount({ status: "ok", live: false, detail, full, expanded: false });
  const rows = plain(stdout.frames.at(-1) ?? "").split("\n").filter((r) => r.trim() !== "");
  instance.unmount();
  assert.equal(rows.length, 1 + 4 + 1, "header, three steps, the page line, the hint");
  assert.match(rows[4]!, /page: 19 elements/);
  assert.match(rows[5]!, /click to show all 23 lines/);
});
