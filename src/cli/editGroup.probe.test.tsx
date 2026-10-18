/**
 * editGroup.probe.test.tsx — edits that follow each other are one row from the third on.
 *
 * What joins it, what ends it, what its header says, where a click on a name lands, and how it paints.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { initialState, reduce, type Action, type Block, type TranscriptState } from "./transcript.js";
import { EditGroup } from "./components/EditGroup.js";
import { editStats, editsHead, headerLayout, isGrouped, nameAt } from "./editGroup.js";

type Edits = Extract<Block, { kind: "edits" }>;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
class FakeStdout extends EventEmitter {
  columns = 90;
  rows = 40;
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

const run = (actions: Action[], from: TranscriptState = initialState()): TranscriptState => actions.reduce(reduce, from);
const w = (id: string, file: string, name = "Write", action: "edit" | "write" = "write"): Action => ({ type: "toolStart", toolId: id, name, arg: file, action });
const done = (id: string, detail = "whole file · 4 lines\n+ 1 │ a\n+ 2 │ b\n+ 3 │ c\n+ 4 │ d", ok = true): Action => ({ type: "toolEnd", toolId: id, ok, summary: "ok", detail, detailKind: "diff" });
const all = (s: TranscriptState): Block[] => [...s.committed, ...s.tail];
const groups = (s: TranscriptState): Edits[] => all(s).filter((b): b is Edits => b.kind === "edits");

test("edits that follow each other join one block, and the header counts the files", () => {
  const s = run([w("a", "src/a.ts"), done("a"), w("b", "src/b.ts"), done("b"), w("c", "src/c.ts"), done("c"), { type: "endTurn" }]);
  assert.equal(groups(s).length, 1);
  const g = groups(s)[0]!;
  assert.equal(g.items.length, 3);
  assert.ok(isGrouped(g.items));
  assert.equal(editsHead(g.items, g.live), "Wrote 3 files");
});

test("a command, a read or a sentence ends the block: they are never in it", () => {
  const read: Action = { type: "toolStart", toolId: "r", name: "Read", arg: "x.ts", action: "read", group: true };
  const s = run([w("a", "a.ts"), done("a"), read, { type: "toolEnd", toolId: "r", ok: true, summary: "read" }, w("b", "b.ts"), done("b"), { type: "token", delta: "Next." }, w("c", "c.ts"), done("c"), { type: "endTurn" }]);
  assert.equal(groups(s).length, 3, "each run of edits is its own block");
  assert.ok(groups(s).every((g) => g.items.length === 1));
  assert.equal(all(s).filter((b) => b.kind === "work").length, 1, "the read kept its own row");
});

test("writing and editing together say so, and a repeated file is counted as edits", () => {
  const s = run([w("a", "a.ts", "Write"), done("a"), w("b", "b.ts", "Update", "edit"), done("b"), w("c", "b.ts", "Update", "edit"), done("c"), { type: "endTurn" }]);
  const g = groups(s)[0]!;
  assert.equal(editsHead(g.items, g.live), "Wrote 1, edited 2 files");
  const same = run([w("a", "a.ts", "Update", "edit"), done("a"), w("b", "a.ts", "Update", "edit"), done("b"), w("c", "a.ts", "Update", "edit"), done("c"), { type: "endTurn" }]);
  assert.equal(editsHead(groups(same)[0]!.items, false), "Edited 1 files · 3 edits");
});

test("a failed edit counts in the header and is not hidden", () => {
  const s = run([w("a", "a.ts"), done("a"), w("b", "b.ts"), done("b", "", false), w("c", "c.ts"), done("c"), { type: "endTurn" }]);
  const lay = headerLayout(groups(s)[0]!.items, 90, false);
  assert.equal(lay.failed, 1);
  assert.match(lay.stat, /1 failed/);
});

test("lines added and removed come from the change itself", () => {
  const s = run([w("a", "a.ts", "Update", "edit"), done("a", "−2 +5\n- 1 │ x\n+ 1 │ y")]);
  assert.deepEqual(editStats(groups(s)[0]!.items[0]!), { add: 5, del: 2 });
  assert.deepEqual(editStats({ toolId: "z", name: "Write", status: "ok", detail: "whole file · 12 lines" }), { add: 12, del: 0 });
});

test("the names fit the width, the rest are counted, and a click lands on the name under it", () => {
  const files = ["tsconfig.main.json", "tsconfig.json", "vite.config.ts", "types.ts", "url.ts", "main.ts", "preload.ts"];
  const s = run([...files.flatMap((f, i) => [w(`t${i}`, `src/${f}`), done(`t${i}`)]), { type: "endTurn" }]);
  const g = groups(s)[0]!;
  const lay = headerLayout(g.items, 90, false);
  assert.ok(lay.names.length >= 3 && lay.names.length < files.length);
  assert.equal(lay.more, files.length - lay.names.length);
  assert.equal(lay.cut, "…");
  const second = lay.names[1]!;
  assert.equal(nameAt(g.items, 90, second.start, false), second.index);
  assert.equal(nameAt(g.items, 90, second.end - 1, false), second.index);
  assert.equal(nameAt(g.items, 90, 1, false), -1, "the dot is the row itself");
});

test("a click on a name opens just that file's change, the list stays shut, and a second click folds it", () => {
  const s = run([w("a", "a.ts"), done("a"), w("b", "b.ts"), done("b"), w("c", "c.ts"), done("c"), { type: "endTurn" }]);
  const id = groups(s)[0]!.id;
  const opened = reduce(s, { type: "toggleItem", id, index: 1 });
  const g = groups(opened)[0]!;
  assert.ok(!g.open, "the list did not open");
  assert.deepEqual(g.items.map((it) => !!it.open), [false, true, false]);
  const folded = reduce(opened, { type: "toggleItem", id, index: 1 });
  assert.equal(groups(folded)[0]!.items[1]!.open, false);
  assert.equal(groups(reduce(folded, { type: "toggleExpand", id }))[0]!.open, true, "a click elsewhere on the row opens the list");
});

test("a quiet failure leaves the row without the edit", () => {
  const s = run([w("a", "a.ts"), done("a"), w("b", "b.ts"), { type: "toolEnd", toolId: "b", ok: false, summary: "no", quiet: true }, w("c", "c.ts"), done("c"), { type: "endTurn" }]);
  assert.equal(groups(s)[0]!.items.length, 2);
});

test("painted closed it is one line with the names; opened it lists each file and shows a change", async () => {
  const s = run([w("a", "src/main.ts"), done("a"), w("b", "src/url.ts", "Update", "edit"), done("b", "−1 +2\n- 3 │ old\n+ 3 │ new\n+ 4 │ more"), w("c", "src/types.ts"), done("c"), { type: "endTurn" }]);
  const g = groups(s)[0]!;
  const paint = async (open: boolean, items = g.items): Promise<string> => {
    const out = new FakeStdout();
    const app = render(<EditGroup id={g.id} items={items} open={open} live={false} columns={90} />, { stdout: out as unknown as NodeJS.WriteStream, stdin: fakeStdin(), debug: true, exitOnCtrlC: false, patchConsole: false });
    const until = Date.now() + 5000;
    while (out.frames.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    const text = out.frames[out.frames.length - 1]!.replace(ANSI, "");
    app.unmount();
    return text;
  };
  const closed = await paint(false);
  assert.match(closed, /Wrote 1, edited 1 files|Wrote 2, edited 1 files/);
  assert.match(closed, /main\.ts, url\.ts, types\.ts/);
  assert.equal(closed.trim().split("\n").length, 1, "one line");
  const opened = await paint(true, g.items.map((it, i) => (i === 1 ? { ...it, open: true } : it)));
  assert.match(opened, /Wrote\s+src\/main\.ts/);
  assert.match(opened, /Edited\s+src\/url\.ts/);
  assert.match(opened, /new/);
  assert.doesNotMatch(opened, /main\.ts, url\.ts/, "the names give way to the list");
});

test("closed, a name's change shows under the row without the list, and the names grow to fill the line", async () => {
  const s = run([w("a", "src/main.ts"), done("a"), w("b", "src/url.ts"), done("b", "−1 +2\n- 3 │ old\n+ 3 │ new"), { type: "endTurn" }]);
  const g = groups(s)[0]!;
  const out = new FakeStdout();
  const items = g.items.map((it, i) => (i === 1 ? { ...it, open: true } : it));
  const app = render(<EditGroup id={g.id} items={items} open={false} live={false} columns={90} />, { stdout: out as unknown as NodeJS.WriteStream, stdin: fakeStdin(), debug: true, exitOnCtrlC: false, patchConsole: false });
  const until = Date.now() + 5000;
  while (out.frames.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  const text = out.frames[out.frames.length - 1]!.replace(ANSI, "");
  app.unmount();
  assert.match(text, /main\.ts, url\.ts/, "the closed row still names the files");
  assert.match(text, /Wrote\s+src\/url\.ts/, "the opened file has its line");
  assert.match(text, /new/, "and its change");
  assert.doesNotMatch(text, /src\/main\.ts/, "the other file is not listed");
  const many = Array.from({ length: 12 }, (_, i) => ({ toolId: `m${i}`, name: "Write", arg: `f${i}.ts`, status: "ok" as const, kind: "write" as const }));
  assert.ok(headerLayout(many, 90, false).names.length > 5, "more than five names when there is room");
});
