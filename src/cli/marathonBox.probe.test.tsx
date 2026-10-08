/**
 * marathonBox.probe.test.tsx — the Marathon panel as it is actually drawn.
 *
 * What matters here is not visible from types: the box must be exactly as many rows as
 * marathonBoxHeight says (the footer is budgeted from it), no line may wrap, a long task
 * list must not grow it, and the colours have to carry the state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { TodoItem } from "../tools/types.js";
import { marathonBoxHeight, type MarathonUi } from "./marathonUi.js";

// Before Ink loads: chalk fixes its colour support at import time.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { MarathonBox } = await import("./components/MarathonBox.js");

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 40;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");

function draw(ui: MarathonUi, cap = 6, width = 60) {
  const stdout = new FakeStdout();
  const instance = render(<MarathonBox ui={ui} width={width} cap={cap} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    interactive: false,
    debug: true,
  });
  const raw = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  const plain = raw.replace(ANSI, "");
  const lines = plain.replace(/\n$/, "").split("\n");
  return { raw, plain, lines, rows: lines.length };
}

const item = (n: number, status: TodoItem["status"], text = `Task ${n}`): TodoItem => ({ content: text, activeForm: `Doing ${n}`, status });
const list = (n: number, active: number): TodoItem[] =>
  Array.from({ length: n }, (_, i) => item(i, i < active ? "completed" : i === active ? "in_progress" : "pending"));
const ui = (todos: TodoItem[], over: Partial<MarathonUi> = {}): MarathonUi => ({ phase: "running", goal: "fix the button", line: "Working, turn 2", turn: 2, todos, ...over });

test("the drawn box is exactly as tall as the height it was budgeted", () => {
  for (const state of [ui([]), ui(list(2, 0)), ui(list(5, 2)), ui(list(60, 30)), ui([], { phase: "armed", line: "" })]) {
    const { rows } = draw(state);
    assert.equal(rows, marathonBoxHeight(state, 6), `${state.phase} with ${state.todos.length} items`);
  }
});

test("a small task is a small box and a huge one stops at the cap", () => {
  const small = draw(ui(list(2, 0))).rows;
  const big = draw(ui(list(6, 0))).rows;
  const huge = draw(ui(list(500, 250))).rows;
  assert.ok(small < big);
  assert.equal(huge, big, "500 tasks draw no taller than 6");
});

test("no line wraps, however long the task text or the goal", () => {
  const long = "x".repeat(400);
  const { rows } = draw(ui([item(0, "in_progress", long), item(1, "pending", long)], { line: long }), 6, 50);
  assert.equal(rows, marathonBoxHeight(ui([item(0, "in_progress", long), item(1, "pending", long)]), 6));
});

test("the state is readable: done ticked, the active task shown in its active form, the rest waiting", () => {
  const { plain } = draw(ui(list(4, 2)));
  assert.match(plain, /✔ Task 0/);
  assert.match(plain, /✔ Task 1/);
  assert.match(plain, /Doing 2/);
  assert.match(plain, /○ Task 3/);
});

test("plain by default: only the finished tick is coloured, and nothing is orange", () => {
  const { raw, plain } = draw(ui(list(3, 1)));
  // The app palette's success colour (theme.ts GOOD, #A3CF6E), not the terminal's own green.
  const GOOD_SGR = ESC + "[38;2;163;207;110m";
  const tick = raw.indexOf("✔");
  assert.ok(tick > 0 && raw.slice(Math.max(0, tick - 24), tick).includes(GOOD_SGR), "the tick is not the success colour");
  assert.ok(!raw.includes("[38;2;255;159;67m"), "no orange anywhere");
  assert.match(plain, /● Doing 1/, "the working task is a dot and its active wording");
});

test("the border is the same neutral colour whatever the run is doing", () => {
  const colour = (phase: MarathonUi["phase"]) => draw(ui(list(2, 0), { phase })).raw.match(/\x1b\[[0-9;]*m(?=┌)/)?.[0];
  const running = colour("running");
  for (const p of ["paused", "done", "blocked", "stuck", "budgetExceeded", "verifying"] as const) assert.equal(colour(p), running, p);
});

test("hidden tasks are counted, not silently dropped", () => {
  const { plain } = draw(ui(list(30, 15)));
  assert.match(plain, /↑ \d+ earlier/);
  assert.match(plain, /↓ \d+ more/);
});

test("the armed box says what to do and how to leave", () => {
  const { plain } = draw({ phase: "armed", goal: "", line: "", turn: 0, todos: [] });
  assert.match(plain, /Type your goal and press Enter/);
  assert.match(plain, /Esc cancels/);
});

test("with no list yet, the goal stands in so the box is never empty", () => {
  const { plain } = draw(ui([], { goal: "migrate the database" }));
  assert.match(plain, /migrate the database/);
});

test("the outcome is shown in the header once it ends", () => {
  const { plain } = draw(ui(list(3, 3), { phase: "done", line: "Goal verified done" }));
  assert.match(plain, /Goal verified done/);
});
