/**
 * startupArgs.ts — the flags handled before the UI exists.
 *
 * `mindweave --version` used to ignore the flag, start the whole terminal UI, and
 * never exit. Piped or run without a TTY it then died on Ink's raw-mode error. That
 * is the first command anyone runs against a new CLI, and packaging tools run it
 * unattended, so hanging there is worse than it sounds.
 *
 * Parsing is a pure function returning what to print, so it is testable without
 * spawning a process, and `index.ts` keeps the one side effect: print and exit.
 *
 * Deliberately tiny. Mindweave takes no launch CONFIGURATION options — it roots at the
 * current directory and everything else is set in `~/.mindweave/.env` or in-session, and
 * inventing flags here would create a second place to configure the same things. What
 * does belong is the handful of things you ask the command to DO instead of starting a
 * session: report its version, explain itself, or repair a terminal a previous run left
 * broken.
 */
import { appVersion } from "./version.js";

export type Startup =
  /** Start normally, resuming `resumeSessionId` when one was asked for. */
  | { kind: "run"; resumeSessionId?: string }
  /** Print `text` and exit 0. */
  | { kind: "print"; text: string }
  /** Write the terminal-restore sequences and exit 0. Separate from `print` because
   *  whether there is a terminal to restore is a question about the actual stdout, and
   *  parsing stays pure. */
  | { kind: "reset" };

/** `mindweave --version` output: the bare version, which is what scripts parse. */
export function versionText(): string {
  const v = appVersion();
  return v ? `mindweave ${v}` : "mindweave (version unknown)";
}

/** `mindweave --help` output. */
export function helpText(): string {
  const v = appVersion();
  return [
    `Mindweave 2${v ? ` (v${v})` : ""} — a terminal coding agent that works inside your repository.`,
    "",
    "Usage:",
    "  mindweave                     start a session in the current directory",
    "  mindweave --help              show this and exit",
    "  mindweave --version           print the version and exit",
    "  mindweave --reset-terminal    put a terminal back in order after a crash",
    "",
    "If a run ends badly the terminal can be left reporting mouse events, so every",
    "scroll writes something like ^[[<64;36;23M into your shell. --reset-terminal",
    "stops that. It is safe to run at any time.",
    "",
    "Setup:",
    "  Put your model API key in ~/.mindweave/.env, for example:",
    "    DEEPSEEK_API_KEY=your-key-here",
    "    ANTHROPIC_API_KEY=your-key-here",
    "  A project .env or an exported shell variable works too.",
    "",
    "Once running, type /help for the commands available in a session,",
    "and press shift+tab to change how much rein the agent has.",
    "",
    "Windows only for now. Docs and issues:",
    "  https://github.com/mindweave-cli/Mindweave",
  ].join("\n");
}

/**
 * Decide what a launch should do (pure).
 *
 * Only exact flags count. A stray argument is NOT an error: the session roots at the
 * current directory regardless, and refusing to start over an argument nobody
 * documented would be a worse failure than ignoring it.
 */
export function parseStartupArgs(argv: readonly string[]): Startup {
  let resumeSessionId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "print", text: helpText() };
    if (arg === "--version" || arg === "-v") return { kind: "print", text: versionText() };
    // No short form on purpose: this is typed once in a blue moon, by someone reading it
    // out of --help, and a one-letter alias for it would be a trap next to -h and -v.
    if (arg === "--reset-terminal") return { kind: "reset" };
    if (arg === "--resume") {
      // Undocumented in --help on purpose: nobody types this. It is how a relaunch
      // after `/update` lands back in the conversation it left, and the only thing
      // that writes it is Mindweave itself.
      //
      // A malformed id starts a NORMAL session rather than refusing to launch. This
      // flag's whole job is to make an update invisible, and the one outcome worse
      // than losing the thread is not coming back at all — `/continue` still reaches
      // the session either way.
      resumeSessionId = safeSessionId(argv[i + 1]);
      i++;
    }
  }
  return resumeSessionId === undefined ? { kind: "run" } : { kind: "run", resumeSessionId };
}

/**
 * A session id, only if it is one (pure).
 *
 * The id is used to build a path under the project's session directory, so it is
 * checked as a filename component rather than trusted as a label: no separators, no
 * dots, nothing that could climb out of the folder it is meant to name. Session ids
 * are UUIDs, so this rejects nothing legitimate.
 */
export function safeSessionId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : undefined;
}

/**
 * Whether there is a terminal to read keystrokes from.
 *
 * The UI puts stdin into raw mode to read a keypress. Where stdin is a pipe or a
 * redirect there is no raw mode to enter, and the failure arrives from inside the
 * renderer as a stack trace through React internals: it names none of the things a
 * reader could act on, and the process still exits 0, so a script calling it reads
 * success. Asked here as a plain question about the stream, so the entry point can
 * say what is wrong and fail in a way a script can see.
 */
export function hasInteractiveInput(stdin: { isTTY?: boolean }): boolean {
  return stdin.isTTY === true;
}

/** Shown when there is no terminal to read from. */
export const NO_TERMINAL_MESSAGE = [
  "Mindweave is an interactive terminal application and needs a terminal to read from.",
  "Its input is a pipe or a redirect, so there is no keyboard to attach to.",
  "",
  "Run it in a terminal window, from the folder you want to work in.",
  "--help and --version work anywhere.",
  "",
].join(String.fromCharCode(10));
