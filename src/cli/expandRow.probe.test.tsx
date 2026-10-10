/**
 * expandRow.probe.test.tsx — a long output opens on a click and folds on the next one.
 *
 * Three things have to agree for a click to do anything, and none of them errors when it
 * is wrong: the transcript has to keep the uncut text and flip the flag, the row has to
 * draw the other text when it is flipped, and the click has to be traced to the row it
 * landed on. The last one is the fragile one, so it is checked against a real layout and
 * a real paint rather than against arithmetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Box, Text, type DOMElement } from "ink";
import { hasMore, initialState, lastExpandable, reduce, type Action, type TranscriptState } from "./transcript.js";
import { expandableAt, rowAt } from "./expandHits.js";
import { ToolLine } from "./components/ToolLine.js";

const COLUMNS = 80;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

class FakeStdout extends EventEmitter {
  columns = COLUMNS;
  rows = 24;
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

function run(actions: Action[]): TranscriptState {
  return actions.reduce(reduce, initialState());
}

const SHORT = "$ ls\nfile1\n✓ 0 · 5ms";
const LONG = ["$ ls", ...Array.from({ length: 40 }, (_, i) => `file${i}`), "✓ 0 · 5ms"].join("\n");

function finished(detail: string, detailFull?: string): TranscriptState {
  return run([
    { type: "toolStart", toolId: "a", name: "Run", arg: "ls", action: "run" },
    { type: "toolEnd", toolId: "a", ok: true, summary: "ran", detail, detailFull, detailKind: "shell" },
  ]);
}

test("a result with more behind it keeps the uncut text, and one without does not", () => {
  const long = finished(SHORT, LONG).committed[0]!;
  assert.equal(long.kind === "tool" && long.full, LONG);
  const same = finished(SHORT, SHORT).committed[0]!;
  assert.equal(same.kind === "tool" && same.full, undefined, "nothing more to show means nothing to open");
  const none = finished(SHORT).committed[0]!;
  assert.equal(none.kind === "tool" && none.full, undefined);
  assert.equal(hasMore("a", "a\nb"), true);
  assert.equal(hasMore("a\nb", "a"), false);
});

test("toggling flips the row, in the committed list where a finished row already is", () => {
  let s = finished(SHORT, LONG);
  const id = s.committed[0]!.id;
  assert.equal(s.tail.length, 0, "the finished row has drained into committed");
  s = reduce(s, { type: "toggleExpand", id });
  assert.equal((s.committed[0] as { expanded?: boolean }).expanded, true);
  s = reduce(s, { type: "toggleExpand", id });
  assert.equal((s.committed[0] as { expanded?: boolean }).expanded, false);
});

test("a row with nothing more to show ignores a toggle, and the keyboard finds the newest that has", () => {
  let s = finished(SHORT);
  const id = s.committed[0]!.id;
  assert.equal((reduce(s, { type: "toggleExpand", id }).committed[0] as { expanded?: boolean }).expanded, undefined);
  assert.equal(lastExpandable(s), null);
  s = reduce(s, { type: "toolStart", toolId: "b", name: "Run", arg: "ls", action: "run" });
  s = reduce(s, { type: "toolEnd", toolId: "b", ok: true, summary: "ran", detail: SHORT, detailFull: LONG, detailKind: "shell" });
  assert.equal(lastExpandable(s), s.committed[1]!.id);
});

test("the block under a screen row is found, and only inside the transcript's own area", () => {
  const spans = [
    { id: 1, top: 2, height: 3 },
    { id: 2, top: 6, height: 10 },
  ];
  const view = { top: 0, height: 12 };
  assert.equal(rowAt(spans, 2, view), 1);
  assert.equal(rowAt(spans, 4, view), 1);
  assert.equal(rowAt(spans, 5, view), null, "the blank row between them");
  assert.equal(rowAt(spans, 8, view), 2);
  // Row 13 is inside block 2's layout but outside the visible transcript: that is the
  // input box, and a click there must not fold anything.
  assert.equal(rowAt(spans, 13, view), null);
});

function Frame({ expanded }: { expanded: boolean }): React.ReactElement {
  const chatRef = (node: DOMElement | null) => {
    chat = node;
  };
  return (
    <Box flexDirection="column" height={60} overflow="hidden">
      <Box ref={chatRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box flexShrink={0} flexDirection="column">
          <ToolLine id={7} name="Run" arg="ls" status="ok" action="run" detail={SHORT} detailKind="shell" columns={COLUMNS} full={LONG} expanded={expanded} />
        </Box>
        <Box flexShrink={0} flexDirection="column">
          <ToolLine id={8} name="Run" arg="pwd" status="ok" action="run" detail={SHORT} detailKind="shell" columns={COLUMNS} />
        </Box>
      </Box>
      <Box flexShrink={0}>
        <Text>INPUTBOX</Text>
      </Box>
    </Box>
  );
}
let chat: DOMElement | null = null;

function draw(expanded: boolean): { rows: string[]; hit: (y: number) => number | null; done: () => void } {
  const stdout = new FakeStdout();
  const instance = render(<Frame expanded={expanded} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  const rows = (stdout.frames.at(-1) ?? "").replace(ANSI, "").split("\n");
  return { rows, hit: (y) => expandableAt(y, 0, chat), done: () => instance.unmount() };
}

test("collapsed, the row says how much more there is and a click on it is traced to it", () => {
  const { rows, hit, done } = draw(false);
  const hint = rows.findIndex((r) => r.includes("click to show all 42 lines"));
  const header = rows.findIndex((r) => r.includes("Run(ls)"));
  assert.ok(hint > 0 && header >= 0, `rows: ${JSON.stringify(rows)}`);
  assert.equal(hit(header), 7, "a click on the header opens it");
  assert.equal(hit(hint), 7, "so does a click on the hint");
  const other = rows.findIndex((r) => r.includes("Run(pwd)"));
  assert.equal(hit(other), null, "a row with nothing more to show is not a button");
  assert.equal(hit(rows.findIndex((r) => r.includes("INPUTBOX"))), null, "the input box is not a button");
  done();
});

test("expanded, every line is on screen and the hint offers to fold it", () => {
  const { rows, hit, done } = draw(true);
  const text = rows.join("\n");
  assert.ok(text.includes("file0") && text.includes("file39"), "the whole output is drawn");
  assert.ok(text.includes("▾ click to fold"), "the one line that says so now offers to fold");
  assert.ok(!text.includes("▸ click to show all"), "and no longer offers to open");
  assert.ok(!text.includes("click to show all"));
  const middle = rows.findIndex((r) => r.includes("file20"));
  assert.equal(hit(middle), 7, "a click anywhere in the opened text folds it again");
  done();
});

test("a file preview's own '… (N more lines)' line is not said a second time beside the click hint", () => {
  const detail = ["+ a", "+ b", "  … (30 more lines)"].join("\n");
  const full = Array.from({ length: 32 }, (_, i) => `+ ${i}`).join("\n");
  const stdout = new FakeStdout();
  const instance = render(
    <ToolLine id={1} name="Write" arg="x.md" status="ok" action="write" detail={detail} detailKind="diff" columns={COLUMNS} full={full} expanded={false} />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true },
  );
  const text = (stdout.frames.at(-1) ?? "").replace(ANSI, "");
  instance.unmount();
  assert.ok(text.includes("click to show all 32 lines"));
  assert.ok(!text.includes("30 more lines"), "the cut marker and the hint said the same thing twice");
});

test("a cut that hid only one line still counts as hiding something, for both kinds of cut", () => {
  assert.equal(hasMore("a\nb\n  … (1 more line)", "a\nb\nc"), true, "a diff cut by one line");
  assert.equal(hasMore("a\n… 1 earlier line hidden\nz", "a\nb\nz"), true, "a command's output cut by one line");
  assert.equal(hasMore("a\nb\n  … (2 more lines)", "a\nb"), false, "a full block that is not longer is not more");
  assert.equal(hasMore("a\nb", "a\nb"), false);
});
