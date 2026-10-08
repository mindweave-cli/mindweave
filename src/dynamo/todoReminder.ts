/**
 * todoReminder.ts — a one-line nudge when the task list has gone quiet (pure).
 *
 * A model working through a long list tends to stop updating it: items stay "in progress" long after
 * they are done, and the list the person watches stops matching the work. After a run of rounds with
 * no todo_write while something is still open, one short line is added to the conversation. It is
 * a line, not a block, it is asked for at most once per quiet run, and a finished (or empty) list
 * never triggers it.
 */
import type { TodoItem } from "../tools/types.js";

/** Rounds of tool use without a todo_write before the reminder is added. */
export const TODO_QUIET_ROUNDS = 10;

export interface TodoQuiet {
  /** Rounds since the list was last written (or since the last reminder). */
  rounds: number;
}

/**
 * Advance the counter by one round and say whether to remind now.
 * `wrote` is whether this round included a todo_write.
 */
export function todoReminderDue(state: TodoQuiet, todos: readonly TodoItem[], wrote: boolean): boolean {
  if (wrote) {
    state.rounds = 0;
    return false;
  }
  state.rounds++;
  const open = todos.some((t) => t.status !== "completed");
  if (!open || state.rounds < TODO_QUIET_ROUNDS) return false;
  state.rounds = 0; // once per quiet run
  return true;
}

export function todoReminderText(todos: readonly TodoItem[]): string {
  const doing = todos.find((t) => t.status === "in_progress");
  const open = todos.filter((t) => t.status !== "completed").length;
  return (
    `[Reminder: your task list has not been updated for ${TODO_QUIET_ROUNDS} rounds and ${open} item${open === 1 ? " is" : "s are"} still open` +
    (doing ? ` (in progress: "${doing.content}")` : "") +
    `. If any of it is done, mark it with todo_write; otherwise carry on.]`
  );
}
