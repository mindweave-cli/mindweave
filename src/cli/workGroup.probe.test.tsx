/**
 * workGroup.probe.test.tsx — the agent's shell work is one folded row.
 *
 * The count and the marks in the header, the way commands join and split, and what a click
 * opens are checked against the real reducer and a real paint, since each of them can be wrong
 * without anything erroring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { initialState, lastExpandable, reduce, type Action, type Block, type TranscriptState } from "./transcript.js";
import { itemHit, hitBlock, hitItem } from "./expandHits.js";
import { WorkGroup, commandHeader, openedLines, verdictLine } from "./components/WorkGroup.js";
import { rangeText, readRows } from "./workLines.js";

type Commands = Extract<Block, { kind: "work" }>;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
class FakeStdout extends EventEmitter {
  columns = 70;
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

const run = (actions: Action[], from: TranscriptState = initialState()): TranscriptState => actions.reduce(reduce, from);
const start = (id: string, arg: string, name = "Run"): Action => ({ type: "toolStart", toolId: id, name, arg, action: "run", group: true });
const end = (id: string, ok = true, detail = `$ x\n${ok ? "✓ 0" : "✗ 2"} · 1s`): Action => ({ type: "toolEnd", toolId: id, ok, summary: "s", detail, detailKind: "shell" });
const all = (s: TranscriptState): Block[] => [...s.committed, ...s.tail];
const groups = (s: TranscriptState): Commands[] => all(s).filter((b): b is Commands => b.kind === "work");

test("one command is a commands row of one, and says so", () => {
  const s = run([start("a", "npm test"), end("a"), { type: "endTurn" }]);
  const [g] = groups(s);
  assert.ok(g);
  assert.equal(commandHeader(g.items, g.live).text, "Ran 1 command");
});

test("commands run together join one row, and the count follows", () => {
  let s = run([start("a", "ls"), start("b", "pwd")]);
  assert.equal(groups(s).length, 1);
  assert.equal(commandHeader(groups(s)[0]!.items, true).text, "Running 2 commands");
  s = run([end("a"), start("c", "git status"), end("b"), end("c"), { type: "endTurn" }], s);
  const g = groups(s)[0]!;
  assert.equal(groups(s).length, 1);
  assert.equal(commandHeader(g.items, g.live).text, "Ran 3 commands");
});

test("a command that fails shows in the header's marks without anything being opened", () => {
  const s = run([start("a", "ls"), end("a"), start("b", "npm run typecheck"), end("b", false), { type: "endTurn" }]);
  const g = groups(s)[0]!;
  assert.deepEqual(commandHeader(g.items, g.live).marks, ["ok", "error"]);
});

const read = (id: string, arg: string, summary?: string, covers?: number): Action[] => [
  { type: "toolStart", toolId: id, name: "Read", arg, action: "read", group: true, ...(covers ? { covers } : {}) },
  { type: "toolEnd", toolId: id, ok: true, ...(summary ? { summary } : {}) },
];

test("the agent speaking or editing ends the row, and the next command starts a new one", () => {
  let s = run([start("c", "ls"), end("c"), { type: "token", delta: "Done." }, { type: "sealNarration" }, start("d", "ls"), end("d")]);
  assert.equal(groups(s).length, 2);
  s = run([start("a", "ls"), end("a"), { type: "toolStart", toolId: "w", name: "Update", arg: "a.ts", action: "edit" }, { type: "toolEnd", toolId: "w", ok: true }, ...read("r", "x.ts")]);
  assert.equal(groups(s).length, 2);
});

test("commands and reads share one row, in either order, and the header counts both", () => {
  let s = run([start("a", "npm test"), end("a"), start("b", "git status"), end("b"), start("c", "ls"), end("c"), ...read("r1", "App.tsx"), ...read("r2", "ipc.ts, menu.ts", "read 2 files", 2), { type: "endTurn" }]);
  assert.equal(groups(s).length, 1);
  assert.equal(commandHeader(groups(s)[0]!.items, false).text, "Ran 3 commands, read 3 files");
  s = run([...read("r1", "App.tsx"), start("a", "npm test"), end("a"), { type: "endTurn" }]);
  assert.equal(groups(s).length, 1);
  assert.equal(commandHeader(groups(s)[0]!.items, false).text, "Read 1 file, ran 1 command");
});

test("one read is a row of one, and a file read twice is still one file", () => {
  const s = run([...read("r", "App.tsx"), ...read("r2", "App.tsx", "read App.tsx lines 10-40"), { type: "endTurn" }]);
  assert.equal(commandHeader(groups(s)[0]!.items, false).text, "Read 1 file");
});

test("the tense follows what is working: reading while a read runs, ran for commands already done", () => {
  const s = run([start("a", "ls"), end("a"), { type: "toolStart", toolId: "r", name: "Read", arg: "a.ts", action: "read", group: true }]);
  assert.equal(commandHeader(groups(s)[0]!.items, true).text, "Ran 1 command, reading 1 file");
});

test("a read's line says which part of the file it took", () => {
  assert.equal(rangeText(oneRead("read src/App.tsx lines 410-551")), "lines 410–551");
  assert.equal(rangeText(oneRead("read src/App.tsx lines 1-2000 of 5400")), "lines 1–2000 of 5400");
  assert.equal(rangeText(oneRead("read src/App.tsx (120 lines)")), "whole file · 120 lines");
  assert.equal(rangeText(oneRead("read src/a.ts (empty)")), "empty file");
  assert.equal(rangeText(oneRead("read buildMenu (src/main/menu.ts:41-90)")), "lines 41–90 of menu.ts");
  assert.equal(rangeText(oneRead("read src/a.ts (unchanged)")), "read before, unchanged");
  assert.equal(rangeText(oneRead("read 3 files", 3)), "whole file");
  assert.deepEqual(readRows(oneRead("read 2 files", 2, "ipc.ts, menu.ts")).map((r) => r.label), ["ipc.ts", "menu.ts"]);
});

function oneRead(summary: string, covers?: number, arg = "App.tsx"): Commands["items"][number] {
  return { toolId: "r", name: "Read", arg, kind: "read", status: "ok", note: summary, summary, ...(covers ? { covers } : {}) };
}

test("a row whose command is still running stays in the live part, then commits when it finishes", () => {
  let s = run([start("a", "sleep 9"), { type: "token", delta: "waiting" }, { type: "sealNarration" }]);
  assert.equal(s.tail.some((b) => b.kind === "work"), true);
  s = run([end("a")], s);
  assert.equal(s.tail.some((b) => b.kind === "work"), false);
  assert.equal(groups(s).length, 1);
});

test("a quiet failure leaves no trace, and an emptied row goes", () => {
  let s = run([start("a", "ls"), { type: "toolEnd", toolId: "a", ok: false, quiet: true }]);
  assert.equal(groups(s).length, 0);
  s = run([start("a", "ls"), start("b", "pwd"), { type: "toolEnd", toolId: "a", ok: false, quiet: true }, end("b")]);
  assert.equal(groups(s)[0]!.items.length, 1);
});

test("a click opens the list, and a click on one command opens only that command", () => {
  let s = run([start("a", "ls"), end("a"), start("b", "pwd"), end("b"), { type: "endTurn" }]);
  const id = groups(s)[0]!.id;
  assert.equal(lastExpandable(s), id, "Ctrl+O finds it");
  s = run([{ type: "toggleExpand", id }, { type: "toggleItem", id, index: 1 }], s);
  const g = groups(s)[0]!;
  assert.equal(g.open, true);
  assert.deepEqual(g.items.map((i) => !!i.open), [false, true]);
  s = run([{ type: "toggleExpand", id }], s);
  assert.equal(groups(s)[0]!.open, false);
});

test("a command's output and the uncut text are kept on it", () => {
  const detail = "$ big\nl1\n… (3 more lines)\n✓ 0 · 1s";
  const full = "$ big\nl1\nl2\nl3\nl4\n✓ 0 · 1s";
  const s = run([start("a", "big"), { type: "toolEnd", toolId: "a", ok: true, summary: "ok", detail, detailFull: full, detailKind: "shell" }]);
  const it = groups(s)[0]!.items[0]!;
  assert.equal(it.full, full);
  assert.equal(verdictLine(it), "✓ 0 · 1s");
  assert.deepEqual(openedLines(it), ["$ big", "l1", "l2", "l3", "l4"]);
});

test("an old cut with nothing behind it says so, and a command that printed nothing says that", () => {
  const cut = run([start("a", "big"), { type: "toolEnd", toolId: "a", ok: true, detail: "$ big\nl1\n… (3 more lines)\n✓ 0", detailKind: "shell" }]);
  assert.ok(openedLines(groups(cut)[0]!.items[0]!).some((l) => l.includes("3 more lines, not saved in this chat")));
  const quiet = run([start("a", "true"), { type: "toolEnd", toolId: "a", ok: true, detail: "$ true\n✓ 0 · 1ms", detailKind: "shell" }]);
  assert.ok(openedLines(groups(quiet)[0]!.items[0]!).includes("(no output)"));
});

test("a click is traced to the command it landed on, not only to the row", () => {
  assert.equal(hitItem(12), -1);
  assert.equal(hitBlock(12), 12);
  const hit = itemHit(12, 3);
  assert.ok(hit < 0);
  assert.equal(hitBlock(hit), 12);
  assert.equal(hitItem(hit), 3);
  assert.notEqual(itemHit(12, 3), itemHit(13, 3));
});

async function paint(items: Commands["items"], opts: { open?: boolean; live?: boolean; hoveredItem?: number } = {}): Promise<string> {
  const out = new FakeStdout();
  const app = render(<WorkGroup id={5} items={items} open={opts.open} live={opts.live} columns={70} hoveredItem={opts.hoveredItem} />, {
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const until = Date.now() + 5000;
  while (out.frames.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  const text = out.frames[out.frames.length - 1]!.replace(ANSI, "");
  app.unmount();
  return text;
}

const sample = (): Commands["items"] => {
  const s = run([
    start("a", "npm run typecheck"),
    end("a", false, "$ npm run typecheck\nsrc/a.ts(1,1): error TS1\n✗ 2 · 1.3s"),
    start("b", "git status --short"),
    end("b", true, "$ git status --short\n✓ 0 · 0.2s"),
    { type: "endTurn" },
  ]);
  return groups(s)[0]!.items;
};

test("folded, it is one line: the count, a mark for each command, and the hint to open", async () => {
  const text = await paint(sample());
  const lines = text.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 1, text);
  assert.ok(lines[0]!.includes("Ran 2 commands"), lines[0]);
  assert.ok(lines[0]!.includes("✓") && lines[0]!.includes("✗") && lines[0]!.includes("▸"), lines[0]);
  assert.ok(!text.includes("npm run typecheck"), "no command text until it is opened");
});

test("opened, each command has a line and its verdict, with the output still folded", async () => {
  const text = await paint(sample(), { open: true });
  assert.ok(text.includes("npm run typecheck") && text.includes("git status --short"), text);
  assert.ok(text.includes("✗ 2 · 1.3s") && text.includes("✓ 0 · 0.2s"), text);
  assert.ok(text.includes("▾"), text);
  assert.ok(!text.includes("error TS1"), "the output is a second click away");
});

test("a command opened shows what it printed, and nothing is cut at the edge", async () => {
  const items = sample().map((it, i) => (i === 0 ? { ...it, open: true, detail: `$ npm run typecheck\n${"x".repeat(100)}END\n✗ 2 · 1.3s` } : it));
  const text = await paint(items, { open: true });
  assert.ok(text.includes("END"), text);
});

test("a command still running: the header is in the present tense and the list names it", async () => {
  const running: Commands["items"] = [{ toolId: "z", name: "Run", arg: "sleep 99", status: "running", startedAt: Date.now() - 5000 }];
  const folded = await paint(running, { live: true });
  assert.ok(folded.includes("Running 1 command"), folded);
  const opened = await paint(running, { live: true, open: true });
  assert.ok(opened.includes("sleep 99"), opened);
});

test("a command's own words beside it (a status, 'Backgrounded as shell #1') are shown whole", async () => {
  const items: Commands["items"] = [
    { toolId: "p", name: "Shell", status: "ok", summary: "0 running, 3 total, nothing new since the last check" },
    { toolId: "q", name: "Run", arg: "npx electron out/main/index.js", status: "ok", summary: "Running as shell #1 in the background" },
  ];
  const text = await paint(items, { open: true });
  const flat = text.replace(/\s+/g, " ");
  assert.ok(flat.includes("nothing new") && flat.includes("since the last check"), text);
  assert.ok(flat.includes("Running as shell #1") && flat.includes("background"), text);
  assert.ok(!text.includes("…"), text);
});

test("opened, a read is a line with its file and the part taken, and commands keep their verdicts", async () => {
  const items: Commands["items"] = [
    { toolId: "c1", name: "Run", arg: "npm run typecheck", kind: "run", status: "ok", detail: "$ npm run typecheck\n✓ 0 · 1.3s", detailKind: "shell" },
    { toolId: "r1", name: "Read", arg: "App.tsx", kind: "read", status: "ok", note: "read src/cli/App.tsx lines 410-551" },
    { toolId: "r2", name: "Read", arg: "ipc.ts, menu.ts", kind: "read", status: "ok", covers: 2, note: "read 2 files" },
    { toolId: "r3", name: "Read", arg: "book-factory.ts", kind: "read", status: "ok", note: "read src/book-factory.ts (120 lines)" },
  ];
  const text = await paint(items, { open: true });
  assert.ok(text.includes("Ran 1 command, read 4 files"), text);
  assert.ok(text.includes("App.tsx") && text.includes("lines 410–551"), text);
  assert.ok(text.includes("ipc.ts") && text.includes("menu.ts"), text);
  assert.ok(text.includes("book-factory.ts") && text.includes("whole file · 120 lines"), text);
  assert.ok(text.includes("✓ 0 · 1.3s"), text);
  const folded = await paint(items);
  assert.equal(folded.split("\n").filter((l) => l.trim()).length, 1, folded);
});

test("words that are dropped before they are shown do not split the row", () => {
  // The agent says something that leads only to unseen tools (a search): it is discarded, and the
  // commands on either side of it are still one run of work.
  const s = run([start("a", "ls"), end("a"), { type: "token", delta: "Let me check." }, { type: "resetReply" }, start("b", "pwd"), end("b"), { type: "endTurn" }]);
  assert.equal(groups(s).length, 1);
  assert.equal(commandHeader(groups(s)[0]!.items, false).text, "Ran 2 commands");
  assert.equal(all(s).filter((b) => b.kind === "assistant" && b.text).length, 0);
});

test("words that are shown still split it, and what follows starts a new row", () => {
  const s = run([start("a", "ls"), end("a"), { type: "token", delta: "Found it." }, start("b", "pwd"), end("b"), { type: "endTurn" }]);
  assert.equal(groups(s).length, 2);
  const order = all(s).map((b) => b.kind);
  assert.deepEqual(order, ["work", "assistant", "work"]);
});

test("the header counts what is still working, not what already finished", () => {
  // Two of three commands done: it must not say it is running three.
  let s = run([start("a", "ls"), start("b", "pwd"), start("c", "git status"), end("a"), end("b")]);
  assert.equal(commandHeader(groups(s)[0]!.items, true).text, "Running 1 of 3 commands");
  // All still going: just the count. All done: past tense, the whole count.
  s = run([start("a", "ls"), start("b", "pwd")]);
  assert.equal(commandHeader(groups(s)[0]!.items, true).text, "Running 2 commands");
  s = run([end("a"), end("b"), { type: "endTurn" }], s);
  assert.equal(commandHeader(groups(s)[0]!.items, false).text, "Ran 2 commands");
});

test("each part of a mixed row follows its own work", () => {
  // Two commands done, one running; four reads, one of them still going.
  const s = run([
    start("a", "ls"), end("a"), start("b", "pwd"), end("b"), start("c", "npm test"),
    ...read("r1", "a.ts"), ...read("r2", "b.ts"), ...read("r3", "c.ts"),
    { type: "toolStart", toolId: "r4", name: "Read", arg: "d.ts", action: "read", group: true },
  ]);
  const items = groups(s)[0]!.items;
  assert.equal(commandHeader(items, true).text, "Running 1 of 3 commands, reading 1 of 4 files");
  // Only the reads still going: the commands are done and say so.
  const s2 = run([start("a", "ls"), end("a"), { type: "toolStart", toolId: "r", name: "Read", arg: "x.ts", action: "read", group: true }]);
  assert.equal(commandHeader(groups(s2)[0]!.items, true).text, "Ran 1 command, reading 1 file");
});

test("a long command keeps a gap before its verdict, and a note that does not fit goes under it whole", async () => {
  const long = '$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --disable-features=Calculator"; npm run dev';
  const items: Commands["items"] = [
    { toolId: "a", name: "Run", arg: "Get-Process gamo-app -ErrorAction SilentlyContinue", kind: "run", status: "ok", detail: "$ x\n✓ 0 · 2.5s", detailKind: "shell" },
    { toolId: "b", name: "Run", arg: long, kind: "run", status: "ok", summary: "Running as shell #1" },
  ];
  const text = await paint(items, { open: true });
  const rows = text.split("\n");
  // The note is on one row, whole, and not glued to the end of the command.
  const note = rows.findIndex((r) => r.includes("Running as shell #1"));
  assert.ok(note >= 0, text);
  assert.ok(!rows[note]!.includes("$env"), `the note must not share the command's row:\n${text}`);
  const cmd = rows.find((r) => r.includes("$env:WEBVIEW2"))!;
  assert.match(cmd, /…\s{2,}/, `no gap after the cut command:\n${text}`);
  // The verdict of the first command still sits on its own row, with its time.
  assert.ok(rows.some((r) => r.includes("Get-Process") && r.includes("✓ 0 · 2.5s")), text);
});

test("a short note stays beside its command", async () => {
  const items: Commands["items"] = [{ toolId: "a", name: "Run", arg: "npm run dev", kind: "run", status: "ok", summary: "Running as shell #1" }];
  const text = await paint(items, { open: true });
  assert.ok(text.split("\n").some((r) => r.includes("npm run dev") && r.includes("Running as shell #1")), text);
});

test("stopping a background command leaves no line behind, so the work around it stays one row", async () => {
  const { shellNote } = await import("./shellNotes.js");
  const killed = { id: 2, command: "npm run dev", status: "killed", stoppedBy: "agent" } as never;
  // What the screen would have received between the two halves of the work.
  const between: Action[] = [];
  const line = shellNote(killed, "ended", (c) => c);
  if (line) between.push({ type: "note", text: line.text });
  const s = run([start("a", "ls"), end("a"), ...read("r1", "a.ts"), ...between, start("b", "kill"), end("b"), ...read("r2", "b.ts"), { type: "endTurn" }]);
  assert.equal(between.length, 0, "no note for a stopped command");
  assert.equal(groups(s).length, 1);
  assert.equal(commandHeader(groups(s)[0]!.items, false).text, "Ran 2 commands, read 2 files");
});

test("a note the person needs still ends the row, so it is not buried inside it", () => {
  const s = run([start("a", "ls"), end("a"), { type: "note", text: "shell #2 (npm run dev) finished with exit 1" }, start("b", "pwd"), end("b"), { type: "endTurn" }]);
  assert.equal(groups(s).length, 2);
});

// ── test steps: the agent driving the app under test ───────────────────────────────────────────

const step = (id: string, name: string, arg?: string, covers?: number): Action => ({ type: "toolStart", toolId: id, name, ...(arg ? { arg } : {}), action: "screenshot", group: true, ...(covers ? { covers } : {}) });
const stepEnd = (id: string, ok = true, summary = "Clicked [10] button.", detail = `${summary}\npage: 16 elements — 12 buttons`): Action => ({
  type: "toolEnd",
  toolId: id,
  ok,
  summary,
  detail,
  detailFull: `${detail}\n${Array.from({ length: 12 }, (_, i) => `[${i + 1}] button "b${i}"`).join("\n")}`,
  detailKind: "shell",
});

test("the steps of a test are one row, and the header counts steps", () => {
  const s = run([step("a", "Look", "port 9222"), stepEnd("a"), step("b", "Click", '"Add Game"'), stepEnd("b"), step("c", "Type", '"Test"'), stepEnd("c"), { type: "endTurn" }]);
  assert.equal(groups(s).length, 1);
  const g = groups(s)[0]!;
  assert.equal(commandHeader(g.items, g.live).text, "Tested 3 steps");
  assert.deepEqual(commandHeader(g.items, g.live).marks, ["ok", "ok", "ok"]);
});

test("a batch of steps counts as that many, and a failed step is red in the marks", () => {
  const s = run([step("a", "Steps", "4 steps", 4), stepEnd("a"), step("b", "Click", '"Save"'), stepEnd("b", false, "Could not click [16]: it is gone."), { type: "endTurn" }]);
  const g = groups(s)[0]!;
  assert.equal(commandHeader(g.items, g.live).text, "Tested 5 steps");
  assert.deepEqual(commandHeader(g.items, g.live).marks, ["ok", "error"]);
});

test("steps share the row with commands, in the order they began, and say what is working", () => {
  const s = run([start("a", "npm run dev"), end("a"), step("b", "Look", "port 9222"), stepEnd("b"), step("c", "Click", '"Go"')]);
  assert.equal(groups(s).length, 1);
  assert.equal(commandHeader(groups(s)[0]!.items, true).text, "Ran 1 command, testing 1 of 2 steps");
});

test("the agent speaking ends the test row; testing again starts a new one", () => {
  const s = run([step("a", "Look"), stepEnd("a"), { type: "token", delta: "Game added." }, { type: "sealNarration" }, step("b", "Click", '"Go"'), stepEnd("b")]);
  assert.equal(groups(s).length, 2);
});

test("folded, a test is one line; opened, one line per step with a mark, and the reason a step failed in red", async () => {
  const s = run([step("a", "Look", "port 9222"), stepEnd("a"), step("b", "Click", '"Save Game"'), stepEnd("b", false, "Could not click [22]: it is gone: the page changed since the last look."), { type: "endTurn" }]);
  const items = groups(s)[0]!.items;
  const folded = (await paint(items)).split("\n").filter((l) => l.trim());
  assert.equal(folded.length, 1);
  assert.ok(folded[0]!.includes("Tested 2 steps") && folded[0]!.includes("✓") && folded[0]!.includes("✗"), folded[0]);
  const opened = await paint(items, { open: true });
  assert.ok(opened.includes('Look port 9222') && opened.includes('Click "Save Game"'), opened);
  assert.ok(opened.includes("Could not click [22]"), "why it failed is on the row");
  assert.ok(!opened.includes('[1] button "b0"'), "the page's controls are a click away");
});

test("a step opened shows what it did and the whole page; steps are never counted as reads", () => {
  const s = run([step("a", "Click", '"Go"'), stepEnd("a"), { type: "endTurn" }]);
  const it = groups(s)[0]!.items[0]!;
  assert.ok(openedLines(it).some((l) => l.startsWith("button") && l.includes('"b0"')), "the page is folded by kind");
  assert.ok(openedLines(it)[0]!.startsWith("Clicked"));
  assert.ok(!commandHeader([it], false).text.includes("Read"));
});

test("while a test works the dot pulses and the step it is on is named beside the count", async () => {
  const running: Commands["items"] = [
    { toolId: "a", name: "Look", kind: "screenshot", status: "ok", summary: "ok" },
    { toolId: "b", name: "Click", arg: '"Add Game"', kind: "screenshot", status: "running", startedAt: Date.now() - 2000 },
  ];
  const text = await paint(running, { live: true });
  assert.ok(text.includes('Testing 1 of 2 steps'), text);
  assert.ok(text.includes('Click "Add Game"'), text);
});

// ── what opens is drawn on a shaded band of exact width ───────────────────────────────────────

import { plainLine } from "./workLines.js";
import { shadeRows } from "./components/WorkGroup.js";

test("output with carriage returns and tabs is made safe, so a blank line cannot break the band", () => {
  const CR = String.fromCharCode(13);
  const TAB = String.fromCharCode(9);
  assert.equal(plainLine(`a${CR}`), "a");
  assert.equal(plainLine(CR), "");
  assert.equal(plainLine(`a${TAB}b`), "a    b");
  const it: Commands["items"][number] = { toolId: "a", name: "Run", arg: "x", kind: "run", status: "ok", open: true, detailKind: "shell", detail: `$ x${CR}\n${CR}\nCONNECT FAILED${CR}\n✓ 0 · 1ms` };
  const rows = openedLines(it);
  assert.ok(rows.every((l) => !l.includes(CR)), "no carriage return reaches the screen");
  const shade = shadeRows(rows, 40);
  assert.equal(new Set(shade.map((r) => (r.kind ?? "").length + r.text.length + r.pad)).size, 1, "every row of the band is the same width, the blank one too");
});

test("an opened test step reaches the screen with no control character in it", async () => {
  const names = ["Minimize", "Maximize", "Close"];
  const list = ['link "Library"', ...names.map((n) => `button "${n}"`)].map((l, i) => `  [${i + 1}] ${l}`).join("\n");
  const item: Commands["items"][number] = { toolId: "a", name: "Click", arg: "#1", kind: "screenshot", status: "ok", open: true, summary: "ok", detail: "x", full: `Page · 4 elements\n${list}` };
  const text = await paint([item], { open: true });
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(text), "a stray tab or separator would jump the cursor and leave the band half made");
});

test("a row of one command or one step opens straight onto what it did; two or more still open one at a time", async () => {
  const one: Commands["items"] = [{ toolId: "a", name: "Run", arg: "ls", kind: "run", status: "ok", detailKind: "shell", detail: "$ ls\nfile.txt\n✓ 0 · 1ms" }];
  const opened = await paint(one, { open: true });
  assert.ok(opened.includes("file.txt"), "its output shows without a second click");
  const two: Commands["items"] = [...one, { toolId: "b", name: "Run", arg: "pwd", kind: "run", status: "ok", detailKind: "shell", detail: "$ pwd\n/tmp\n✓ 0 · 1ms" }];
  const both = await paint(two, { open: true });
  assert.ok(!both.includes("file.txt") && !both.includes("/tmp"), "with two, each is still its own click");
});

test("a row whose only call is a batch of steps does not say the same thing twice: the header, then what the steps did", async () => {
  const batch: Commands["items"] = [{ toolId: "b", name: "Steps", arg: "11 steps", covers: 11, kind: "screenshot", status: "ok", summary: "ok", detail: "Steps 11 of 11 ran", full: "Steps 11 of 11 ran\n1. Clicked [3] button.", open: true }];
  const text = await paint(batch, { open: true });
  assert.equal((text.match(/Tested 11 steps/g) ?? []).length, 1, "the header says it once");
  assert.doesNotMatch(text, /Steps 11 steps/, "the call's own line is not repeated under it");
  assert.match(text, /Clicked \[3\] button/, "what the steps did is still there");
});

test("a single ordinary step keeps its line: it says which step it was", async () => {
  const one: Commands["items"] = [{ toolId: "c", name: "Click", arg: "#11", kind: "screenshot", status: "ok", summary: "ok", detail: "Clicked.", full: "Clicked.", open: true }];
  assert.match(await paint(one, { open: true }), /Click #11/);
});
