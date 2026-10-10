/**
 * toolReveal.test.tsx — what a tool block actually PUTS ON SCREEN, frame by frame.
 *
 * This renders through Ink into a fake stdout and reads the text back, because
 * typecheck and reducer tests say nothing about what the user sees — the whole
 * defect this file exists to pin was a header that rendered without its body.
 *
 * The rules under test: a tool row appears while its tool works (present tense, pulsing dot)
 * and resolves in place when the result comes; a call already finished by its beat appears
 * finished; and nothing new reaches the screen while a row on it is still working.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Box } from "ink";
import { BlockView } from "./components/BlockView.js";
import { Picker } from "./components/Picker.js";
import { ApprovalBox } from "./components/ApprovalBox.js";
import { clipRows } from "./wrap.js";
import { initialState, reduce, type Action, type Block, type TranscriptState } from "./transcript.js";
import { newPacer, nextMove, takeImmediate, takePaced } from "./revealQueue.js";
import { narrationPending } from "./revealPace.js";

/** A stdout Ink will happily write frames into. */
class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ANSI = /\[[0-9;]*[A-Za-z]/g;

/** Render blocks and return the visible text of the final frame, ANSI stripped. */
function frameOf(blocks: Block[]): string {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  const app = render(
    <Box flexDirection="column">
      {blocks.map((b) => (
        <BlockView key={b.id} block={b} columns={stdout.columns} />
      ))}
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin, patchConsole: false, interactive: true, exitOnCtrlC: false, debug: true },
  );
  const text = stdout.frames.join("").replace(ANSI, "");
  app.unmount();
  return text;
}

function run(actions: Action[]): TranscriptState {
  return actions.reduce(reduce, initialState());
}

/** Everything currently on screen, in order. */
function blocks(s: TranscriptState): Block[] {
  return [...s.committed, ...s.tail];
}

/**
 * The frames a turn produces, replayed through the SAME pacer App.pump() drives (revealQueue.ts),
 * so the sequence of paints can be asserted without mounting the whole app.
 *
 * `arrive` is when the events reach the pacer: "all" has the whole turn queued before the first
 * beat (a burst that finished faster than the tempo), "stepwise" delivers one event at a time and
 * lets every beat that is due fire before the next one arrives (a tool slower than the tempo).
 * Each applied batch is one paint, as applyNow makes it one.
 */
function screensDuring(queue: Action[], arrive: "all" | "stepwise" = "all"): string[] {
  let s = initialState();
  const frames: string[] = [];
  let last = "";
  const apply = (batch: Action[]) => {
    if (batch.length === 0) return;
    for (const a of batch) s = reduce(s, a);
    const f = frameOf(blocks(s));
    if (f !== last) {
      frames.push(f);
      last = f;
    }
  };
  const incoming = [...queue];
  const p = newPacer(arrive === "all" ? incoming.splice(0) : []);
  const flags = () => ({ flushing: false, streamDone: incoming.length === 0, narrationPending: narrationPending(s) });
  for (;;) {
    apply(takeImmediate(p, flags()));
    const move = nextMove(p);
    if (move === "beat") {
      apply(takePaced(p, flags()));
      continue;
    }
    if (incoming.length === 0) break;
    p.queue.push(incoming.shift()!);
  }
  return frames;
}

test("a read that is done by its beat appears done, in one frame, and the turn ending changes nothing", () => {
  // One read: it used to show "Reading 1 file…" and then, a second later, become "Read 1 file".
  const turn: Action[] = [
    { type: "user", text: "look at runCommand" },
    { type: "toolStart", toolId: "t1", name: "Read", arg: "runCommand.ts", action: "read", group: true },
    { type: "toolEnd", toolId: "t1", ok: true, summary: "read src/tools/runCommand.ts (195 lines)" },
    { type: "finishReply" },
  ];
  const frames = screensDuring(turn);

  const withTool = frames.filter((f) => /Read/.test(f));
  assert.ok(withTool.length > 0, "the group must reach the screen");

  // Folded, the row is its header: no frame says it is still reading.
  for (const f of withTool) {
    assert.match(f, /Read 1 file/);
    assert.doesNotMatch(f, /Reading/);
  }

  // Already done by its beat, so it appears done: no present tense to pretend with.
  const first = withTool[0]!;
  assert.match(first, /Read 1 file/);
  assert.doesNotMatch(first, /Reading/);

  // The turn ending changes nothing about it.
  const ended = frameOf(blocks(reduce(run(turn), { type: "endTurn" })));
  assert.equal(ended, first, "a finished row changed when the turn ended");
});

test("a row counts each file once, and a read that failed shows a red mark", () => {
  const s = run([
    { type: "toolStart", toolId: "t1", name: "Read", arg: "a.ts", action: "read", group: true },
    { type: "toolEnd", toolId: "t1", ok: true, summary: "read src/a.ts (195 lines)" },
    { type: "toolStart", toolId: "t2", name: "Read", arg: "b.ts, c.ts, d.ts", action: "read", group: true, covers: 3 },
    { type: "toolEnd", toolId: "t2", ok: true, summary: "read 3 files" },
    { type: "toolStart", toolId: "t3", name: "Read", arg: "a.ts", action: "read", group: true },
    { type: "toolEnd", toolId: "t3", ok: true, summary: "read src/a.ts lines 10-40" },
    { type: "toolStart", toolId: "t4", name: "Read", arg: "e.ts", action: "read", group: true },
    { type: "toolEnd", toolId: "t4", ok: false, summary: "no such file" },
  ]);
  const frame = frameOf(blocks(s));
  assert.match(frame, /Read 5 files/, frame);
  assert.match(frame, /✗/, frame);
  assert.doesNotMatch(frame, /b\.ts/, "folded: the names are behind the click");
});

test("a tool finished before its beat arrives finished, with its diff already under it", () => {
  const turn: Action[] = [
    { type: "user", text: "fix the guard" },
    { type: "toolStart", toolId: "e1", name: "Update", arg: "runCommand.ts", action: "edit" },
    { type: "toolEnd", toolId: "e1", ok: true, detail: "- if (ctx.backgroundShells) {\n+ if (isInteractive(cmd)) {" },
    { type: "finishReply" },
  ];
  const frames = screensDuring(turn);

  // No frame shows the row before its diff — the bare-header state is gone here too.
  for (const f of frames.filter((x) => /Updat/.test(x))) {
    assert.match(f, /isInteractive/, `edit row rendered without its diff:\n${f}`);
  }
  // Its result was in before its beat, so it appears finished.
  const first = frames.filter((f) => /Updat/.test(f))[0]!;
  assert.match(first, /Update\(runCommand\.ts\)/);
  assert.doesNotMatch(first, /Updating/);
});

test("a batch of concurrent tools reveals one row at a time, never all at once", () => {
  // The engine emits EVERY toolStart of a batch before running any of it, so when
  // those calls run concurrently their results arrive behind the other calls' starts.
  // Revealing a contiguous span from the front put all eight rows in one paint: the
  // turn read calmly and then the whole batch appeared at once, with no way to follow
  // what had happened. Each call is its own block and earns its own frame.
  const N = 8;
  const turn: Action[] = [{ type: "user", text: "check the drivers" }];
  for (let i = 0; i < N; i++) {
    turn.push({ type: "toolStart", toolId: "p" + i, name: "Read", arg: "driver" + i + ".ts", action: "read" });
  }
  for (let i = 0; i < N; i++) {
    turn.push({ type: "toolEnd", toolId: "p" + i, ok: true, detail: "driver" + i + " body" });
  }
  turn.push({ type: "finishReply" });

  const frames = screensDuring(turn);

  // Count how many of the eight rows each frame introduced. Any frame that gains more
  // than one is the batch landing together.
  let seen = 0;
  for (const f of frames) {
    const now = turn.filter((a) => a.type === "toolStart" && f.includes(String((a as { arg?: string }).arg ?? ""))).length;
    assert.ok(now - seen <= 1, `a frame gained ${now - seen} tool rows at once:
${f}`);
    if (now > seen) seen = now;
  }
  assert.equal(seen, N, `only ${seen} of ${N} rows ever appeared`);
});

test("the rhythm is the same whatever the turn contains, and however much of it", () => {
  // The property, stated directly: what reaches the screen arrives one block at a
  // time, at one tempo, whether the turn ran two tools or five hundred and whether
  // the blocks around them are comments, notes or the reply. A reader following a
  // turn should not be able to tell from the pacing whether the model worked step by
  // step or fanned out — that is the model's business, not something the screen
  // reports. Counts are walked rather than assumed because the failure this replaces
  // only appeared past a certain width: two concurrent calls looked fine and eight
  // landed in one paint.
  for (const n of [2, 3, 5, 8, 40]) {
    const turn: Action[] = [
      { type: "user", text: "look at the drivers" },
      { type: "note", text: "opening the driver folder" },
    ];
    for (let i = 0; i < n; i++) {
      turn.push({ type: "toolStart", toolId: "u" + i, name: "Read", arg: "d" + i + ".ts", action: "read" });
    }
    for (let i = 0; i < n; i++) {
      turn.push({ type: "toolEnd", toolId: "u" + i, ok: true, detail: "body of d" + i });
    }
    turn.push({ type: "note", text: "that is all of them" });
    turn.push({ type: "finishReply" });

    const frames = screensDuring(turn);
    let seen = 0;
    for (const f of frames) {
      const now = turn.filter(
        (a) => a.type === "toolStart" && f.includes(String((a as { arg?: string }).arg ?? "")),
      ).length;
      assert.ok(now - seen <= 1, `with ${n} tools a frame gained ${now - seen} rows at once:
${f}`);
      if (now > seen) seen = now;
    }
    assert.equal(seen, n, `with ${n} tools only ${seen} rows ever appeared`);
  }
});

test("a sentence and the tool row it introduces never land in the same frame", () => {
  // Streamed text renders nothing until it seals, and `toolStart` seals it as part
  // of its own action — so without a beat of its own the sentence and the row appear
  // in ONE paint and read as a single clump. The whole point of the tempo is that a
  // block arrives, is read, and then the next one arrives.
  const turn: Action[] = [
    { type: "user", text: "fix the guard" },
    { type: "token", delta: "The guard rejects before it looks. " },
    { type: "token", delta: "Reading the call site." },
    { type: "toolStart", toolId: "e1", name: "Update", arg: "runCommand.ts", action: "edit" },
    { type: "toolEnd", toolId: "e1", ok: true, summary: "1 line changed" },
    { type: "finishReply" },
  ];
  const frames = screensDuring(turn);

  const said = /rejects before it looks/;
  const row = /Updat/;
  const together = frames.filter((f) => said.test(f) && row.test(f));
  const alone = frames.filter((f) => said.test(f) && !row.test(f));

  assert.ok(alone.length > 0, `the sentence never got a frame to itself:\n${frames.join("\n---\n")}`);
  // It stays on screen afterwards, of course — what must not exist is a frame where
  // it ARRIVES together with the row, i.e. the first frame showing it also has one.
  assert.ok(!together.includes(frames.find((f) => said.test(f))!), "the sentence arrived in the row's paint");
});

test("a slow tool is on screen while it works, then resolves in place", () => {
  // Events one at a time: the row reaches the screen on its beat before its result exists.
  const turn: Action[] = [
    { type: "user", text: "run the tests" },
    { type: "toolStart", toolId: "r1", name: "Run", arg: "npm test", action: "run" },
    { type: "toolProgress", toolId: "r1", text: "$ npm test\nrunning 12 suites" },
    { type: "toolEnd", toolId: "r1", ok: true, detail: "$ npm test\nall 12 passed\n✓ Exit code 0", detailKind: "shell" },
    { type: "finishReply" },
  ];
  const frames = screensDuring(turn, "stepwise");
  const rows = frames.filter((f) => /npm test/.test(f));
  assert.match(rows[0]!, /Running\(npm test\)/, "the row did not appear while the command ran");
  assert.ok(rows.some((f) => /Running\(npm test\)/.test(f) && /running 12 suites/.test(f)), "its output did not show while it ran");
  const done = rows[rows.length - 1]!;
  assert.match(done, /Run\(npm test\)/);
  assert.doesNotMatch(done, /Running/);
  assert.match(done, /all 12 passed/);
});

test("nothing new reaches the screen while a row on it is still working", () => {
  // The beat comes after the result: the note queued behind a working call waits for it.
  const p = newPacer([
    { type: "toolStart", toolId: "r1", name: "Run", arg: "npm test", action: "run" },
    { type: "note", text: "next" },
  ]);
  const flags = { flushing: false, streamDone: false, narrationPending: false };
  assert.equal(nextMove(p), "beat");
  assert.deepEqual(takePaced(p, flags).map((a) => a.type), ["toolStart"]);
  assert.equal(nextMove(p), "wait", "the note would appear while the command still runs");
  // Its progress and result are taken at once, even queued behind the note.
  p.queue.push({ type: "toolProgress", toolId: "r1", text: "…" }, { type: "toolEnd", toolId: "r1", ok: true });
  assert.deepEqual(takeImmediate(p, flags).map((a) => a.type), ["toolProgress", "toolEnd"]);
  assert.equal(nextMove(p), "beat", "the result came: the next block gets its beat");
});

test("reads made in separate calls join one row, which works until the last one is done", () => {
  const p = newPacer([{ type: "toolStart", toolId: "a", name: "Read", arg: "a.ts", action: "read", group: true }]);
  const flags = { flushing: false, streamDone: false, narrationPending: false };
  let s = initialState();
  for (const a of takePaced(p, flags)) s = reduce(s, a);
  p.queue.push(
    { type: "toolStart", toolId: "b", name: "Read", arg: "b.ts", action: "read", group: true },
    { type: "toolEnd", toolId: "a", ok: true },
  );
  for (const a of takeImmediate(p, flags)) s = reduce(s, a);
  assert.equal(nextMove(p), "wait", "b is still being read");
  let frame = frameOf(blocks(s));
  assert.match(frame, /Reading 1 of 2 files/);
  p.queue.push({ type: "toolEnd", toolId: "b", ok: true });
  for (const a of takeImmediate(p, flags)) s = reduce(s, a);
  frame = frameOf(blocks(s));
  assert.match(frame, /Read 2 files/);
  assert.equal(s.tail.filter((b) => b.kind === "work").length + s.committed.filter((b) => b.kind === "work").length, 1);
});

test("a row interrupted before its result stops working when the turn ends", () => {
  const s = run([{ type: "toolStart", toolId: "e1", name: "Update", arg: "a.ts", action: "edit" }]);
  assert.match(frameOf(blocks(s)), /Updating\(a\.ts\)/);
  const ended = frameOf(blocks(reduce(s, { type: "endTurn" })));
  assert.match(ended, /Update\(a\.ts\)/);
  assert.doesNotMatch(ended, /Updating/);
});

function run2(s: TranscriptState, actions: Action[]): TranscriptState {
  return actions.reduce(reduce, s);
}

// ── the overlay's height, which is what made the app look hung ────────────────

/** Render a component and return its frame text, ANSI stripped. */
function renderFrame(node: React.ReactElement): string {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  const app = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
    interactive: true,
    debug: true,
    exitOnCtrlC: false,
  });
  const text = stdout.frames.join("").replace(ANSI, "");
  app.unmount();
  return text;
}

test("a picker never grows past its row budget, however long its title", () => {
  // THE HANG. exit_plan passed a whole 40-step plan as the picker's title. The item
  // list was windowed; the title was not. The picker renders in the footer, so the
  // frame grew taller than the terminal, Ink switched to clearTerminal-and-redraw and
  // stopped tracking what it had written, and the screen tore — header stranded, no
  // input box, scrolling moving a sliver. From the outside it looked like a freeze.
  const plan = Array.from({ length: 40 }, (_, i) => `${i + 1}. do the thing number ${i + 1}`).join("\n");
  const frame = renderFrame(
    <Picker
      title={plan}
      items={[{ label: "Approve" }, { label: "Reject" }]}
      onSelect={() => {}}
      onCancel={() => {}}
      width={80}
      active={false}
    />,
  );
  const rows = frame.split("\n").filter((l) => l.trim().length > 0);
  assert.ok(rows.length < 20, `overlay must stay small, rendered ${rows.length} rows:\n${frame}`);
  // And it must SAY it was cut, rather than quietly hiding what is being agreed to.
  assert.match(frame, /more lines above/);
  // The options still have to be usable — that is the whole point of the prompt.
  assert.match(frame, /Approve/);
  assert.match(frame, /Reject/);
});

// ── the approval box ─────────────────────────────────────────────────────────

function approvalFrame(question: string, options: string[], width = 74): string {
  // ApprovalBox is content-only now; the border is the shared menu box it renders inside
  // (see PromptInput). Wrap it the same way here so the box's stop-reading border, spacing
  // and clipping are all exercised together.
  return renderFrame(
    <Box flexDirection="column" width={width} borderStyle="single" borderColor="gray" paddingX={1}>
      <ApprovalBox
        question={question}
        options={options}
        width={width}
        onSelect={() => {}}
        onCancel={() => {}}
        active={false}
      />
    </Box>,
  );
}

test("the approval box is bordered, spaced, and numbered", () => {
  const frame = approvalFrame("Start on this?", ["Approve", "Reject", "Change something"]);
  const lines = frame.split("\n").filter((l) => l.trim());

  // Bordered: it interrupts the user's work, so it must read as a stop, not as output.
  assert.match(frame, /┌.*┐/s);
  assert.match(frame, /└.*┘/s);
  // Numbered, so the decision can be made in one keystroke.
  assert.match(frame, /\[1\] Approve/);
  assert.match(frame, /\[3\] Change something/);
  assert.match(frame, /↑\/↓ or 1-3/);
  // The selected answer is marked, and only one is.
  assert.equal((frame.match(/›/g) ?? []).length, 1);
  // SPACING: a blank row between the question and the answers, and between the answers
  // and the hint — the thing being agreed to must not blur into the thing agreeing.
  const inner = lines.filter((l) => l.startsWith("│"));
  const blanks = inner.filter((l) => l.replace(/[│\s]/g, "") === "").length;
  assert.equal(blanks, 2, `expected two blank rows inside the border:\n${frame}`);
});

test("the approval box stays small when a caller passes a long question", () => {
  // Same failure mode as the picker: this draws in the footer, so unbounded height
  // tears the screen. Bounded here too rather than trusting every caller.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} of a question that should not be here`).join("\n");
  const frame = approvalFrame(long, ["Yes", "No"]);
  const rows = frame.split("\n").filter((l) => l.trim()).length;
  assert.ok(rows < 16, `overlay must stay small, rendered ${rows} rows`);
  assert.match(frame, /more lines above/);
  assert.match(frame, /\[1\] Yes/, "the answers must survive the clipping");
});

test("a notice renders as facts on a rail, verbatim, not as assistant prose", () => {
  // The permission block. It must not carry the assistant's plain ● or go through
  // markdown: these are literal commands, and `--force` or a backtick must appear
  // exactly as it will be run.
  const body = "Action: Shell execution\nCommand: $ git push origin main --force\nTool: run_command";
  const s = run([{ type: "notice", title: "Permission Request", body }]);
  const frame = frameOf(blocks(s));
  assert.match(frame, /Permission Request/);
  assert.match(frame, /│ Action: Shell execution/);
  assert.match(frame, /│ Command: \$ git push origin main --force/, "the command must survive verbatim");
});

test("a command in a notice is never markdown-mangled", () => {
  const body = "Command: $ rm -rf _build && echo `date` *.log";
  const frame = frameOf(blocks(run([{ type: "notice", title: "Permission Request", body }])));
  assert.match(frame, /rm -rf _build && echo `date` \*\.log/, "backticks, asterisks and underscores stay literal");
});

// ── sub-agent topology ───────────────────────────────────────────────────────

test("one worker keeps its full rail", () => {
  const s = run([
    { type: "subagentStart", agentId: "a", task: "find every authFetch call site", readOnly: true },
    { type: "subToolStart", agentId: "a", toolId: "1", name: "Read", arg: "login.ts", action: "read" },
    { type: "subToolEnd", agentId: "a", toolId: "1", ok: true, summary: "Read login.ts (88 lines)" },
    { type: "subagentEnd", agentId: "a", ok: true, summary: "3 steps · read-only" },
  ]);
  const frame = frameOf(blocks(s));
  assert.match(frame, /● Subagent · read-only/);
  assert.match(frame, /Read login\.ts \(88 lines\)/, "with one worker there is room for its calls");
  assert.match(frame, /3 steps · read-only/);
});

test("several workers become a tree, and each branch says how far along it is", () => {
  const s = run([
    { type: "subagentStart", agentId: "a", task: "find every authFetch call site", readOnly: true },
    { type: "subagentStart", agentId: "b", task: "draft unit tests for runCommand.ts", readOnly: false },
    { type: "subToolStart", agentId: "b", toolId: "1", name: "Read", arg: "runCommand.ts", action: "read" },
    { type: "subagentEnd", agentId: "a", ok: true, summary: "4 steps · read-only" },
  ]);
  const frame = frameOf(blocks(s));
  assert.match(frame, /● Subagents/);
  assert.match(frame, /2 delegated/);
  assert.match(frame, /├──/, "a branch for each worker…");
  assert.match(frame, /└──/, "…and an elbow on the last");
  // The finished one reports its summary; the running one is described by what it has
  // done so far, or a running branch would say nothing and read as stalled.
  assert.match(frame, /4 steps · read-only/);
  assert.match(frame, /working · 1 step/);
  // Which one may write is on the branch: it is the difference that matters most.
  assert.match(frame, /#1 · read-only/);
  assert.doesNotMatch(frame, /#2 · read-only/);
});

test("the topology shows only what a sub-agent actually reports", () => {
  // The reference design labels each worker with a model and an "isolated 8k window".
  // A sub-agent carries neither, so putting them on screen would be decoration that
  // reads as fact.
  const s = run([
    { type: "subagentStart", agentId: "a", task: "one", readOnly: true },
    { type: "subagentStart", agentId: "b", task: "two", readOnly: true },
  ]);
  const frame = frameOf(blocks(s));
  assert.doesNotMatch(frame, /window/i);
  assert.doesNotMatch(frame, /\d+k\b/i, "no invented context budget");
});

test("clipRows counts rendered rows, not newlines", () => {
  // One long line is several rows on screen. Counting newlines would call this
  // single-line title "short" and let it blow the frame anyway.
  const oneLongLine = "x".repeat(1000);
  assert.ok(clipRows(oneLongLine, 40, 6).length <= 6);
  // A short title passes through untouched, with no "more lines" noise.
  assert.deepEqual(clipRows("Start on this?", 80, 6), ["Start on this?"]);
});

test("a resumed session opens with settled verbs, not work that looks in flight", () => {
  // showResumed replays a finished session through these same actions, so every row
  // it creates is born `live`. Seen for real: a resumed chat opened showing
  // "Updating(App.tsx)" over an edit that had completed in a previous process.
  const replayed: Action[] = [
    { type: "user", text: "add the pomodoro timer" },
    { type: "toolStart", toolId: "e1", name: "Update", arg: "App.tsx", action: "edit" },
    { type: "toolEnd", toolId: "e1", ok: true, summary: "-3 +63" },
    { type: "sealNarration" },
  ];
  // Finished rows read finished, live or not.
  assert.doesNotMatch(frameOf(blocks(run(replayed))), /Updating/);
  const settled = frameOf(blocks(reduce(run(replayed), { type: "endTurn" })));
  assert.match(settled, /Update\(App\.tsx\)/);
  assert.doesNotMatch(settled, /Updating/);
});

test("progress is applied at once, never queued behind the beat", async () => {
  // It is an update to a row already on screen, the same as a result resolving in place.
  // Paced, a tail sent once a second would queue up behind a two-second beat and fall
  // further behind the command for as long as it ran.
  const { readFile } = await import("node:fs/promises");
  const { isPaced } = await import("./revealQueue.js");
  assert.equal(isPaced({ type: "toolProgress", toolId: "x", text: "…" }, false), false, "progress is being paced");
  void readFile;
});

test("the engine gives each call its OWN progress channel", async () => {
  // Hung on the shared tool context it would be one channel for every tool in the turn,
  // and with two commands in flight there would be no way to tell whose output was whose.
  const { readFile } = await import("node:fs/promises");
  const engine = await readFile(new URL("../dynamo/engine.ts", import.meta.url), "utf8");
  assert.match(
    engine,
    /tool\.execute\(parseArgs\(call\.arguments\), session\.toolContext, \{\s*\n\s*progress: \(text\) => options\.onEvent\?\.\(\{ type: "tool", phase: "progress", id: call\.id/,
    "the progress channel is not scoped to the call",
  );
});

test("a running command reports, and stops reporting when it settles", async () => {
  // Both halves matter. Without the first a long build shows nothing at all; without the
  // second the timer outlives the command and keeps firing at a row that has resolved.
  const { readFile } = await import("node:fs/promises");
  const run = await readFile(new URL("../tools/runCommand.ts", import.meta.url), "utf8");
  assert.match(run, /call\.progress\(text\)/, "nothing reports while the command runs");
  // Every path that settles the promise must also stop the timer.
  const settles = (run.match(/settled = true;/g) ?? []).length;
  const stops = (run.match(/stopProgress\(\);/g) ?? []).length;
  assert.ok(stops >= settles - 1, `${settles} settle paths but only ${stops} stop reporting`);
});
