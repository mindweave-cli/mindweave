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
      "  Esc               stop what's running\n" +
      "  Esc Esc           on an empty box, rewind to an earlier message\n" +
      // The input stays live while a turn runs and the placeholder says so, so
      // QUEUEING is discoverable. Getting back OUT of the queue is not: nothing on
      // screen mentions it until something is already queued, and by then a user who
      // has changed their mind is looking for a way to undo, not to read a hint.
      "  ↑                 take back a message you queued while it was working\n" +
      "  Click             a line that ends in ▸ opens it, and a second click folds it\n" +
      "  Ctrl+O            opens or folds the newest one, if your terminal sends no mouse\n" +
      "  PageUp / wheel    scroll back through the conversation; Ctrl+End comes back to the end",
    // The one thing on screen that is NOT what it looks like: a single line standing for many
    // calls. It is folded on purpose, and nothing on the line itself says how to open it.
    "About the lines that fold\n" +
      "  What the agent runs and reads is folded into one line, such as\n" +
      "      Ran 3 commands, read 2 files  ✓ ✗ ✓  ▸\n" +
      "  The marks show how each command ended, so a failure is red without opening anything.\n" +
      "  Click the line to list them: each command with how it ended, each file with the part\n" +
      "  that was read (lines 410–551, or the whole file). Click a command to see what it\n" +
      "  printed. A long output, a file written whole or an edit works the same way.",
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
      "  change files unless the job they were given is a job that changes files.",
  ].join("\n\n");
}
