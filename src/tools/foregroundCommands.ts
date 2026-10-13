/**
 * foregroundCommands.ts — the commands that are running right now with the turn waiting
 * on them, and the one thing a person can do to them: move them to the background.
 *
 * Until now only the agent decided that (`run_in_background`, or the clock at two
 * minutes). A person watching a build crawl along had no way to say "carry on without
 * waiting for this". The process itself needs no change for that: a foreground command
 * already writes into a file the background-shell manager can take over, which is exactly
 * what the soft timeout does. What was missing was a handle the keyboard could reach, and
 * this is it.
 *
 * Deliberately tiny and free of UI and process code: a command registers a `promote`
 * function while it runs, and whoever has the keystroke calls `promoteAll`.
 */

/** Who asked for the move. Only a person is "user"; the clock is not a request. */
export type PromoteBy = "user";

export interface ForegroundCommand {
  /** The tool call's id, so a UI can tie the command to its row. */
  id: string;
  command: string;
  startedAt: number;
  /** Move this command to the background. False when it cannot be (it just ended, or
   *  there is no manager to take it); a command that returns false stays foreground. */
  promote(by: PromoteBy): boolean;
}

export class ForegroundCommands {
  private readonly items = new Map<number, ForegroundCommand>();
  private seq = 0;
  private onChange: (() => void) | null = null;

  /** Told whenever the set changes, so a status line can show or hide its hint. */
  setOnChange(handler: (() => void) | null): void {
    this.onChange = handler;
  }

  /** Register a running command. Returns the function that removes it again; calling it
   *  twice is harmless, because a command can settle by more than one road. */
  register(command: ForegroundCommand): () => void {
    const key = ++this.seq;
    this.items.set(key, command);
    this.onChange?.();
    return () => {
      if (this.items.delete(key)) this.onChange?.();
    };
  }

  /** What is running in the foreground, oldest first. */
  running(): readonly ForegroundCommand[] {
    return [...this.items.values()];
  }

  /** When the OLDEST foreground command started, or null when none is running. */
  oldestStart(): number | null {
    let oldest: number | null = null;
    for (const c of this.items.values()) if (oldest === null || c.startedAt < oldest) oldest = c.startedAt;
    return oldest;
  }

  /**
   * Move every running foreground command to the background. Returns how many moved.
   *
   * All of them, not the newest: the model can send several commands in one step, the
   * person pressing the key means "stop making me wait", and leaving one behind would
   * keep the turn blocked on it.
   */
  promoteAll(by: PromoteBy = "user"): number {
    let moved = 0;
    for (const command of [...this.items.values()]) {
      try {
        if (command.promote(by)) moved++;
      } catch {
        // One command that cannot move must not stop the others.
      }
    }
    return moved;
  }
}
