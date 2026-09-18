/**
 * backgroundShells.ts — long-running commands that outlive a turn.
 *
 * When a command crosses its timeout (or the model asks for `run_in_background`),
 * run_command hands the LIVE process to this manager instead of killing it. The
 * manager owns the registry of background shells per session, buffers their output
 * (capped, so a chatty dev server never floods memory or the model's context), and
 * exposes:
 *
 *   - `read(id)`  — only the NEW output since the last read (incremental).
 *   - `kill(id)`  — whole-tree kill.
 *   - `list()`    — running + finished shells (for the UI and /shells).
 *
 * Two ONE-SHOT, self-cleaning event channels keep notifications from leaking
 * (avoiding the common footgun where finished jobs re-inject into the model forever):
 *   - `takeUiEvents()` — shells that came up or stopped, not yet shown in the chat.
 *   - `drainEvents()`  — the same for the MODEL, each with a tail of output, so it is
 *                        told once and then never again.
 *
 * Every event is delivered. What varies is whether it INTERRUPTS the session: a stop
 * the user caused arrives as background fact on the next turn rather than waking the
 * model, which is what stops it reopening an app somebody just closed.
 *
 * Client-side, like the alternator lanes: it holds live process handles, never
 * crosses the engine↔brain wire. All children are killed on process exit.
 */
import { promises as fs } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { killTree, killTreeSync } from "./killTree.js";
import { OutputReader, removeOutputFile, sizeOf } from "./commandOutput.js";
import { stripNativeStderrNoise } from "./nativeStderr.js";

const MAX_BUFFER_CHARS = 5_000_000;
/** How often a running shell's output file is read. Fast enough that  returns
 *  something current, slow enough to be free on a machine doing real work. */
const POLL_MS = 500;
/** How much one poll reads. A bound, not a budget: whatever is left arrives next tick. */
const POLL_READ_BYTES = 256 * 1024;
/**
 * How large one shell's output file may grow before the shell is stopped.
 *
 * Backgrounded, nothing else limits it. The foreground timeout is gone, the child writes
 * straight to the descriptor with nothing in the way, and a process stuck in an append
 * loop will take the disk with it — which is a far worse outcome than losing the command.
 */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OUTPUT_DISPLAY = "2GB"; // cap one shell's retained output (runaway server)
export const MAX_READ_CHARS = 30_000; // cap a single `shells` read
const TAIL_CHARS = 2_000; // how much trailing output rides on a completion note

/**
 * How long a server has to stay up before we treat its death as "someone stopped it"
 * rather than "it failed to start".
 *
 * This is the one honest way to tell the two apart, because the exit status cannot:
 * measured on Windows, a user closing an app reports `code 1`, and so does a server
 * that crashed because its port was taken. Duration separates them cleanly — a port
 * conflict dies in under a second, a session you close has been up for minutes.
 *
 * Borrowed from process supervisors, which hit this decades ago: supervisord counts a
 * program as failed-to-start if it exits before `startsecs` (default 1s) regardless of
 * its exit code. 10s is deliberately generous, since a dev server can take several
 * seconds to bind a port and fail.
 */
const STARTUP_GRACE_MS = 10_000;

/**
 * How long to wait after `exit` for `close` before finalizing anyway.
 *
 * `close` fires only once every stdio stream is closed, and a surviving grandchild can
 * hold the pipe open forever, which strands the entry as permanently "running".
 * `exit` fires when the process itself goes, so it is the backstop; the delay lets
 * `close` win normally so buffered output is not lost.
 */
const EXIT_GRACE_MS = 2_000;

/** A millisecond value with an env override, for tuning and for testing the watchdog
 *  without waiting out the real thresholds. Unset or invalid falls back to the default. */
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** How often the stall watchdog scans running shells. */
const STALL_CHECK_MS = envMs("MINDWEAVE_STALL_CHECK_MS", 5_000);
/**
 * A backgrounded command that has printed nothing for this long AND whose last line
 * looks like an interactive prompt is treated as blocked on input. Sooner than the
 * silent threshold, because a prompt is immediately actionable — the command will
 * never move on its own.
 */
const STALL_PROMPT_MS = envMs("MINDWEAVE_STALL_PROMPT_MS", 30_000);
/**
 * A command EXPECTED to finish (`on_finish`) that has printed nothing for this long is
 * flagged as possibly stuck, even without a prompt. Generous, because a real build has
 * silent stretches (linking, a slow test) and nagging a working command is worse than
 * waiting; but far short of a multi-minute deadlock sitting invisible until the timeout.
 * Servers are exempt — going quiet is their healthy resting state, not a stall.
 */
const STALL_SILENT_MS = envMs("MINDWEAVE_STALL_SILENT_MS", 120_000);

/**
 * Last-line shapes that mean a command is blocked waiting for the keyboard. Kept
 * narrow on purpose: a false positive tells the model to kill a healthy command, so
 * only lines that genuinely read as a prompt count.
 */
const PROMPT_PATTERNS: RegExp[] = [
  /\(y\/n\)\s*$/i,
  /\[y\/n\]\s*$/i,
  /\(yes\/no\)\s*$/i,
  /\b(?:do you|would you|are you sure|overwrite|proceed|continue)\b[^?\n]*\?\s*$/i,
  /press\s+(?:any key|enter|return)\b/i,
  /\bpassword\b\s*:?\s*$/i,
  /\bpassphrase\b[^:\n]*:\s*$/i,
];

/** Whether the tail of a shell's output ends on something that reads as an input prompt. */
export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.replace(/\s+$/, "").split("\n").pop() ?? "";
  return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

export type ShellStatus = "running" | "exited" | "killed";

/**
 * What the caller wants to hear about, declared when the command is started.
 *
 * This replaces guessing from the command string. The old heuristic matched a list of
 * dev-server names, so `cargo run`, `docker compose up`, `flask run` and a plain path
 * to a binary were all mistaken for finite tasks. A caller knows which it is; a regex
 * can only ever know the names someone thought of.
 *
 *   - `on_finish`  — tell me when it ends, however it ends. Builds, tests, installs:
 *                    the result IS the point.
 *   - `on_failure` — tell me when it comes up, and if it never does. A normal stop is
 *                    silent, because someone closing their own app is not an event to
 *                    act on. Servers and apps.
 *   - `never`      — say nothing, ever. Start it and forget it.
 */
export type NotifyPolicy = "on_finish" | "on_failure" | "never";

/** Who stopped a shell, when somebody did. Absent means it ended on its own. */
/** Who ended a shell.  is this process stepping in — today only when a runaway
 *  fills the disk, which is nobody's decision and must not read as one. */
export type StopActor = "agent" | "user" | "system";

/** The things that can be worth telling the model about a background shell. */
export type ShellEventKind = "ready" | "ended" | "stalled";

/** Why a running shell was flagged as stalled — a prompt it is blocked on, or just
 *  silence from a command that was expected to keep working. */
export type StallReason = "prompt" | "silent";

/**
 * Guess a notify policy from the command, for callers that did not declare one.
 *
 * This is a FALLBACK, not the decision. The policy is declared at call time; this only
 * picks a default when nothing was said, so a caller that forgets does not regress to
 * "reopen the app the user just closed". Being a list of names, it is wrong for
 * everything nobody thought of (`cargo run`, `docker compose up`, `flask run`, a plain
 * path to a binary) — which is exactly why it is no longer the authority.
 */
export function guessNotifyPolicy(command: string): NotifyPolicy {
  return isInteractiveServerCommand(command) ? "on_failure" : "on_finish";
}

/**
 * Is this command a dev server / interactive app — something that runs until stopped,
 * where "it exited" means the USER closed it, NOT that a task finished? (pure/tested)
 *
 * Only used now to pick a default (see `guessNotifyPolicy`). A finite task (build,
 * test, lint) that finishes IS a result worth surfacing, but a dev server exiting is
 * just the user closing their app, and reacting to it makes the model reopen the thing
 * they just closed. `build` variants are finite tasks, so they're excluded even though
 * they share a runner name.
 */
export function isInteractiveServerCommand(command: string): boolean {
  const c = command.toLowerCase();
  if (/\bbuild\b/.test(c)) return false; // `next build`, `tauri build`, `vite build` — finite
  // Package-runner dev/serve/start/preview scripts: `npm run dev`, `pnpm start`, `yarn serve`.
  if (/\b(npm|pnpm|yarn|bun)\b[^\n]*\b(dev|serve|start|preview)\b/.test(c)) return true;
  // Dev servers / desktop-app runners invoked directly.
  return /\b(tauri|vite|next|nuxt|remix|astro|nodemon|electron|expo|ng|http-server|live-server|serve|webpack-dev-server|watchexec)\b/.test(
    c,
  );
}

/**
 * Should a finished shell INTERRUPT the user with a turn? (pure/tested)
 *
 * Note the narrow question. This does NOT decide whether the model is told: it is
 * always told (see `drainEvents`). Swallowing the event was the real defect — the
 * model could not say "your app stopped", and if asked why the app was down it had
 * nothing. This decides only whether the stop is worth breaking into the session for.
 *
 * The rule, in the user's words: don't reopen something they closed, unless it
 * crashed before they ever got to see it.
 *
 *   - `never` → nothing is ever worth interrupting for
 *   - somebody killed it → the agent or the user did that on purpose, so they know
 *   - `on_finish` → the result is the point, always interrupt
 *   - a signal ended it → someone stopped it deliberately
 *   - otherwise → interrupt ONLY if it never came up, because then the user never saw
 *     it running and cannot know it failed
 *
 * Deliberately NOT consulted: the exit code and the duration. Exit status cannot tell
 * these cases apart — measured on Windows, a closed app and a port conflict both report
 * code 1, and a signalled process reports none at all. `cameUp` is the fact that
 * actually separates them, and it is established in ONE place (the readiness timer)
 * rather than recomputed here from a second set of numbers.
 */
export function shouldWakeOnEnd(end: {
  notify: NotifyPolicy;
  killed: boolean;
  signal: string | null;
  cameUp: boolean;
}): boolean {
  if (end.notify === "never") return false;
  if (end.killed) return false;
  if (end.notify === "on_finish") return true;
  if (end.signal) return false;
  return !end.cameUp;
}

/**
 * Is `command` already running as one of these shells? (pure/tested) Matches on the
 * normalized command string, so launching the very same server a second time is caught
 * — the failure where the model fires `npm run tauri dev` twice, the copies collide on
 * the port, and it then fights the conflict it created. Distinct servers (a frontend and
 * a backend) don't match each other, so running both is still fine.
 */
export function findRunningDuplicate(
  running: readonly ShellInfo[],
  command: string,
): ShellInfo | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(command);
  return running.find((s) => norm(s.command) === target);
}

/** How long after a user closes an app a re-launch of the same command is refused. Long
 *  enough to break the close→reopen loop that plays out over a turn or two; short enough
 *  that a restart the user genuinely asks for a while later is not held back. */
export const REOPEN_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * Was `command` an app the USER just closed? (pure/tested)
 *
 * The loop this breaks: the user closes their app, an agent that ignores the "do not
 * reopen" note fires run_command again, the user closes it again, and round it goes. A
 * match here lets the tool refuse the re-launch instead of reopening what the user shut.
 *
 * The signal is "it came up, then ended, and the AGENT did not kill it" — `ready` and
 * `stoppedBy !== "agent"`. That is deliberately the same fact `shouldWakeOnEnd` treats as
 * the user stopping their own app. It leaves the agent's OWN restart flow (kill_shell then
 * relaunch) untouched, because that ending is `stoppedBy: "agent"`; and it never blocks a
 * server that failed to start (`ready` is false), which the agent should be free to fix.
 * Matched on the normalized command within a cooldown, so a later, deliberate restart is
 * not held back.
 */
export function findRecentUserClose(
  shells: readonly ShellInfo[],
  command: string,
  now: number,
  windowMs: number = REOPEN_COOLDOWN_MS,
): ShellInfo | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(command);
  return shells.find(
    (s) =>
      s.status !== "running" &&
      s.ready &&
      s.stoppedBy !== "agent" &&
      s.finishedAt !== null &&
      now - s.finishedAt < windowMs &&
      norm(s.command) === target,
  );
}

/** Plain, serializable view of a background shell (what tools/UI see). */
export interface ShellInfo {
  id: number;
  command: string;
  cwd: string;
  status: ShellStatus;
  exitCode: number | null;
  /** The signal that ended it, when one did. A signalled process has NO exit code, so
   *  without this it reads as "exited null" — which is what a stopped app looked like. */
  signal?: string;
  startedAt: number;
  finishedAt: number | null;
  /** The port this process announced in its own output, when it announced one.
   *  Read from the buffer, never guessed — a dev server prints where it is listening,
   *  and that line is the only thing that actually knows. */
  port?: number;
  /** What this shell's caller asked to be told about. */
  notify: NotifyPolicy;
  /** Who stopped it, when somebody did. Absent means it ended on its own — which is
   *  what lets the model say "you closed it" instead of assuming it crashed. */
  stoppedBy?: StopActor;
  /** It survived the startup grace, so it is up rather than merely spawned. */
  ready: boolean;
  /**
   * The retained buffer overflowed and older output was dropped.
   *
   * Set when a chatty process pushes past MAX_BUFFER_CHARS. It was recorded and then
   * never shown anywhere, which made the loss invisible: a reader gets the bytes that
   * survived and no indication that anything is missing. Surfaced so an incomplete log
   * reads as incomplete rather than as the whole story.
   */
  truncated?: boolean;
  /** Set once the watchdog has flagged this running shell as stalled — waiting on a
   *  prompt, or silent for too long on a command that should have kept working. */
  stallReason?: StallReason;
}

export interface AdoptOptions {
  command: string;
  cwd: string;
  /** What to tell the model about. Defaults to `guessNotifyPolicy(command)`. */
  notify?: NotifyPolicy;
  /**
   * The file the child is ALREADY writing its output into.
   *
   * Handed over rather than copied, and that is the whole hand-off: the child keeps
   * writing to the same descriptor it had before, so not a byte can be lost between the
   * foreground giving up on it and this taking over. Absent only for a caller that spawned
   * a child some other way, which then has no output to read.
   */
  outputPath?: string;
  /** A temp cwd-file from run_command to clean up when the process ends. */
  cwdFile?: string;
  /**
   * A temp script file from run_command to clean up when the process ends.
   *
   * The `cmd` path materialises a `.bat`, because cmd.exe runs only the first line
   * of a multi-line `/c` string. The foreground paths delete it themselves, but a
   * command that gets BACKGROUNDED outlives them, so without this every backgrounded
   * cmd run left its script in the temp directory permanently.
   */
  tempFile?: string;
}

interface Entry extends ShellInfo {
  child: ChildProcess | null;
  /** The file the child writes into, and a reader holding this session's place in it. */
  outputPath: string | null;
  reader: OutputReader | null;
  /** How much of  has already been handed out by read(). */
  handed: number;
  /** Everything read so far, capped — kept because several callers want the LATEST output
   *  (a port to detect, a tail for the picker) rather than what is new since a read. */
  seen: string;
  truncated: boolean;
  /** When output last grew — the watchdog's clock. Reset on every append. */
  lastGrowthAt: number;
  // `stallReason` is inherited from ShellInfo (optional); set by the watchdog.
  stallReported: boolean; // stall told to the model yet?
  stallUiNotified: boolean; // stall shown in the chat yet?
  /**
   * How much of `seen` has already ridden out on a note to the model.
   *
   * A shell can produce more than one event in its life — it came up, then later it
   * stalled, then it ended — and each note carries a tail of output. Without a mark,
   * every one of those tails is cut from the END of everything seen so far, so the
   * second note repeats what the first already showed. This is the offset that makes a
   * note a DELTA: what is new since the model was last told, never the same bytes twice.
   */
  notifiedUpto: number;
  reported: boolean; // end told to the model yet?
  uiNotified: boolean; // end shown in the chat yet?
  wakeOnEnd: boolean; // is that ending worth interrupting the session for?
  readyReported: boolean; // "it came up" told to the model yet?
  readyUiNotified: boolean; // "it came up" shown in the chat yet?
  readyTimer: ReturnType<typeof setTimeout> | null;
  /** Follows the output file while the shell runs. Cleared when it ends. */
  pollTimer: ReturnType<typeof setInterval> | null;
  cwdFile?: string;
  tempFile?: string;
}

const active = new Set<BackgroundShells>();
let cleanupRegistered = false;

export class BackgroundShells {
  private seq = 0;
  private shells = new Map<number, Entry>();
  private onChange: (() => void) | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The grace periods and stall thresholds, injectable ONLY so tests can exercise the
   * mechanism without waiting out real seconds. The defaults are the shipped behaviour
   * and no production caller passes anything: a suite that waits out a 10s startup grace
   * per case was 73% of the whole run's wall time, and that cost lands again on
   * every contributor and every CI job.
   */
  constructor(
    private readonly startupGraceMs = STARTUP_GRACE_MS,
    private readonly exitGraceMs = EXIT_GRACE_MS,
    private readonly stallPromptMs = STALL_PROMPT_MS,
    private readonly stallSilentMs = STALL_SILENT_MS,
  ) {
    active.add(this);
    registerCleanup();
    // The watchdog. A backgrounded command is told to end its turn, so a process that
    // wedges — blocked on a prompt, or silently deadlocked — has nothing watching it
    // otherwise, and surfaces only when it finally times out. This scans for that.
    this.stallTimer = setInterval(() => this.checkStalls(), STALL_CHECK_MS);
    this.stallTimer.unref?.();
  }

  /** Subscribe to state changes (start / finish / kill) — the UI re-renders. */
  setOnChange(cb: (() => void) | null): void {
    this.onChange = cb;
  }

  /** Take ownership of a live child process and the file it is writing into. */
  adopt(child: ChildProcess, opts: AdoptOptions): ShellInfo {
    const id = ++this.seq;
    const entry: Entry = {
      id,
      command: opts.command,
      cwd: opts.cwd,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      child,
      outputPath: opts.outputPath ?? null,
      reader: opts.outputPath ? new OutputReader(opts.outputPath) : null,
      seen: "",
      handed: 0,
      truncated: false,
      lastGrowthAt: Date.now(),
      stallReported: false,
      stallUiNotified: false,
      notifiedUpto: 0,
      notify: opts.notify ?? guessNotifyPolicy(opts.command),
      ready: false,
      reported: false,
      uiNotified: false,
      wakeOnEnd: false,
      readyReported: false,
      readyUiNotified: false,
      readyTimer: null,
      pollTimer: null,
      cwdFile: opts.cwdFile,
      tempFile: opts.tempFile,
    };
    this.shells.set(id, entry);
    if (opts.outputPath) {
      // The child already has this file as its output and keeps writing to it, so nothing
      // is attached and nothing is copied — the reader starts at the beginning, which
      // means everything printed before the hand-off is still there to be read.
      this.poll(entry);
    } else if (child.stdout || child.stderr) {
      // A child spawned with pipes by someone else. Its output has nowhere to go unless
      // something drains it — and an undrained pipe does not merely lose output, it STOPS
      // the process once the kernel buffer fills. Reading it is what keeps it alive.
      const collect = (chunk: Buffer | string) => this.append(entry, chunk.toString());
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
    }

    // The readiness signal. A server that is still alive after the startup grace has
    // come up, and that is the one positive event worth reporting for something that
    // never "finishes". Without it the model was told to promise a report it could not
    // give: the only event it could ever receive was the end, which for a server is
    // deliberately suppressed. Tasks don't need it — their event is completion.
    if (entry.notify === "on_failure") {
      entry.readyTimer = setTimeout(() => {
        entry.readyTimer = null;
        if (entry.status !== "running") return;
        entry.ready = true;
        this.emit();
      }, this.startupGraceMs);
      entry.readyTimer.unref?.();
    }

    // `signal` is captured, not dropped: a process ended by SIGTERM/SIGINT reports
    // `code === null`, and without the signal there is no way to tell that from a
    // crash.
    child.on("close", (code, signal) => this.onClose(entry, code, signal, false));
    child.on("error", () => this.onClose(entry, null, null, false));
    // Backstop for a `close` that never arrives because a surviving grandchild still
    // holds the stdio pipe. Without this the entry stays "running" for the rest of the
    // session: the UI shows a dead shell, and `runningCount()` is permanently wrong.
    child.on("exit", (code, signal) => {
      const timer = setTimeout(() => this.onClose(entry, code, signal, false), this.exitGraceMs);
      timer.unref?.();
    });

    this.emit();
    return view(entry);
  }

  /**
   * Follow one shell's output file while it runs.
   *
   * A poll rather than a watch, because the point of the file is that nothing has to be
   * listening for the child to keep working. Missing a tick costs nothing: the next one
   * reads everything since, and the reader carries a partial character across the gap.
   *
   * It also guards the disk. Backgrounded, the only limit on what a stuck append loop can
   * write is free space, and there is no foreground timeout left to stop it — so a file
   * past the ceiling ends its process rather than the machine.
   */
  private poll(entry: Entry): void {
    const tick = async () => {
      if (entry.status !== "running" || !entry.reader) return;
      const chunk = await entry.reader.next(POLL_READ_BYTES);
      if (chunk) this.append(entry, chunk);
      if (entry.outputPath && (await sizeOf(entry.outputPath)) > MAX_OUTPUT_BYTES) {
        this.append(entry, `
[output passed ${MAX_OUTPUT_DISPLAY}; the command was stopped]
`);
        this.kill(entry.id, "system");
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    timer.unref?.();
    entry.pollTimer = timer;
  }

  /**
   * The watchdog pass: flag any running shell that has gone quiet in a way worth a word.
   *
   * Two shapes, and the scoping is what keeps it from being noise:
   *  - a PROMPT: the last line reads as a question waiting on the keyboard. Flagged for
   *    any shell that reports at all, because it will never move on its own.
   *  - SILENCE: no output for a long time from a command that was expected to FINISH.
   *    A server going quiet is its resting state, not a stall, so servers are exempt.
   * One-shot per shell: once flagged it is not re-flagged, so even a genuinely slow
   * command is mentioned at most once rather than on every scan.
   *
   * `now` is injected for tests; production passes nothing.
   */
  checkStalls(now: number = Date.now()): void {
    let changed = false;
    for (const entry of this.shells.values()) {
      if (entry.status !== "running" || entry.stallReason || entry.notify === "never") continue;
      const idle = now - entry.lastGrowthAt;
      const tail = entry.seen.slice(Math.max(0, entry.seen.length - TAIL_CHARS));
      let reason: StallReason | null = null;
      if (idle >= this.stallPromptMs && looksLikePrompt(tail)) reason = "prompt";
      else if (idle >= this.stallSilentMs && entry.notify === "on_finish") reason = "silent";
      if (!reason) continue;
      entry.stallReason = reason;
      changed = true;
    }
    if (changed) this.emit();
  }

  private append(entry: Entry, text: string): void {
    if (text) entry.lastGrowthAt = Date.now();
    entry.seen += text;
    if (entry.seen.length > MAX_BUFFER_CHARS) {
      // Keep the tail — the recent output is what matters for tests and errors.
      const cut = entry.seen.length - MAX_BUFFER_CHARS;
      entry.seen = entry.seen.slice(cut);
      // The handed mark moves with the text it points into. Left alone it would point past
      // the end after a trim and every later read would return nothing.
      entry.handed = Math.max(0, entry.handed - cut);
      entry.truncated = true;
    }
  }

  private onClose(
    entry: Entry,
    code: number | null,
    signal: string | null,
    killed: boolean,
    by?: StopActor,
  ): void {
    if (entry.status !== "running") return;
    entry.status = killed ? "killed" : "exited";
    entry.exitCode = code;
    if (signal) entry.signal = signal;
    entry.finishedAt = Date.now();
    entry.child = null;
    if (by) entry.stoppedBy = by;
    if (entry.pollTimer) {
      clearInterval(entry.pollTimer);
      entry.pollTimer = null;
    }
    // ONE more read, after the process is gone.
    //
    // A command writes right up to the moment it exits, and the last poll was up to half
    // a second before that. Stopping here without this loses whatever it said last — which
    // for a build or a test run is the entire point: the failing assertion, the summary,
    // the exit reason. Then the file goes, since everything in it is now held in .
    if (entry.reader && entry.outputPath) {
      const reader = entry.reader;
      const path = entry.outputPath;
      void (async () => {
        const rest = await reader.next(MAX_BUFFER_CHARS);
        if (rest) {
          this.append(entry, rest);
          this.emit();
        }
        removeOutputFile(path);
      })();
    }
    if (entry.readyTimer) {
      clearTimeout(entry.readyTimer);
      entry.readyTimer = null;
    }
    // A pending "it's up" must not fire after the thing has already stopped. Note this
    // clears the PENDING notice, not `entry.ready`: whether it ever came up is the fact
    // the wake decision below is built on, and it has to survive.
    entry.readyReported = true;
    entry.readyUiNotified = true;
    // Whether this ending is worth interrupting for. It is NOT marked reported here:
    // the model is always told (drainEvents), it just isn't always interrupted. Marking
    // it reported is what used to delete the event outright, leaving the model unable
    // to say the app had stopped at all.
    entry.wakeOnEnd = shouldWakeOnEnd({
      notify: entry.notify,
      killed,
      signal,
      cameUp: entry.ready,
    });
    if (entry.cwdFile) void fs.rm(entry.cwdFile, { force: true }).catch(() => {});
    if (entry.tempFile) void fs.rm(entry.tempFile, { force: true }).catch(() => {});
    this.emit();
  }

  /** New output since the last read of this shell, plus its current status. */
  async read(id: number): Promise<{ info: ShellInfo; chunk: string } | null> {
    const entry = this.shells.get(id);
    if (!entry) return null;
    // Read the file NOW rather than trusting the poll to have caught up. A read arriving
    // between ticks would otherwise miss whatever was written in the gap, which is exactly
    // the output somebody asked for.
    const fresh = entry.reader ? await entry.reader.next(POLL_READ_BYTES) : "";
    if (fresh) this.append(entry, fresh);
    let chunk = stripNativeStderrNoise(entry.seen.slice(entry.handed));
    entry.handed = entry.seen.length;
    if (chunk.length > MAX_READ_CHARS) {
      chunk = `… (earlier output omitted)\n${chunk.slice(chunk.length - MAX_READ_CHARS)}`;
    }
    return { info: view(entry), chunk };
  }

  /**
   * Kill a running shell (whole tree). Returns false if it isn't running.
   *
   * `by` records WHO stopped it. Neither actor is woken about it, since both already
   * know, but the difference is kept so the model can say "you stopped it" rather than
   * guessing that it crashed.
   */
  kill(id: number, by: StopActor = "agent"): boolean {
    const entry = this.shells.get(id);
    if (!entry || entry.status !== "running" || !entry.child) return false;
    killTree(entry.child.pid);
    this.onClose(entry, null, null, true, by);
    return true;
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].map(view);
  }
  running(): ShellInfo[] {
    return this.list().filter((s) => s.status === "running");
  }
  runningCount(): number {
    return this.running().length;
  }
  /**
   * Events worth INTERRUPTING for: a shell that just came up, or one that ended in a
   * way the user cannot already know about.
   *
   * This is deliberately narrower than "events not yet told". A stop the user caused
   * still gets delivered on the next turn (see `drainEvents`); it just doesn't break
   * into the session, which is what stops the agent reopening a closed app.
   */
  pendingCount(): number {
    return [...this.shells.values()].filter(
      (e) =>
        (e.status !== "running" && !e.reported && e.wakeOnEnd) ||
        (e.ready && !e.readyReported) ||
        (e.stallReason !== undefined && !e.stallReported),
    ).length;
  }

  /** One-shot for the UI: shells that came up or stopped and aren't in the chat yet. */
  takeUiEvents(): { info: ShellInfo; kind: ShellEventKind }[] {
    const out: { info: ShellInfo; kind: ShellEventKind }[] = [];
    for (const entry of this.shells.values()) {
      if (entry.ready && !entry.readyUiNotified) {
        entry.readyUiNotified = true;
        out.push({ info: view(entry), kind: "ready" });
      }
      if (entry.stallReason !== undefined && !entry.stallUiNotified) {
        entry.stallUiNotified = true;
        out.push({ info: view(entry), kind: "stalled" });
      }
      if (entry.status !== "running" && !entry.uiNotified) {
        entry.uiNotified = true;
        out.push({ info: view(entry), kind: "ended" });
      }
    }
    return out;
  }

  /**
   * One-shot for the MODEL: EVERYTHING it hasn't been told, each with a tail of output.
   *
   * Every ending is delivered, including the ones not worth interrupting for. Those
   * used to be deleted, which left the model unable to say an app had stopped, or to
   * answer why it was down. `wake` carries whether this was the interrupting kind, so
   * the caller can word it as news or as background fact.
   *
   * Both kinds go through this single channel, and both mark themselves so nothing is
   * ever injected twice. That one-shot property is the whole reason background jobs
   * don't slowly eat the context window, and it must survive any change here.
   */
  async drainEvents(): Promise<
    { info: ShellInfo; kind: ShellEventKind; tail: string; wake: boolean }[]
  > {
    const out: { info: ShellInfo; kind: ShellEventKind; tail: string; wake: boolean }[] = [];
    // The DELTA since this shell was last mentioned, not the last N characters of
    // everything. Cutting from the end re-sends output the model has already read the
    // moment a shell produces two events (came up, then ended), which is the same class
    // of waste as delivering one event twice. `notifiedUpto` is advanced by `mark` below,
    // so each note continues where the previous one stopped.
    const deltaOf = (entry: Entry) => {
      const fresh = entry.seen.slice(entry.notifiedUpto);
      return stripNativeStderrNoise(fresh.slice(Math.max(0, fresh.length - TAIL_CHARS)));
    };
    for (const entry of this.shells.values()) {
      // Cut ONCE per shell per drain, and handed to the first note that fires. Two events
      // can land in the same pass (a server that came up and then immediately died), and
      // giving each of them the same delta would print the same output twice in one
      // breath — the very thing the offset exists to stop.
      const delta = deltaOf(entry);
      let deltaUsed = false;
      const takeDelta = (): string => {
        if (deltaUsed) return "";
        deltaUsed = true;
        return delta;
      };
      let emitted = false;

      if (entry.ready && !entry.readyReported) {
        entry.readyReported = true;
        out.push({ info: view(entry), kind: "ready", tail: takeDelta(), wake: true });
        emitted = true;
      }
      if (entry.stallReason !== undefined && !entry.stallReported) {
        entry.stallReported = true;
        // A stall is ABOUT the silence, so it shows the last thing the shell SAID rather
        // than the delta since the previous note — which for a stalled shell is usually
        // nothing, and "(no output)" would hide the very line (a password prompt) that
        // explains why it is stuck.
        out.push({
          info: view(entry),
          kind: "stalled",
          tail: stripNativeStderrNoise(entry.seen.slice(Math.max(0, entry.seen.length - TAIL_CHARS))),
          wake: true,
        });
        emitted = true;
      }
      if (entry.status !== "running" && !entry.reported) {
        entry.reported = true;
        out.push({ info: view(entry), kind: "ended", tail: takeDelta(), wake: entry.wakeOnEnd });
        emitted = true;
      }

      // Advanced only when something was actually said about this shell, and once for the
      // whole pass however many kinds fired.
      if (emitted) entry.notifiedUpto = entry.seen.length;
    }
    return out;
  }

  /**
   * Kill every running shell and drop the registry (session swap / exit).
   *
   * `sync` is required when disposing from a process-exit handler: the default
   * kill spawns `taskkill` asynchronously, and Node runs no async work during
   * exit, so the shells would outlive us. Measured, not assumed.
   */
  dispose(sync = false): void {
    for (const entry of this.shells.values()) {
      // Kill by CHILD PRESENT, not by recorded status. A shell we have marked
      // "ended" only means its WRAPPER exited, and on POSIX that says nothing about
      // its descendants: kill the `sh -c` and the program it started is orphaned and
      // keeps running, still holding the stdio pipes. MEASURED on Linux, where the
      // orphan outlived the whole test process and stopped it from ever exiting.
      // The group kill still reaches it, because a process group survives its leader
      // as long as it has members. Signalling an already-dead pid is a harmless
      // no-op, so there is nothing to lose by not consulting the status first.
      if (entry.child) {
        if (sync) killTreeSync(entry.child.pid);
        else killTree(entry.child.pid);
      }
      if (entry.cwdFile) void fs.rm(entry.cwdFile, { force: true }).catch(() => {});
      if (entry.tempFile) void fs.rm(entry.tempFile, { force: true }).catch(() => {});
    }
    this.shells.clear();
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    active.delete(this);
  }

  private emit(): void {
    this.onChange?.();
  }
}

function view(e: Entry): ShellInfo {
  return {
    id: e.id,
    command: e.command,
    cwd: e.cwd,
    status: e.status,
    exitCode: e.exitCode,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    notify: e.notify,
    ready: e.ready,
    ...(e.signal ? { signal: e.signal } : {}),
    ...(e.stoppedBy ? { stoppedBy: e.stoppedBy } : {}),
    ...(e.truncated ? { truncated: true } : {}),
    ...(e.stallReason ? { stallReason: e.stallReason } : {}),
    ...(detectPort(e.seen) !== undefined ? { port: detectPort(e.seen) } : {}),
  };
}

/** Kill any background processes still running when the process exits. */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    // Synchronous kill: an async one never reaches the OS from here.
    for (const mgr of active) mgr.dispose(true);
  });
}

/**
 * The port a process announced in its own output.
 *
 * A backgrounded dev server is only useful if you know where it is listening, and the
 * one thing that knows is the server itself — it prints the URL on startup. So this
 * reads the buffer rather than inspecting sockets: no privileges, no platform-specific
 * netstat parsing, and it cannot report a port belonging to some other process.
 *
 * The FIRST announcement wins. A framework often prints a local URL and then a network
 * one for the same port, and some print a proxy target afterwards; the first line is
 * the one describing the server that just came up.
 */
export function detectPort(output: string): number | undefined {
  const m =
    /(?:https?:\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i.exec(output) ??
    /\b(?:listening|running|started|ready)\b[^\n]*?\bport\b\s*:?\s*(\d{2,5})/i.exec(output);
  if (!m) return undefined;
  const port = Number(m[1]);
  return port >= 1 && port <= 65535 ? port : undefined;
}
