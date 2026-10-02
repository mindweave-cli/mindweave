/**
 * marathonUi.ts — what the CLI's Marathon box shows, as plain data and pure functions.
 *
 * The box is a PASSIVE panel under the input: it never takes the keyboard, so the person
 * keeps typing (a queued message, an answer) while it sits there. Its size follows its
 * content up to a cap and then stops — a long task list scrolls inside a fixed window
 * rather than growing the box, and a short one is not padded out to the cap.
 *
 * Kept free of Ink so the rules (which rows show, how tall the box is, what each event
 * does to it) are unit-tested instead of eyeballed.
 */
import type { TodoItem } from "../tools/types.js";
import { describeMarathonEvent, type MarathonEvent } from "../dynamo/marathon.js";

export type MarathonUiPhase =
  | "armed" // waiting for the goal: the next message starts the run
  | "running"
  | "verifying"
  | "paused" // stopped by the user; resumable
  | "done"
  | "blocked"
  | "stuck"
  | "budgetExceeded";

export interface MarathonUi {
  phase: MarathonUiPhase;
  goal: string;
  /** The one line under the header: what the run is doing right now, or how it ended. */
  line: string;
  turn: number;
  todos: TodoItem[];
}

export type MarathonUiAction =
  | { type: "arm" }
  | { type: "event"; event: MarathonEvent }
  /** The model rewrote its task list. */
  | { type: "todos"; items: TodoItem[] }
  /** A run picked back up from a saved session: its goal, counters and last list. */
  | { type: "restore"; goal: string; turn: number; todos: TodoItem[] };

export function isFinished(ui: MarathonUi): boolean {
  return ui.phase === "done" || ui.phase === "blocked" || ui.phase === "stuck" || ui.phase === "budgetExceeded";
}

/** Still working, or stopped in a way that can carry on. */
export function isLive(ui: MarathonUi): boolean {
  return ui.phase === "running" || ui.phase === "verifying";
}

export function marathonUiReduce(ui: MarathonUi | null, action: MarathonUiAction): MarathonUi | null {
  switch (action.type) {
    case "arm":
      return { phase: "armed", goal: "", line: "", turn: 0, todos: [] };
    case "restore":
      return { phase: "running", goal: action.goal, line: "", turn: action.turn, todos: action.todos };
    case "todos":
      return ui ? { ...ui, todos: action.items } : ui;
    case "event": {
      const e = action.event;
      const line = describeMarathonEvent(e);
      const base: MarathonUi = ui ?? { phase: "running", goal: "", line: "", turn: 0, todos: [] };
      switch (e.type) {
        case "started":
          return { phase: "running", goal: e.goal, line, turn: 0, todos: [] };
        case "resumed":
          return { ...base, phase: "running", goal: e.goal, line, turn: e.turnsSpent };
        case "turn":
          return { ...base, phase: "running", line, turn: e.n };
        case "verifying":
        case "verifyStep":
          return { ...base, phase: "verifying", line };
        case "finished":
          return { ...base, phase: e.status, line };
        case "paused":
          return { ...base, phase: "paused", line };
        case "planned":
        case "continuing":
        case "waiting":
        case "verified":
          return { ...base, phase: "running", line };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The checklist window
// ---------------------------------------------------------------------------

export interface ChecklistWindow {
  /** The items to draw, in order, each with its position in the full list. */
  rows: Array<{ item: TodoItem; index: number }>;
  /** Items hidden above and below the window (each shown as one indicator row). */
  above: number;
  below: number;
}

/** The task the run is on: the one in progress, else the next pending, else the last. */
export function activeIndex(items: readonly TodoItem[]): number {
  const working = items.findIndex((t) => t.status === "in_progress");
  if (working >= 0) return working;
  const pending = items.findIndex((t) => t.status === "pending");
  if (pending >= 0) return pending;
  return Math.max(0, items.length - 1);
}

/**
 * Which items fit in `cap` rows. A list that fits is shown whole; a longer one shows a window
 * that keeps the active task in view with a little history above it, and spends a row on an
 * indicator at each end that has hidden items. The indicators count against the cap, so the
 * total never exceeds it.
 */
export function windowChecklist(items: readonly TodoItem[], cap: number): ChecklistWindow {
  const all = items.map((item, index) => ({ item, index }));
  if (cap < 1) return { rows: [], above: items.length, below: 0 };
  if (items.length <= cap) return { rows: all, above: 0, below: 0 };

  const active = activeIndex(items);
  // Too small for an indicator row to be worth its place: just the rows around the active
  // task, and no counts (the box never asks for a window this small).
  if (cap < 3) {
    const start = Math.min(Math.max(0, active), items.length - cap);
    return { rows: all.slice(start, start + cap), above: 0, below: 0 };
  }
  // Start with room for both indicators, then give a row back to whichever end turns out to
  // have nothing hidden. One task of history above the active one, when there is room for it,
  // but never at the cost of the active task itself.
  let size = cap - 2;
  const history = size >= 2 ? 1 : 0;
  let start = Math.min(Math.max(0, active - history), items.length - size);
  if (start === 0) {
    size = cap - 1; // nothing above: no indicator there
  } else if (start + size >= items.length) {
    size = cap - 1; // nothing below: no indicator there
    start = items.length - size;
  }
  size = Math.min(size, items.length - start);
  const end = start + size;
  return { rows: all.slice(start, end), above: start, below: items.length - end };
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

/** Border (2) + header (1). */
const CHROME_ROWS = 2 + 1;
/** What the armed box says: two short lines. */
const ARMED_BODY_ROWS = 2;

/** Body rows for the current state, given the cap on checklist rows. */
export function bodyRows(ui: MarathonUi, cap: number): number {
  if (ui.phase === "armed") return ARMED_BODY_ROWS;
  if (ui.todos.length === 0) return 1; // the status line stands in for a list not written yet
  const w = windowChecklist(ui.todos, cap);
  return w.rows.length + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
}

/**
 * The box's height in terminal rows: content plus chrome, never more than `cap` checklist
 * rows. Not padded up to the cap — a two-item list is a short box.
 */
export function marathonBoxHeight(ui: MarathonUi, cap: number): number {
  return CHROME_ROWS + bodyRows(ui, cap);
}
