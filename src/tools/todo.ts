/**
 * todo.ts — the session task list.
 *
 * On a multi-step job a model drifts: it forgets a step, repeats one, or declares
 * done while something's unfinished. A model-maintained checklist fixes that. It is
 * NOT shown to the user (see the quiet flag on the result): the tool rows that carry
 * meaning are the ones showing work happening, and a "list rewritten" row between
 * them, repeated every time a single item changed state, was noise around the signal.
 * The list still does its whole job unseen, because its reader is the model. The model
 * rewrites the WHOLE list
 * each call (simplest correct model: no partial-update bugs); we store it on the
 * ToolContext, and the tool's own REPLY carries the whole list back into the
 * conversation — which is where the model reads it from. The engine no longer re-injects
 * it per turn: that re-sent the list, uncached, on every step to duplicate something the
 * tool result already held. It therefore no longer survives compaction independently;
 * once the reply is cleared the model rewrites the list, which it does routinely anyway.
 *
 * Thin-prompt boundary: this description teaches only the mechanical CONTRACT
 * (the three states, one in_progress at a time, the two text forms, complete-
 * immediately). Deciding WHEN a task is worth a list, and how to break it down,
 * is the model's judgment — we don't script that here (a long when-to-use essay is
 * exactly the kind of model-work we keep out of the prompt).
 */
import type { Tool, ToolContext, ToolResult, TodoItem, TodoStatus } from "./types.js";
import { failQuietly } from "./results.js";

const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];

/** Below this, closing everything out is a small job finishing, not a run of work worth
 *  an independent check. Three is where "I did a few things" starts. */
const NUDGE_AT = 3;

/** Words that mean a task WAS the checking. Matched loosely because the model writes
 *  these itself and will phrase them freely. */
const VERIFICATION_WORDS = /\bverif|\btest|\bcheck|\bprov(e|ing|ed)\b|\bvalidat|\bconfirm/i;

/**
 * Should this update carry the verification reminder (pure)?
 *
 * True only when EVERYTHING is finished and none of it was itself a check. A list that
 * still has work in it is mid-run and the reminder would be noise; a list containing a
 * "run the tests" task already did the thing being suggested, and nagging about it would
 * teach the model to ignore the note — which is the real cost of a false positive here.
 */
export function needsVerificationNudge(items: TodoItem[]): boolean {
  if (items.length < NUDGE_AT) return false;
  if (!items.every((t) => t.status === "completed")) return false;
  return !items.some((t) => VERIFICATION_WORDS.test(t.content));
}

export const todoWrite: Tool = {
  name: "todo_write",
  /** Deferred: a task list is a planning instrument reached for once on a substantial
   *  task, not a step in the edit loop, so its schema does not belong in front of the
   *  model on every request. */
  deferred: true,
  readOnly: false,
  description:
    "Create and update your task list for the current job. Pass the COMPLETE list " +
    "every time (it replaces the previous one). Use it for any task of roughly 3+ " +
    "steps to track progress and show the user where things stand; skip it for " +
    "trivial one-step work. This call returns the full updated list, and that reply stays " +
    "in your context — so you never need to call it again just to see the list, and you " +
    "never need to restate it in your reply. Keep exactly one task 'in_progress' at a time, mark a " +
    "task 'completed' the moment it's truly done (not before — not if tests fail or " +
    "work is partial), and drop tasks that no longer apply. When all tasks are " +
    "completed the list clears itself.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        description: "The full, updated task list.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["content", "status"],
          properties: {
            content: {
              type: "string",
              description: "Imperative form of the task, e.g. 'Run the tests'.",
            },
            activeForm: {
              type: "string",
              description: "Optional present-continuous form shown while active, e.g. 'Running the tests'. Defaults to content.",
            },
            status: {
              type: "string",
              enum: STATUSES,
              description: "pending | in_progress | completed.",
            },
          },
        },
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const parsed = parseTodos(args.todos);
    if (typeof parsed === "string") return failQuietly(parsed);

    // All done → clear the list (a finished list disappears).
    const allDone = parsed.length > 0 && parsed.every((t) => t.status === "completed");
    ctx.todos = allDone ? [] : parsed;

    const inProgress = parsed.filter((t) => t.status === "in_progress").length;
    const notes: string[] = [];
    if (inProgress > 1) {
      notes.push(`Note: ${inProgress} tasks are in_progress — keep it to one at a time.`);
    }
    // THE VERIFICATION NUDGE, and it lives HERE rather than in the prompt on purpose.
    //
    // A standing rule about verifying before reporting done is exactly the kind of rule
    // that survives a short task and is gone by the end of a long one — the prompt is far
    // away and the work is right here. This fires at the moment the model is closing out
    // a run of tasks, in the result it is already reading, which is the one place it
    // cannot have drifted from. Nothing is blocked: it is a reminder in a tool result,
    // not a gate, because the model may have good reason to skip it.
    if (needsVerificationNudge(parsed)) {
      notes.push(
        `Note: ${parsed.length} tasks are done and none of them was a verification step. ` +
          "If this turn made non-trivial changes, spawn a verifier (spawn_subagent with " +
          "verify:true) before reporting the work complete — give it the original request, " +
          "the files that changed, and the approach. Listing your own caveats is not a verdict.",
      );
    }

    const body = allDone
      ? "All tasks completed — list cleared."
      : render(parsed);
    const output = [body, ...notes, "", "Keep the list updated as you work."].join("\n");

    // QUIET: the list never renders a row. It is the model's own scratch memory for
    // staying on track across a long job, and this reply carries the whole list into the
    // conversation — so it works exactly as well unseen. On screen it was noise:
    // a row that says a checklist was rewritten, printed again every time one item
    // moved, in between the rows that show actual work.
    //
    // The model still gets the full output, including the one-at-a-time nudge.
    return { output, summary: summarize(parsed, allDone), quiet: true };
  },
};

/** Validate and normalize the model's `todos` argument. Returns items or an error string. */
function parseTodos(raw: unknown): TodoItem[] | string {
  if (!Array.isArray(raw)) return "`todos` must be an array of task objects.";
  const items: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown> | null;
    if (!t || typeof t !== "object") return `todos[${i}] must be an object.`;
    const content = typeof t.content === "string" ? t.content.trim() : "";
    const activeForm = typeof t.activeForm === "string" ? t.activeForm.trim() : "";
    const status = t.status as TodoStatus;
    if (!content) return `todos[${i}].content is required.`;
    if (!STATUSES.includes(status)) return `todos[${i}].status must be one of: ${STATUSES.join(", ")}.`;
    // Optional. It only changes how the task in progress reads back, and refusing a whole
    // list over it cost a real session a round.
    items.push({ content, activeForm: activeForm || content, status });
  }
  return items;
}

/** Render a checklist the model reads back (and the basis for the prompt block). */
export function render(todos: TodoItem[]): string {
  return todos.map((t) => `${box(t.status)} ${label(t)}`).join("\n");
}

function box(status: TodoStatus): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
}

/** In-progress tasks read in their active form ("Running tests"); others imperative. */
function label(t: TodoItem): string {
  return t.status === "in_progress" ? t.activeForm : t.content;
}

function summarize(todos: TodoItem[], allDone: boolean): string {
  if (allDone) return "all tasks completed";
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  const head = active ? `→ ${active.activeForm}` : "task list updated";
  return `${head} (${done}/${todos.length} done)`;
}


