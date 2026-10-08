/**
 * todoReminder.test.ts — the nudge for a task list that has gone quiet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { todoReminderDue, todoReminderText, TODO_QUIET_ROUNDS, type TodoQuiet } from "./todoReminder.js";
import type { TodoItem } from "../tools/types.js";

const open: TodoItem[] = [
  { content: "Add the parser", activeForm: "Adding the parser", status: "in_progress" },
  { content: "Run tests", activeForm: "Running tests", status: "pending" },
];
const done: TodoItem[] = [{ content: "Add the parser", activeForm: "Adding the parser", status: "completed" }];

function run(state: TodoQuiet, todos: TodoItem[], rounds: number): number {
  let fired = 0;
  for (let i = 0; i < rounds; i++) if (todoReminderDue(state, todos, false)) fired++;
  return fired;
}

test("an open list that stays quiet gets one reminder per quiet run", () => {
  const s: TodoQuiet = { rounds: 0 };
  assert.equal(run(s, open, TODO_QUIET_ROUNDS - 1), 0);
  assert.equal(run(s, open, 1), 1);
  assert.equal(run(s, open, TODO_QUIET_ROUNDS - 1), 0, "not again straight away");
  assert.equal(run(s, open, 1), 1, "and again after another quiet run");
});

test("a todo_write resets the count", () => {
  const s: TodoQuiet = { rounds: 0 };
  run(s, open, TODO_QUIET_ROUNDS - 1);
  assert.equal(todoReminderDue(s, open, true), false);
  assert.equal(run(s, open, TODO_QUIET_ROUNDS - 1), 0);
});

test("a finished or empty list never triggers it", () => {
  assert.equal(run({ rounds: 0 }, done, TODO_QUIET_ROUNDS * 3), 0);
  assert.equal(run({ rounds: 0 }, [], TODO_QUIET_ROUNDS * 3), 0);
});

test("the reminder is one line and names the active item", () => {
  const text = todoReminderText(open);
  assert.equal(text.split("\n").length, 1);
  assert.match(text, /2 items are still open/);
  assert.match(text, /Add the parser/);
});
