/**
 * marathonUi.test.ts — the rules behind the CLI's Marathon box: what each event does to it,
 * which checklist rows show, and how tall it is. The property that matters most is the
 * size: it follows the content, and stops at the cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TodoItem } from "../tools/types.js";
import {
  activeIndex,
  bodyRows,
  isFinished,
  marathonBoxHeight,
  marathonUiReduce,
  windowChecklist,
  type MarathonUi,
} from "./marathonUi.js";

const item = (n: number, status: TodoItem["status"]): TodoItem => ({ content: `Task ${n}`, activeForm: `Doing ${n}`, status });
const list = (n: number, active = -1): TodoItem[] =>
  Array.from({ length: n }, (_, i) => item(i, i < active ? "completed" : i === active ? "in_progress" : "pending"));
const ui = (todos: TodoItem[], phase: MarathonUi["phase"] = "running"): MarathonUi => ({ phase, goal: "g", line: "", turn: 1, todos });

// ── the window ───────────────────────────────────────────────────────────────

test("a list that fits is shown whole, with no indicators", () => {
  const w = windowChecklist(list(4, 1), 6);
  assert.equal(w.rows.length, 4);
  assert.equal(w.above, 0);
  assert.equal(w.below, 0);
});

test("a long list is windowed to the cap, indicators included, with the active task in view", () => {
  for (const total of [7, 12, 40]) {
    for (const cap of [3, 4, 5, 7, 8]) {
      for (let active = 0; active < total; active++) {
        const w = windowChecklist(list(total, active), cap);
        const drawn = w.rows.length + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
        assert.ok(drawn <= cap, `total ${total} cap ${cap} active ${active}: drew ${drawn}`);
        assert.ok(w.rows.some((r) => r.index === active), `active ${active} must be visible (total ${total}, cap ${cap})`);
        assert.equal(w.above + w.rows.length + w.below, total, "nothing is lost or duplicated");
        assert.deepEqual(
          w.rows.map((r) => r.index),
          w.rows.map((_, i) => w.above + i),
          "rows are contiguous and in order",
        );
      }
    }
  }
});

test("the window shows some history above the active task, and what is coming below", () => {
  const w = windowChecklist(list(20, 10), 7);
  assert.ok(w.rows[0]!.index < 10, "the task before the active one stays visible");
  assert.ok(w.below > 0);
  assert.ok(w.above > 0);
});

test("at the start there is no 'above', at the end no 'below', and the rows are reclaimed", () => {
  const start = windowChecklist(list(20, 0), 6);
  assert.equal(start.above, 0);
  assert.equal(start.rows.length + (start.below > 0 ? 1 : 0), 6);
  const end = windowChecklist(list(20, 19), 6);
  assert.equal(end.below, 0);
  assert.equal(end.rows.length + (end.above > 0 ? 1 : 0), 6);
});

test("the active task is the one in progress, else the next pending, else the last", () => {
  assert.equal(activeIndex(list(5, 2)), 2);
  assert.equal(activeIndex([item(0, "completed"), item(1, "pending"), item(2, "pending")]), 1);
  assert.equal(activeIndex([item(0, "completed"), item(1, "completed")]), 1);
  assert.equal(activeIndex([]), 0);
});

// ── the size ─────────────────────────────────────────────────────────────────

test("the box follows its content: a short list is a short box", () => {
  assert.ok(marathonBoxHeight(ui(list(2, 0)), 7) < marathonBoxHeight(ui(list(5, 0)), 7));
  assert.equal(marathonBoxHeight(ui(list(2, 0)), 7), 3 + 2);
});

test("the box stops at the cap however long the task list gets", () => {
  const tall = marathonBoxHeight(ui(list(6, 0)), 6);
  for (const n of [7, 20, 200]) assert.equal(marathonBoxHeight(ui(list(n, 3)), 6), tall);
});

test("with no list yet the status line stands in for it, one row", () => {
  assert.equal(bodyRows(ui([]), 7), 1);
});

test("the armed box is two lines of instruction, whatever the cap", () => {
  const armed = marathonUiReduce(null, { type: "arm" })!;
  assert.equal(bodyRows(armed, 7), 2);
  assert.equal(bodyRows(armed, 3), 2);
});

// ── the events ───────────────────────────────────────────────────────────────

test("arming makes an empty armed box, and starting turns it into a running one", () => {
  const armed = marathonUiReduce(null, { type: "arm" })!;
  assert.equal(armed.phase, "armed");
  const started = marathonUiReduce(armed, { type: "event", event: { type: "started", goal: "fix it" } })!;
  assert.equal(started.phase, "running");
  assert.equal(started.goal, "fix it");
});

test("the task list replaces itself each time the model rewrites it", () => {
  let s = marathonUiReduce(null, { type: "event", event: { type: "started", goal: "g" } });
  s = marathonUiReduce(s, { type: "todos", items: list(3, 0) });
  s = marathonUiReduce(s, { type: "todos", items: list(3, 2) });
  assert.equal(s!.todos.filter((t) => t.status === "completed").length, 2);
});

test("verifying, waiting and the outcome each set the phase and the wording", () => {
  let s = marathonUiReduce(null, { type: "event", event: { type: "started", goal: "g" } })!;
  s = marathonUiReduce(s, { type: "event", event: { type: "verifying" } })!;
  assert.equal(s.phase, "verifying");
  assert.match(s.line, /really done/);
  s = marathonUiReduce(s, { type: "event", event: { type: "finished", status: "done", outcome: "ok" } })!;
  assert.equal(s.phase, "done");
  assert.ok(isFinished(s));
  assert.match(s.line, /verified done/);
});

test("a stopped run is paused, not finished, and keeps its list", () => {
  let s = marathonUiReduce(null, { type: "event", event: { type: "started", goal: "g" } })!;
  s = marathonUiReduce(s, { type: "todos", items: list(3, 1) })!;
  s = marathonUiReduce(s, { type: "event", event: { type: "paused" } })!;
  assert.equal(s.phase, "paused");
  assert.equal(isFinished(s), false);
  assert.equal(s.todos.length, 3);
});

test("a restored run comes back running with its last list and turn", () => {
  const s = marathonUiReduce(null, { type: "restore", goal: "migrate", turn: 4, todos: list(3, 1) })!;
  assert.equal(s.phase, "running");
  assert.equal(s.turn, 4);
  assert.equal(s.todos.length, 3);
});

test("the opening turn reads as questions being open; after it, questions are closed", () => {
  let s = marathonUiReduce(null, { type: "event", event: { type: "started", goal: "g" } })!;
  s = marathonUiReduce(s, { type: "event", event: { type: "turn", n: 1, phase: "plan" } })!;
  assert.match(s.line, /questions open/i);
  s = marathonUiReduce(s, { type: "event", event: { type: "planned" } })!;
  assert.match(s.line, /Questions closed/);
});
