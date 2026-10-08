/**
 * toolColour.probe.test.tsx — a tool result has to be readable at a glance.
 *
 * Reported after looking at a real session beside another agent: the diffs and shell
 * output read as "a dead agent". The colour was technically there — a red `-` row and a
 * green `+` row — and it was flat: two inks a shade apart, on a dark terminal, among a
 * dozen equally plain rows. The change a diff reports is the entire reason the row
 * exists, and it should be findable without reading it.
 *
 * This asserts on the ANSI actually emitted, because that is the only thing that says
 * what a user sees. Every unit test passed for the whole time the screen looked dead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// BEFORE Ink and chalk are loaded. Chalk decides colour support once, at import time,
// from the REAL process.stdout — not from the stream Ink is handed — so a fake terminal
// with isTTY set is not enough and the frames come back with no escapes at all. That is
// worth stating: a probe that reads styling and forgets this measures a blank string and
// passes whatever it asserts about "no colour".
process.env.FORCE_COLOR = "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { ToolLine } = await import("./components/ToolLine.js");

/** A stdout Ink and chalk both accept as a colour-capable terminal. */
class ColourTerm extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/** Render a tool row and return the frame that actually carried its text. */
async function frameOf(element: React.ReactElement, needle: RegExp): Promise<string> {
  const stdout = new ColourTerm();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};

  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
    interactive: true,
  });
  // WAIT for the frame rather than sleeping a fixed amount. A fixed sleep encodes the
  // speed of the machine that wrote it: 60ms passed here for weeks and the same render
  // took 345ms on CI, which is how the queue probe came to fail only there.
  const deadline = Date.now() + 10_000;
  let frame: string | undefined;
  for (;;) {
    frame = stdout.frames.filter((fr) => needle.test(fr)).at(-1);
    if (frame || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  instance.unmount();
  assert.ok(frame, "nothing rendered the content this probe measures");
  return frame;
}

/** The SGR run introducing a line, so a background can be told from a foreground. */
function styleOn(frame: string, line: RegExp): string {
  const row = frame.split(/\r?\n/).find((r) => line.test(r));
  assert.ok(row, `no row matched ${line}`);
  return row;
}

test("an added line carries a background, not just green text", async () => {
  const frame = await frameOf(
    <ToolLine
      name="Update"
      arg="cart.js"
      status="ok"
      action="edit"
      detail={"- const a = 1;\n+ const a = 2;"}
      detailKind="diff"
      columns={100}
    />,
    /const a = 2/,
  );
  const added = styleOn(frame, /const a = 2/);
  // 48;2;r;g;b is a truecolour BACKGROUND. Foreground alone (38/3x) is what read flat.
  assert.match(added, /\x1b\[48;2;\d+;\d+;\d+m/, "the added row has no background tint");
});

test("a removed line carries its own, different background", async () => {
  const frame = await frameOf(
    <ToolLine
      name="Update"
      arg="cart.js"
      status="ok"
      action="edit"
      detail={"- const a = 1;\n+ const a = 2;"}
      detailKind="diff"
      columns={100}
    />,
    /const a = 1/,
  );
  const removed = styleOn(frame, /const a = 1/);
  const added = styleOn(frame, /const a = 2/);
  const bg = (row: string) => row.match(/\x1b\[48;2;(\d+;\d+;\d+)m/)?.[1];
  assert.ok(bg(removed), "the removed row has no background tint");
  assert.notEqual(bg(removed), bg(added), "added and removed must not be the same colour");
});

test("the tint runs the width of the row, not just under the code", async () => {
  // A band that stops wherever the line happens to end reads as a ragged smear rather
  // than as a marked row.
  const frame = await frameOf(
    <ToolLine name="Update" arg="a.ts" status="ok" action="edit" detail={"+ x"} detailKind="diff" columns={100} />,
    /\+ x/,
  );
  const row = styleOn(frame, /\+ x/);
  const painted = row.slice(row.indexOf("+ x"));
  assert.ok(painted.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().length < painted.replace(/\x1b\[[0-9;]*m/g, "").length,
    "the tinted run was not padded past the end of the text");
});

test("ordinary text is NOT tinted", async () => {
  // The tint means "this line changed". A plain result must not borrow it, or it stops
  // meaning anything.
  const frame = await frameOf(
    <ToolLine name="Read" arg="a.ts" status="ok" action="read" detail={"- not a diff, just a dash"} columns={100} />,
    /not a diff/,
  );
  assert.doesNotMatch(styleOn(frame, /not a diff/), /\x1b\[48;2;/, "a non-diff result was painted as one");
});

test("a shell command is distinguishable from its output", async () => {
  // The one line in a shell block the user effectively wrote. It was bold and nothing
  // else, which loses against a screenful of equally plain machine text.
  const frame = await frameOf(
    <ToolLine
      name="Run"
      status="ok"
      action="run"
      detail={"$ npm run build\nsome output\n✓ Exit code 0"}
      detailKind="shell"
      columns={100}
    />,
    /npm run build/,
  );
  const command = styleOn(frame, /npm run build/);
  const output = styleOn(frame, /some output/);
  assert.match(command, /\x1b\[38;2;\d+;\d+;\d+m/, "the command marker has no colour of its own");
  assert.notEqual(
    command.match(/\x1b\[38;2;(\d+;\d+;\d+)m/)?.[1],
    output.match(/\x1b\[38;2;(\d+;\d+;\d+)m/)?.[1],
    "the command reads the same as its output",
  );
});
