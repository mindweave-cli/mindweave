/**
 * toolRowClip.probe.test.tsx — a tool row scrolled out of the transcript stays out of it.
 *
 * Found by driving the whole app: after a few turns the pinned header read
 * "●MRun(node bg.js)──" instead of "Mindweave 1". The frame Ink composed already had the
 * tool row drawn over the header, so no amount of repainting could fix it.
 *
 * The cause is in how Ink clips. A box with `overflow: hidden` pushes its bounds as the
 * clip region, and Ink applies only the INNERMOST region rather than intersecting it with
 * the ones around it. The transcript viewport clips its scrolled content; a tool row that
 * also set `overflow: hidden` replaced that clip with its own bounds, so once the row
 * scrolled above the viewport nothing stopped it being drawn there, over the header.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Box, Text, render } from "ink";
import { ToolLine } from "./components/ToolLine.js";

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 20;
  isTTY = true;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: false, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  return stdin;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");

/** A header, then a 4-row clipped viewport whose content is scrolled up by `offset` rows. */
function frame(offset: number): string[] {
  const stdout = new FakeStdout();
  const rows = Array.from({ length: 8 }, (_, i) => (
    <ToolLine
      key={i}
      name="run_command"
      action="run"
      arg={`node step${i}.js`}
      status="ok"
      summary={`ran step ${i}`}
      columns={60}
      tightTop
    />
  ));
  const instance = render(
    <Box flexDirection="column" height={8} overflow="hidden">
      <Box flexShrink={0}>
        <Text>HEADER-ROW</Text>
      </Box>
      <Box flexShrink={0}>
        <Text>{"─".repeat(40)}</Text>
      </Box>
      <Box flexDirection="column" height={4} flexShrink={0} overflow="hidden">
        <Box flexDirection="column" flexShrink={0} marginTop={-offset}>
          {rows}
        </Box>
      </Box>
      <Box flexShrink={0}>
        <Text>FOOTER-ROW</Text>
      </Box>
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true },
  );
  const last = stdout.frames.filter((f) => f.includes("FOOTER-ROW")).at(-1) ?? "";
  instance.unmount();
  return last.replace(ANSI, "").split("\n");
}

test("tool rows scrolled above the transcript viewport are not drawn over the header", () => {
  const lines = frame(6);
  assert.equal(lines[0], "HEADER-ROW", `the header row was overwritten:\n${lines.join("\n")}`);
  assert.match(lines[1] ?? "", /^─+$/, `the rule under the header was overwritten:\n${lines.join("\n")}`);
});

test("the rows inside the viewport still show", () => {
  // Each tool row is two lines (the command, then its summary), so six lines up leaves
  // steps 3 and 4 in a four-line viewport.
  const text = frame(6).join("\n");
  assert.match(text, /step3/);
  assert.doesNotMatch(text, /step0|step1|step2/, "a row scrolled out of view is still on screen");
});

test("a long argument still does not run past the row", () => {
  const stdout = new FakeStdout();
  const instance = render(
    <Box flexDirection="column" width={40} overflow="hidden">
      <ToolLine name="run_command" action="run" arg={"node " + "x".repeat(200) + ".js"} status="ok" summary="ran" columns={40} tightTop />
      <Text>END</Text>
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true },
  );
  const last = (stdout.frames.filter((f) => f.includes("END")).at(-1) ?? "").replace(ANSI, "");
  instance.unmount();
  for (const line of last.split("\n")) assert.ok(line.length <= 40, `row ran to ${line.length} columns: ${line}`);
});
