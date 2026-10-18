/**
 * userCommandRow.probe.test.tsx — a command the person ran with `!`, as a row.
 *
 * `You ran 1 command`, folded, and opening onto the command and its output EXACTLY as a command
 * the agent ran does. It never shares a row with the agent's own calls, so "You ran" is never a
 * claim about something the agent did. Checked with the real reducer and a real paint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { initialState, reduce, type Action, type Block, type TranscriptState } from "./transcript.js";
import { WorkGroup, commandHeader, openedLines } from "./components/WorkGroup.js";

type Work = Extract<Block, { kind: "work" }>;

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");
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
function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(s, { isTTY: false, setRawMode() {}, ref() {}, unref() {} });
  return s;
}

const run = (actions: Action[], from: TranscriptState = initialState()): TranscriptState => actions.reduce(reduce, from);
const mine = (id: string, arg: string): Action => ({ type: "toolStart", toolId: id, name: "Run", arg, action: "run", group: true, byUser: true });
const agents = (id: string, arg: string): Action => ({ type: "toolStart", toolId: id, name: "Run", arg, action: "run", group: true });
const end = (id: string, detail: string, ok = true, full?: string): Action => ({
  type: "toolEnd",
  toolId: id,
  ok,
  summary: "s",
  detail,
  detailKind: "shell",
  ...(full ? { detailFull: full } : {}),
});
const works = (s: TranscriptState): Work[] => [...s.committed, ...s.tail].filter((b): b is Work => b.kind === "work");
const header = (b: Work) => commandHeader(b.items, b.live).text;

async function paint(items: Work["items"], opts: { open?: boolean; live?: boolean } = {}): Promise<string> {
  const out = new FakeStdout();
  const app = render(<WorkGroup id={5} items={items} open={opts.open} live={opts.live} columns={80} />, {
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

const DETAIL = "$ git log --oneline -3\nabc123 first\ndef456 second\n✓ 0 · 688ms";

// ── the words ───────────────────────────────────────────────────────────────────

test("one command the person ran is a row that says You ran 1 command", () => {
  const s = run([mine("u1", "git log --oneline -3"), end("u1", DETAIL), { type: "endTurn" }]);
  const [b] = works(s);
  assert.equal(header(b!), "You ran 1 command");
  assert.equal(b!.items[0]!.byUser, true);
});

test("while it runs it says Running, not You ran", () => {
  const s = run([mine("u1", "npm test")]);
  assert.equal(header(works(s)[0]!), "Running 1 command");
});

test("commands the person ran in a row join one row: You ran 2 commands", () => {
  const s = run([mine("u1", "ls"), end("u1", "$ ls\n✓ 0 · 1s"), mine("u2", "pwd"), end("u2", "$ pwd\n✓ 0 · 1s"), { type: "endTurn" }]);
  assert.equal(works(s).length, 1);
  assert.equal(header(works(s)[0]!), "You ran 2 commands");
});

test("a command that joins an OLDER row, after its turn ended, is running again, not already ran", () => {
  // Found with the real app: the second command of a session joined the first one's row, which had
  // been settled by the first turn ending, and the row went on saying "You ran" while it worked.
  let s = run([mine("u1", "ls"), end("u1", "$ ls\n✓ 0 · 1s"), { type: "endTurn" }]);
  s = run([mine("u2", "npm run build")], s);
  assert.equal(works(s).length, 1);
  assert.equal(header(works(s)[0]!), "Running 1 of 2 commands");
  s = run([end("u2", "$ npm run build\n✓ 0 · 3s"), { type: "endTurn" }], s);
  assert.equal(header(works(s)[0]!), "You ran 2 commands");
});

// ── never mixed with the agent's own calls ──────────────────────────────────────

test("the agent's calls never join a row of the person's commands", () => {
  const s = run([mine("u1", "ls"), end("u1", "$ ls\n✓ 0 · 1s"), agents("a1", "git status"), end("a1", "$ git status\n✓ 0 · 1s"), { type: "endTurn" }]);
  const rows = works(s);
  assert.equal(rows.length, 2, "two rows");
  assert.deepEqual(rows.map(header), ["You ran 1 command", "Ran 1 command"]);
});

test("and the person's commands never join a row of the agent's", () => {
  const s = run([agents("a1", "git status"), end("a1", "$ git status\n✓ 0 · 1s"), mine("u1", "ls"), end("u1", "$ ls\n✓ 0 · 1s"), { type: "endTurn" }]);
  const rows = works(s);
  assert.deepEqual(rows.map(header), ["Ran 1 command", "You ran 1 command"]);
  assert.equal(rows[0]!.items.every((it) => !it.byUser), true);
});

test("a command the person ran, then a message, then another command: separate rows in order", () => {
  const s = run([
    mine("u1", "ls"),
    end("u1", "$ ls\n✓ 0 · 1s"),
    { type: "endTurn" },
    { type: "user", text: "now fix it" },
    mine("u2", "pwd"),
    end("u2", "$ pwd\n✓ 0 · 1s"),
    { type: "endTurn" },
  ]);
  assert.deepEqual(works(s).map(header), ["You ran 1 command", "You ran 1 command"]);
});

// ── it opens exactly as the agent's command does ────────────────────────────────

test("it opens onto the same lines an agent's command would: the $ line, the output, no verdict", () => {
  const u = run([mine("u1", "git log --oneline -3"), end("u1", DETAIL)]);
  const a = run([agents("a1", "git log --oneline -3"), end("a1", DETAIL)]);
  assert.deepEqual(openedLines(works(u)[0]!.items[0]!), openedLines(works(a)[0]!.items[0]!));
  assert.deepEqual(openedLines(works(u)[0]!.items[0]!), ["$ git log --oneline -3", "abc123 first", "def456 second"]);
});

test("the uncut text opens when there is more than the short one shows, like any command", () => {
  const full = DETAIL.replace("abc123 first", "abc123 first\nmore1\nmore2");
  const s = run([mine("u1", "git log"), end("u1", DETAIL, true, full)]);
  assert.equal(s.tail.length + s.committed.length > 0, true);
  const item = works(s)[0]!.items[0]!;
  assert.equal(item.full, full);
  assert.ok(openedLines(item).includes("more2"));
});

test("painted folded: one line, the count and the hint to open", async () => {
  const s = run([mine("u1", "git log --oneline -3"), end("u1", DETAIL), { type: "endTurn" }]);
  const text = await paint(works(s)[0]!.items, { live: false });
  assert.match(text, /You ran 1 command\s+▸/);
  assert.doesNotMatch(text, /abc123/, "folded, the output is not on screen");
});

test("painted open: the command and its output on the band, and how it ended, just as the agent's row is", async () => {
  const u = run([mine("u1", "git log --oneline -3"), end("u1", DETAIL), { type: "endTurn" }]);
  const a = run([agents("a1", "git log --oneline -3"), end("a1", DETAIL), { type: "endTurn" }]);
  const yours = await paint(works(u)[0]!.items, { open: true, live: false });
  const theirs = await paint(works(a)[0]!.items, { open: true, live: false });
  assert.match(yours, /You ran 1 command/);
  assert.match(yours, /\$ git log --oneline -3/);
  assert.match(yours, /abc123 first/);
  assert.match(yours, /def456 second/);
  assert.match(yours, /0 · 688ms/);
  // Everything but the one word is the same picture.
  assert.equal(yours.replace("You ran", "Ran"), theirs, "a command of the person's opens exactly like the agent's");
});

test("a failed command of the person's shows how it ended and opens on what it printed", async () => {
  const detail = "$ npm test\nboom\n✗ 1 · 2s";
  const s = run([mine("u1", "npm test"), end("u1", detail, false), { type: "endTurn" }]);
  assert.equal(header(works(s)[0]!), "You ran 1 command");
  const text = await paint(works(s)[0]!.items, { open: true, live: false });
  assert.match(text, / 1 · 2s/);
  assert.match(text, /boom/);
});
