/**
 * help.ts — what `/help` prints.
 *
 * Rendered from the SAME command list the input's autocomplete offers, plus the
 * project skills and MCP prompts that are live in this session. A second
 * hand-maintained list of commands would be a literal standing in for something
 * that already has a source of truth, and it would go stale the first time a
 * command was added — see BOUNDARY.md.
 *
 * Pure: takes the lists, returns the text. The caller does the gathering.
 */

export interface CommandInfo {
  name: string;
  description: string;
}

/** A named group of commands, rendered under its own heading. Empty groups are dropped. */
export interface HelpSection {
  title: string;
  commands: readonly CommandInfo[];
}

/** Right-pad a command name so the descriptions line up in a column. */
function column(commands: readonly CommandInfo[]): number {
  return commands.reduce((w, c) => Math.max(w, c.name.length), 0);
}

/**
 * Render the help text. Sections with no commands are omitted entirely, so a
 * project with no skills and no MCP servers sees a clean list rather than empty
 * headings.
 */
export function formatHelp(sections: readonly HelpSection[]): string {
  const live = sections.filter((s) => s.commands.length > 0);
  // One column width across ALL sections, so the descriptions form a single
  // aligned edge rather than restarting per heading.
  const width = column(live.flatMap((s) => [...s.commands]));

  const blocks = live.map((s) => {
    const rows = s.commands.map((c) => `  ${c.name.padEnd(width)}  ${c.description}`);
    return `${s.title}\n${rows.join("\n")}`;
  });

  return [
    ...blocks,
    // The two things a new user needs that have no other discovery path: there is
    // no autocomplete entry for either, and nothing else mentions them.
    "Also\n" +
      "  @path             attach a file to your message (Tab completes the path)\n" +
      "  !command          run a command yourself, now: ! git status. The agent reads it on its next turn\n" +
      "  Esc               stop what's running\n" +
      "  Esc Esc           on an empty box, rewind to an earlier message\n" +
      // The input stays live while a turn runs and the placeholder says so, so
      // QUEUEING is discoverable. Getting back OUT of the queue is not: nothing on
      // screen mentions it until something is already queued, and by then a user who
      // has changed their mind is looking for a way to undo, not to read a hint.
      "  ↑                 take back a message you queued while it was working\n" +
      "  Click             a line that ends in ▸ opens it, and a second click folds it\n" +
      "  Ctrl+O            opens or folds the newest one, if your terminal sends no mouse\n" +
      "  PageUp / wheel    scroll back through the conversation; Ctrl+End comes back to the end\n" +
      "  Drag              selects text, and releasing copies it. Keep going past the top or bottom\n" +
      "                    edge, or turn the wheel while you hold, and the selection keeps growing",
    // The one thing on screen that is NOT what it looks like: a single line standing for many
    // calls. It is folded on purpose, and nothing on the line itself says how to open it.
    "About the lines that fold\n" +
      "  What the agent runs, reads and tests is folded into one line, such as\n" +
      "      Ran 3 commands, read 2 files  ✓ ✗ ✓  ▸\n" +
      "  The marks show how each command ended, so a failure is red without opening anything.\n" +
      "  Click the line to list them: each command with how it ended, each file with the part\n" +
      "  that was read (lines 410–551, or the whole file). Click a command to see what it\n" +
      "  printed. When it tests your app, each step is a line too (Tested 4 steps), and a\n" +
      "  step that failed says why. A long output, a file written whole or an edit works the same way.",
    "About a message you want sent now\n" +
      "  Typing while the agent works queues your message, and it reaches the agent when its\n" +
      "  current step ends. Press ctrl+F instead of Enter to get it there sooner: a command the\n" +
      "  agent is waiting on moves to the background (as with ctrl+X) and keeps running, so the\n" +
      "  step ends and your message arrives at once. Nothing is stopped. With the box empty,\n" +
      "  ctrl+F does that for what is already queued. Esc is the key that stops things.",
    "About a command that takes long\n" +
      "  After a couple of seconds the command's own line offers ctrl+X. Press it and the\n" +
      "  command the agent is waiting on keeps running as a background shell, and the agent\n" +
      "  carries on (every command running at that moment moves). It is told you did it, and\n" +
      "  is told when the command ends. The agent can still do the same on its own.",
    // Sub-agents are the one part of the machinery that visibly does something on
    // screen without explaining itself: a rail of tool calls appears under a worker
    // that is not the agent you were talking to. What it costs you and what it hands
    // back is worth stating ONCE, here, rather than on every delegation.
    "About sub-agents\n" +
      "  Mindweave can hand a wide, self-contained job to a sub-agent — a sweeping\n" +
      "  search, an inventory, a bounded refactor — and work from what it reports back.\n" +
      "  Their raw tool loops and output never enter the main conversation, so a large\n" +
      "  search costs you a summary instead of a hundred results. They return finished\n" +
      "  work (a patch, an answer), compact their own context independently, and cannot\n" +
      "  change files unless the job they were given is a job that changes files.\n" +
      "  On screen a sub-agent is a short title and how it ended (✓ done, ✗ failed, ! only\n" +
      "  partly), with its steps and time. Click it to see its task, what it did and the result.",
  ].join("\n\n");
}
