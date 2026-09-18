/**
 * runCommand.ts — run a shell command in the project.
 *
 * This is Mindweave's hands on the system: build, test, git, scaffolding. The design
 * carries a few things that make a shell tool genuinely reliable:
 *
 *  - cwd PERSISTS across calls within a turn without a long-lived shell. We spawn a
 *    fresh shell per command, but the command is wrapped to write its final working
 *    directory to a temp file; we read that back into `ctx.cwd`, so a `cd src` in one
 *    call is still in effect for the next command in the same turn. The engine resets
 *    ctx.cwd to the project root at the start of each turn (see respond()), so a stale
 *    `cd` never carries across turns — the project root is the stable contract.
 *  - output goes to a FILE, handed to the child as both of its streams, not to a pipe
 *    this process has to keep draining. A pipe stops the child dead once its buffer
 *    fills and nothing is reading; a file cannot, so backgrounding is just letting go
 *    of it, memory is flat however much is printed, and the output survives a crash.
 *    See commandOutput.ts.
 *  - whole-tree kill on timeout. Killing the shell alone leaves grandchildren
 *    (node → jest, a dev server) running unattended — so we kill the entire process
 *    tree (`taskkill /T` on Windows, the process group on POSIX).
 *  - wall-clock timeout, 2 min default / 10 min max.
 *  - anti-hang environment: GIT_EDITOR=true and a hidden window stop an
 *    interactive editor or prompt from freezing the turn.
 *
 * The shell is PowerShell on Windows and bash elsewhere, falling back to `sh` only
 * on a machine that has no bash (see posixShell.ts — `/bin/sh` is `dash` on Debian
 * and Ubuntu, where ordinary bash syntax is a hard syntax error). The system prompt
 * names whichever it resolved to, so the model writes commands that will actually
 * run, and the label is computed rather than fixed so it cannot go stale. Deciding
 * WHAT to run is the model's job — this tool only executes it, with one
 * mechanical seatbelt (guard.ts) that refuses a handful of catastrophic,
 * irreversible commands.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolCallChannel, ToolContext, ToolResult } from "./types.js";
import { catastrophicCommandReason, sensitiveCommandReason } from "./guard.js";
import { forbiddenCommandReason, forbiddenCommandPatternReason } from "../governor/forbidden.js";
import { requestForbiddenLift } from "./approval.js";
import { posixShell, shellMismatchNote } from "./posixShell.js";
import { killTree, spawnManaged } from "./killTree.js";
import { captureAfterCommand, looksReadOnly, snapshotBeforeCommand } from "./shellCheckpoint.js";
import { canonicalRoot, relativize } from "./paths.js";
import { SHELL_ROWS_FAILED, SHELL_ROWS_OK, formatDuration, shellOutput, withOutcome } from "./detail.js";
import { parseTestRun, testDetail } from "./testSummary.js";
import { powershellLintReason, powershellParseError, powershellReservedAssignmentReason } from "./shellLint.js";
import { findRunningDuplicate, findRecentUserClose, guessNotifyPolicy, type NotifyPolicy } from "./backgroundShells.js";
import { fail, failQuietly } from "./results.js";
import { defaultOpenRewrite } from "./openDefault.js";
import { composeFileOutput, createOutputFile, removeOutputFile, tailOf } from "./commandOutput.js";
import { stripNativeStderrNoise } from "./nativeStderr.js";

const IS_WINDOWS = process.platform === "win32";

/** Which shell to run in on Windows. Elsewhere everything is POSIX sh and this is
 *  ignored. PowerShell is the default; cmd is opt-in for cmd.exe-syntax commands. */
type Shell = "powershell" | "cmd";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
/**
 * How much command output reaches the model, split across the two ends.
 *
 * Keeping the FIRST 30,000 characters and dropping the rest throws away the part
 * that matters: a build or test run puts its banner and progress at the start and
 * its diagnosis — the failing assertion, the stack, "3 tests failed" — at the very
 * end. A verbose `tsc` or webpack run overflows the budget on progress noise alone,
 * so the model would receive a wall of chatter, a truncation notice, and nothing
 * about why the command failed.
 *
 * Both ends are kept instead, weighted toward the tail. The same total budget.
 */
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 22_000;
/** How long to wait after `exit` for `close` before settling anyway. See the listener
 *  in runShell: a surviving grandchild can hold the output pipe open forever. */
const CLOSE_GRACE_MS = 2_000;

/**
 * Human label for the shell, kept in sync with the system prompt.
 *
 * Reports what will ACTUALLY run, resolved on this machine, rather than a fixed
 * string. It used to say "the POSIX shell (sh)" everywhere off Windows, which became
 * a false claim the moment bash was preferred — and a prompt that asserts something
 * untrue is worse than one that says nothing, because the model believes it and
 * writes to the wrong dialect.
 */
export function commandShellLabel(): string {
  if (IS_WINDOWS) return "Windows PowerShell";
  return posixShell().isBash ? "bash" : "a strict POSIX shell (sh)";
}

export const runCommand: Tool = {
  name: "run_command",
  readOnly: false,
  // Two claims in the previous version of this description were false, and both were
  // the kind a model obeys without being able to check. It promised that a backgrounded
  // command would report when it finished, which is true only for notify:'on_finish'
  // and flatly contradicted by 'on_failure' (the default for anything server-shaped).
  // And it warned that a never-terminating command would "hang the turn", which the
  // soft timeout has made untrue, while scaring the model away from the very feature
  // built for it. What replaced them is what actually happens.
  description:
    `Run a shell command in the project and return its combined output and exit ` +
    `code. The shell is ${commandShellLabel()}. Every turn starts at the project root; ` +
    `the working directory persists between calls WITHIN a turn (so 'cd' carries over ` +
    `mid-turn) but resets to the root next turn. ` +
    `A command still running after 2 minutes (or 'timeout' ms, up to 10 minutes) is ` +
    `MOVED TO THE BACKGROUND, not killed: you get a shell id and the session carries on. ` +
    `Read its output any time with the shells tool. WHAT YOU HEAR AFTERWARDS IS SET BY ` +
    `'notify', so choose it deliberately: only 'on_finish' reports that the command ` +
    `ended, and it is not the default for everything. ` +
    `Pass 'run_in_background: true' to background it from the start, and do that for a ` +
    `dev server, a long build or test you do not need to wait on, and anything ` +
    `interactive or never-terminating. Waiting on one of those inline will not hang the ` +
    `turn, but it burns the whole timeout before backgrounding itself, which is time ` +
    `spent for nothing. ` +
    `Write commands for ${commandShellLabel()} (see the shell section of the system prompt)` +
    `${IS_WINDOWS ? "; or pass shell:'cmd' to run in cmd.exe instead (for && / || chaining or cmd-only tools)" : ""}. ` +
    `Prefer Mindweave's read/edit/search tools over shelling out. ` +
    `To open a file or a URL for the user, hand it to the system and let it choose the ` +
    `app: ${IS_WINDOWS ? `'Start-Process \"<path or url>\"' with NO application named` : "'open' (macOS) or 'xdg-open' (Linux)"}. ` +
    `Never name a browser or a viewer yourself — naming one launches an app the user may ` +
    `not use and does not want opened, instead of the default they have chosen. ` +
    `To LOOK at an image file, use view_image; do not open it in anything.`,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "The shell command to run.",
      },
      shell: {
        type: "string",
        enum: ["powershell", "cmd"],
        description:
          "Windows only (ignored elsewhere): which shell to run in. Default 'powershell'. Choose " +
          "'cmd' for commands written in cmd.exe syntax — && / || chaining, or a tool that misbehaves " +
          "under PowerShell — Mindweave runs them as a batch script. Note: in cmd a for-loop uses %%i, and " +
          "cwd may not carry over when the command itself is a .cmd tool (chain in one call instead).",
      },
      timeout: {
        type: "integer",
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
        description: `How long to wait inline before moving it to the background, in ms (default 120000, max ${MAX_TIMEOUT_MS}).`,
      },
      run_in_background: {
        type: "boolean",
        description: "Start it in the background immediately and return a shell id (don't wait).",
      },
      notify: {
        type: "string",
        enum: ["on_finish", "on_failure", "never"],
        description:
          "What you want to be told about a backgrounded command. 'on_finish' (default for tasks): " +
          "you're told when it ends, whatever the result — use it for builds, tests, installs, " +
          "anything whose RESULT is the point. 'on_failure': you're told when it has come up, and if " +
          "it never does, but NOT when it stops — use it for dev servers and apps, because the user " +
          "closing their own app is not something to act on. 'never': you're told nothing at all. " +
          "Say which; guessing from the command name gets it wrong for anything unusual.",
      },
    },
  },

  async execute(args, ctx, call): Promise<ToolResult> {
    const requested = typeof args.command === "string" ? args.command.trim() : "";
    if (!requested) return failQuietly("`command` is required.");

    // Naming a browser opens an application the user did not choose, beside the one they
    // are already using. Rewritten here rather than asked for in the description, because
    // the description already asked and the next run named Edge anyway — a rule the model
    // has to remember is a rule it drops under load. Automation (a browser with flags) is
    // left alone; see openDefault.ts.
    const redirected = defaultOpenRewrite(requested);
    const command = redirected ? redirected.command : requested;

    // A shell can change files in ways the checkpoint net never sees (a formatter, a
    // codegen step, a `git checkout`). Flag the turn so /undo says what it did NOT
    // cover instead of implying the whole turn was rolled back.
    ctx.checkpoints?.noteShell();

    const blocked = catastrophicCommandReason(command);
    if (blocked) {
      return fail(`Refusing to run this command: it looks like ${blocked}.`);
    }
    // A shell would sidestep every per-file gate the read/write tools enforce.
    const sensitive = sensitiveCommandReason(command);
    if (sensitive) {
      return fail(
        `Refusing to run this command: it would print the contents of ${sensitive} into ` +
          `the conversation. Checking whether the file exists, listing it, or copying it ` +
          `is fine — reading it out is not. If you genuinely need what's inside, use ` +
          `read_file, which asks the user first.`,
      );
    }
    const forbidden = forbiddenCommandReason(ctx.governance?.forbidden, command);
    if (forbidden) {
      const lift = await requestForbiddenLift(
        ctx,
        forbidden,
        "this command",
        `it references '${forbidden}', which the user has forbidden touching.`,
      );
      if (lift) return lift; // refused or deferred; an allow lifts it and falls through
    }
    // Forbidden COMMAND patterns: a command the user said never to run (e.g. `tauri
    // dev`). Deterministic — the model cannot bypass it; only the user can lift it
    // (same approval channel as forbidden paths, session-only).
    const forbiddenCmd = forbiddenCommandPatternReason(ctx.governance?.forbidden, command);
    if (forbiddenCmd) {
      const lift = await requestForbiddenLift(
        ctx,
        forbiddenCmd,
        "this command",
        `the user has forbidden running '${forbiddenCmd}'.`,
        "forbidden command",
      );
      if (lift) return lift;
    }

    let timeout = DEFAULT_TIMEOUT_MS;
    if (typeof args.timeout === "number" && Number.isFinite(args.timeout)) {
      timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(args.timeout)));
    }

    const shell: Shell = args.shell === "cmd" ? "cmd" : "powershell";

    // Already-running guard: don't start a second copy of something already running in
    // the background. Two dev servers collide on a port and the model then burns a long
    // loop fighting the conflict it created; two of anything else is nearly always a
    // mistake too.
    //
    // This deliberately does NOT ask whether the command looks like a server. It used to,
    // which meant the guard only covered the names in one regex: `cargo run`,
    // `docker compose up`, `flask run` and a plain path to a binary were all unprotected.
    // "Is this exact command already running" needs no such guess and covers everything.
    if (ctx.backgroundShells) {
      const dup = findRunningDuplicate(ctx.backgroundShells.running(), command);
      if (dup) {
        return {
          output:
            `\`${clip(command)}\` is already running in the background as shell #${dup.id}, so I'm not ` +
            `starting a second copy — a second one would collide with it. It's already up; if you want a ` +
            `fresh start, call kill_shell(${dup.id}) first, then relaunch.`,
          isError: true,
          summary: `already running as shell #${dup.id}`,
        };
      }

      // Reopen guard: don't relaunch an app the USER just closed. Without this, an agent
      // that reopens a closed window turns into a loop — the user shuts their app, it comes
      // straight back, they shut it again, and so on. The match is scoped to apps that came
      // up and were closed WITHOUT a kill_shell (`findRecentUserClose`), so the agent's own
      // kill-then-relaunch is untouched and a server that failed to start can still be
      // retried. The cooldown lets a restart the user asks for later through.
      const closed = findRecentUserClose(ctx.backgroundShells.list(), command, Date.now());
      if (closed) {
        const secs = closed.finishedAt ? Math.round((Date.now() - closed.finishedAt) / 1000) : 0;
        return {
          output:
            `The user closed \`${clip(command)}\` themselves ${secs}s ago (shell #${closed.id}, after it had come up), ` +
            `so I'm not reopening it. Reopening an app the user just shut turns into a loop where they keep closing ` +
            `it and it keeps coming back. Leave it down. If it genuinely needs to be running, ask the user first and ` +
            `let them decide — don't relaunch it on your own.`,
          isError: true,
          summary: `user closed #${closed.id} ${secs}s ago — not reopening`,
        };
      }
    }

    // Pre-execution gate: don't waste a run on a guaranteed PowerShell parse error
    // (`&&`/`||`) or an assignment to a read-only automatic variable (`$pid = …`). Catch
    // it here and hand back the fix so the model corrects in one step instead of running,
    // failing, and re-reading the error (the wall that spawned a long flailing loop).
    if (IS_WINDOWS && shell === "powershell") {
      const parseError = powershellParseError(command);
      if (parseError) return fail(parseError);
      const reserved = powershellReservedAssignmentReason(command);
      if (reserved) return fail(reserved);
    }

    const declared =
      args.notify === "on_finish" || args.notify === "on_failure" || args.notify === "never"
        ? (args.notify as NotifyPolicy)
        : undefined;

    // Bring shell-caused changes into /undo. Snapshot the read ledger first, run, then
    // check in whatever moved — this is the one mutation path that had no checkpoint at
    // all, which mattered precisely because improvising with a script is a capability we
    // rely on. Skipped for obviously read-only commands, and for background ones, whose
    // writes land long after this call has returned. See shellCheckpoint.ts for the
    // bounds and for what is honestly NOT covered.
    const background = args.run_in_background === true;
    const watch = !background && !looksReadOnly(command);
    const before = watch ? await snapshotBeforeCommand(ctx) : undefined;

    const result = await runShell(command, ctx, timeout, background, shell, declared, call);

    // Told in the OUTPUT, where the model reads it, because it changes what the model may
    // say afterwards: it asked for one browser and a different one opened. Reporting a
    // page as "checked in Edge" when Edge never ran is the failure this closes.
    if (redirected) {
      result.output =
        `${result.output}\n\nNote: that command named ${redirected.browser}, so the page was opened ` +
        `with the user's DEFAULT browser instead. You do not know which browser that is — do not ` +
        `name one when you describe what happened.`;
    }

    if (before && before.size > 0) {
      // Never let bookkeeping fail a command that already ran and succeeded.
      await captureAfterCommand(ctx, before).catch(() => undefined);
    }
    return result;
  },
};

/** How long a command runs before it starts reporting. Almost everything finishes inside
 *  this, and a row that flashed a tail and then settled would be motion for its own sake. */
const PROGRESS_AFTER_MS = 2000;
/** How often the tail is resent while it keeps running. */
const PROGRESS_POLL_MS = 1000;
/** Lines of tail shown while a command is still going. */
const PROGRESS_LINES = 6;
/** How much of the file a progress glance reads. A few lines of any real output fit in
 *  this, and it is a bounded read against a file that may be gigabytes. */
const PROGRESS_TAIL_BYTES = 8_192;

/**
 * The last few lines of what a running command has printed (pure).
 *
 * Trailing blank lines are dropped first: a build that ends its output with a newline
 * would otherwise report a tail of empty rows and look like it had stopped saying
 * anything. Long lines are clipped rather than wrapped, because this is a progress
 * glance and a wrapped 400-column line would push the rest of it off screen.
 */
export function progressTail(output: string, lines = PROGRESS_LINES, width = 200): string {
  const rows = output.split("\n");
  while (rows.length > 0 && rows[rows.length - 1]!.trim() === "") rows.pop();
  return rows
    .slice(-lines)
    .map((r) => (r.length > width ? r.slice(0, width - 1) + "…" : r))
    .join("\n");
}

/**
 * Commands that must never be moved to the background when they run long (pure).
 *
 * A pure delay IS the work. Backgrounding one at the timeout keeps a process alive that
 * exists only to finish and hands back a shell id nobody wants — the wait was the point,
 * and it is now neither waited on nor cancelled. Killing it is the honest outcome.
 *
 * Matched on the first word, after any leading environment assignments, so a wrapped or
 * chained command is judged on what it actually starts with.
 */
export function neverBackground(command: string): boolean {
  const first = command
    .trim()
    .split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (!first) return false;
  const base = first.replace(/^.*[\\/]/, "").toLowerCase();
  return base === "sleep" || base === "start-sleep";
}

async function runShell(
  command: string,
  ctx: ToolContext,
  timeoutMs: number,
  background: boolean,
  shell: Shell,
  declaredNotify?: NotifyPolicy,
  call?: ToolCallChannel,
): Promise<ToolResult> {
  // How long the command took, for the row's outcome. Taken here rather than around the
  // spawn so it covers what the user actually waited through.
  const startedAt = Date.now();
  // A unique temp file the wrapped command writes its final cwd into.
  const cwdFile = join(tmpdir(), `mindweave-cwd-${randomBytes(6).toString("hex")}.txt`);
  // Where we stood before the command ran — applyCwd may move ctx.cwd, and the model
  // needs telling when it does (see cwdChangeNote). CANONICALISED, because that
  // comparison is a string equality and the two sides otherwise come from different
  // places: this one from the session, the other from whatever form the shell prints.
  // On Windows those differ for any user whose name is over eight characters, since
  // one side carries the 8.3 short form, and the session then reports a move on every
  // command that never left the directory.
  const cwdBefore = await canonicalRoot(ctx.cwd);

  const { bin, args, wrapped, tempFile } = buildInvocation(command, cwdFile, shell);

  // The output file, opened BEFORE the spawn so the child can be handed it as both of
  // its output streams. Nothing this process does can then block the command: it writes
  // to a descriptor, not into a pipe somebody has to keep draining.
  const outFile = await createOutputFile();

  const child = spawnManaged(bin, [...args, wrapped], {
    cwd: ctx.cwd,
    // stdin stays a pipe so an interactive prompt sees a closed stream and gives up
    // rather than waiting; stdout and stderr are the SAME descriptor, so the two
    // interleave in the order they were written instead of being reassembled after.
    stdio: ["pipe", outFile.handle.fd, outFile.handle.fd],
    env: {
      ...process.env,
      GIT_EDITOR: "true", // never drop into an interactive editor and hang
      GIT_PAGER: "cat",
      PAGER: "cat",
    },
  });

  // Nobody will ever type into this command, so its input ends now. Left open, a prompt
  // ("Proceed? [y/N]", `npm init`, a credential request) waited on a stream that never
  // closed until the two-minute timeout, and then got moved to the background still
  // waiting. Closed, it sees end-of-input straight away and takes its default or gives up.
  child.stdin?.end();

  // Our copy of the descriptor. The child dup'd it at spawn, so closing here leaves it
  // writing happily and means the file is released the moment the command ends rather
  // than whenever this process happens to exit.
  await outFile.handle.close().catch(() => {});

  const mgr = ctx.backgroundShells;

  // Explicit background: hand off immediately, don't wait for it.
  //
  // The abort listener below is only wired for the FOREGROUND path, so this branch
  // has to check the signal itself. Without it an interrupted turn still adopts the
  // process, and because backgrounding deliberately outlives the turn, Esc would
  // leave a dev server running that the user believed they had cancelled.
  if (background && mgr) {
    if (ctx.abortSignal?.aborted) {
      killTree(child.pid);
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      return {
        output: "Command interrupted before it started.",
        isError: true,
        summary: `interrupted \`${clip(command)}\``,
      };
    }
    // Declared policy wins; the name guess is only the default when nothing was said.
    const notify = declaredNotify ?? guessNotifyPolicy(command);
    // The output file goes with it. The child is already writing there; without the path
    // the manager had nothing to read, so every command started in the background was
    // silent: no output in `shells`, "(no output)" on every note, and a watchdog that
    // could never see the prompt it exists to catch.
    const info = mgr.adopt(child, { command, cwd: ctx.cwd, outputPath: outFile.path, cwdFile, tempFile, notify });
    return backgroundedResult(info.id, command, `Started in the background as shell #${info.id}`, notify);
  }

  return new Promise<ToolResult>((resolve) => {
    let timedOut = false;
    let settled = false;

    // Nothing collects output here any more: the child writes it straight into a file it
    // was given as stdout and stderr, and this process never sees the bytes. See
    // commandOutput.ts for why — a pipe stops the child dead the moment nothing is
    // draining it, and something always eventually is not.
    //
    // The head and the tail are read back from that file once the command ends. Both
    // ends, weighted toward the tail: a build puts its banner at the start and its
    // diagnosis at the very end, so keeping only the first bytes throws away the half
    // that says what happened.
    const collected = () => composeFileOutput(outFile.path, HEAD_CHARS, TAIL_CHARS);

    // ── saying what it is doing while it does it ──────────────────────────────
    //
    // A command that runs for minutes used to show nothing at all until it finished. The
    // row itself was not even on screen (the reveal held it for its own result), so a
    // release build looked exactly like a hung agent — reported as one, and it was not.
    //
    // The LAST few lines, resent whole each time rather than as increments: the receiver
    // replaces what it is showing, so a dropped update costs nothing and neither side
    // keeps state the other has to agree with.
    //
    // Nothing is sent for the first couple of seconds. Almost every command finishes
    // inside that, and a row that flashed a tail and then settled would be motion for its
    // own sake on the calm case that makes up most of them.
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    let lastSent = "";
    const stopProgress = () => {
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = null;
    };
    const startProgress = setTimeout(() => {
      if (settled || !call) return;
      const send = async () => {
        if (settled) return stopProgress();
        const text = progressTail(await tailOf(outFile.path, PROGRESS_TAIL_BYTES));
        // Only when it CHANGED. A quiet command would otherwise repaint the same rows
        // once a second for as long as it ran.
        if (text === lastSent) return;
        lastSent = text;
        call.progress(text);
      };
      send();
      progressTimer = setInterval(send, PROGRESS_POLL_MS);
      progressTimer.unref?.();
    }, PROGRESS_AFTER_MS);
    startProgress.unref?.();

    const timer = setTimeout(() => {
      if (settled) return;
      // Soft timeout: move the LIVE process to the background (preferred), so a long
      // test/build keeps running instead of being lost. With no manager (bare tests)
      // fall back to the old behavior — kill the tree.
      if (mgr && !neverBackground(command)) {
        settled = true;
        clearTimeout(startProgress);
        stopProgress();
        detachAbort();
        // Auto-backgrounded after running too long inline. Somebody was waiting on this,
        // so its completion is the point unless the caller said otherwise.
        const notify = declaredNotify ?? "on_finish";
        // The manager takes over the same file the child is already writing into, so
        // nothing is copied and no output can be lost in the handover.
        const info = mgr.adopt(child, { command, cwd: ctx.cwd, outputPath: outFile.path, cwdFile, tempFile, notify });
        resolve(
          backgroundedResult(
            info.id,
            command,
            `Still running after ${Math.round(timeoutMs / 1000)}s — moved to the background as shell #${info.id}`,
            notify,
          ),
        );
      } else {
        timedOut = true;
        killTree(child.pid);
      }
    }, timeoutMs);

    // Esc / interrupt: if the turn is aborted while this command is still running,
    // kill the whole process tree and settle immediately. Without this a hung command
    // (an installer waiting on a GUI, an interactive prompt) freezes the agent — the
    // engine only re-checks the abort signal BETWEEN steps, never mid-tool-call, so it
    // would stay blocked on this promise forever.
    const signal = ctx.abortSignal;
    const detachAbort = () => signal?.removeEventListener("abort", onAbort);
    async function onAbort() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(startProgress);
      stopProgress();
      killTree(child.pid);
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      // Same rule on the interrupted path, and it matters more here: an interrupted
      // command is the least repeatable kind, so throwing away the part of its output we
      // could not show is the worst time to do it.
      const out = await collected();
      const body = out.text.trim();
      const kept = out.dropped > 0;
      if (!kept) removeOutputFile(outFile.path);
      const where = kept ? `\n\nThe FULL output is at ${outFile.path} — read or search that file for the middle.` : "";
      resolve({
        output: body ? `${body}\n\n[interrupted]${where}` : "Command interrupted before it finished.",
        isError: true,
        summary: `interrupted \`${clip(command)}\``,
      });
    }
    if (signal?.aborted) return void onAbort();
    signal?.addEventListener("abort", onAbort);

    const finish = async (rawExit: number | null, signal: string | null) => {
      // Windows hands a negative exit code back unsigned: `exit -1` arrives as
      // 4294967295, which says nothing to anyone reading it.
      const exitCode = rawExit !== null && rawExit > 0x7fffffff ? rawExit - 0x100000000 : rawExit;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(startProgress);
      stopProgress();
      detachAbort();
      await applyCwd(cwdFile, ctx);
      if (tempFile) await fs.rm(tempFile, { force: true }).catch(() => {});
      const out = await collected();
      // KEPT only when the middle was actually dropped. Everything else is deleted on the
      // spot as before: a command whose output fitted has nothing to go back for, and
      // retaining those would leave a file per command run. A kept file needs no cleanup
      // path of its own — `tempSweep` already collects `mindweave-` by age at startup,
      // which is also what covers a crash that skips this line entirely.
      const kept = out.dropped > 0;
      if (!kept) removeOutputFile(outFile.path);
      resolve(
        format(
          command,
          ctx,
          out.text,
          out.dropped > 0,
          timedOut,
          exitCode,
          signal,
          timeoutMs,
          shell,
          cwdBefore,
          Date.now() - startedAt,
          child.pid,
          kept ? outFile.path : undefined,
        ),
      );
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(startProgress);
      stopProgress();
      detachAbort();
      void fs.rm(cwdFile, { force: true }).catch(() => {});
      if (tempFile) void fs.rm(tempFile, { force: true }).catch(() => {});
      resolve(fail(`could not start the command: ${error.message}`));
    });
    child.on("close", (code, signal) => void finish(code, signal));
    // `close` waits for every stdio stream to close, which a surviving grandchild (a
    // daemon the command started, inheriting stdout) holds open indefinitely. Without a
    // fallback the call sits here until the timeout and only then gets backgrounded, so a
    // command that merely starts something looks like it took two minutes. `exit` fires
    // when the process itself goes; the short grace lets `close` win normally, so no
    // ordinary command pays for this.
    child.on("exit", (code, signal) => {
      const grace = setTimeout(() => void finish(code, signal), CLOSE_GRACE_MS);
      grace.unref?.();
    });
  });
}

/**
 * The result returned when a command is (or becomes) a background shell.
 *
 * The text has to match what will ACTUALLY happen, and that differs by what was
 * started. A finite task notifies on completion, so telling the model to promise a
 * report is correct. A server or app does NOT: its stop is suppressed on purpose,
 * because a user closing their own app is not something to act on. Telling the model
 * it would be notified either way made it promise a report that never came, which is
 * the prompt asserting a capability that does not exist.
 */
function backgroundedResult(id: number, command: string, lead: string, notify: NotifyPolicy): ToolResult {
  const tail =
    notify === "never"
      ? `Nothing further will be reported about it. Say in ONE short line that it's running, then STOP ` +
        `(end your turn). Use shells({id: ${id}}) to inspect it and kill_shell(${id}) to stop it.`
      : notify === "on_failure"
        ? `You WILL be told once it has come up, so you can report that. You will NOT be told when it ` +
          `stops, because the user closing their own app is not an event to act on — so never restart ` +
          `it on your own. Say in ONE short line that it's starting, then STOP (end your turn). Use ` +
          `shells({id: ${id}}) to inspect it and kill_shell(${id}) to stop it.`
        : `You will be notified AUTOMATICALLY the moment it finishes, so do NOT poll it. Say in ONE ` +
          `short line that it started and that you'll report back when it's done, then STOP (end your ` +
          `turn). Only call shells({id: ${id}}) if you have a specific reason to inspect partial ` +
          `output; use kill_shell(${id}) to stop it.`;
  return {
    output: `${lead}. ${tail}`,
    // UI-only, never sent to the model (`tail` above already told IT the real
    // notification policy). A backgrounded command has produced NO output yet, so
    // there is nothing to put on the output rail — which is what this used to do,
    // rendering Mindweave's own note as if the command had printed it. It is a
    // one-line verdict on the call, which is what the ⎿ branch is for, and it now
    // reads the same way a write's "whole file · 19 lines" does.
    summary: `Backgrounded as shell #${id}`,
  };
}

/** Build the shell invocation: which binary, its flags, and the wrapped command. */
function buildInvocation(
  command: string,
  cwdFile: string,
  shell: Shell,
): { bin: string; args: string[]; wrapped: string; tempFile?: string } {
  if (IS_WINDOWS && shell === "cmd") {
    // cmd.exe can't run a multi-line /c string (it executes only the first line), so
    // we materialize a tiny .bat: the command, then capture its exit code and final
    // cwd. Run line-by-line, so `cd` persists and `&&`/`||` chains work natively.
    // ComSpec is the reliable path to cmd.exe (a bare name may not resolve).
    const batFile = join(tmpdir(), `mindweave-run-${randomBytes(6).toString("hex")}.bat`);
    const script =
      `@echo off\r\n` +
      `${command}\r\n` +
      `set __ec=%ERRORLEVEL%\r\n` +
      `cd > "${cwdFile}"\r\n` +
      `exit /b %__ec%`;
    writeFileSync(batFile, script, "utf8");
    return {
      bin: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c"],
      wrapped: batFile,
      tempFile: batFile,
    };
  }
  if (IS_WINDOWS) {
    // After the command, record the final location and decide its exit code.
    //
    // `$?` has to be captured on the very FIRST line after the command, because every
    // statement sets it, including an assignment, which always succeeds.
    //
    // Three signals, because no single one is honest in Windows PowerShell 5.1:
    //   - `$LASTEXITCODE` is set only by native programs. Reset first, so a non-null
    //     value means a program ran during THIS command; a non-zero one is the code.
    //   - `$?` catches cmdlet failures (`Get-Content` on a missing file), which leave
    //     `$LASTEXITCODE` null. It used to be coerced to success.
    //   - But `$?` is also false in two cases where nothing failed: a program that
    //     exits 0 while writing progress to stderr under `2>&1` (cargo, npm and git all
    //     do), and a cmdlet whose error was deliberately silenced with
    //     `-ErrorAction SilentlyContinue`. Both were reported to the model as exit 1,
    //     so a successful build read as a broken one. So when `$?` is false, the
    //     command failed only if an error was recorded that is neither a native
    //     program's stderr line nor raised by a command that asked for silence.
    const wrapped =
      `$global:LASTEXITCODE = $null; $Error.Clear()\n` +
      `${command}\n` +
      `$__ok = $?\n` +
      `$__native = $LASTEXITCODE\n` +
      `if ($null -ne $__native -and $__native -ne 0) { $__ec = $__native }\n` +
      `elseif ($__ok) { $__ec = 0 }\n` +
      `else {\n` +
      `  $__quiet = @('SilentlyContinue', 'Ignore') -contains [string]$ErrorActionPreference\n` +
      `  $__loud = @($Error | Where-Object {\n` +
      `    if ($_ -isnot [System.Management.Automation.ErrorRecord]) { return $false }\n` +
      `    if ($_.FullyQualifiedErrorId -like 'NativeCommandError*') { return $false }\n` +
      `    $__inv = $_.InvocationInfo\n` +
      `    if ($__inv -and $__inv.Line -and $__inv.OffsetInLine -gt 0) {\n` +
      `      $__stmt = ($__inv.Line.Substring($__inv.OffsetInLine - 1) -split '[|;]')[0]\n` +
      `      if ($__stmt -match '(?i)-(ErrorAction|EA)(\\s*:\\s*|\\s+)[''"]?(SilentlyContinue|Ignore|0)\\b') { return $false }\n` +
      `    }\n` +
      `    -not $__quiet\n` +
      `  })\n` +
      `  $__ec = if ($__loud.Count -gt 0) { 1 } else { 0 }\n` +
      `}\n` +
      `$PWD.Path | Out-File -FilePath ${psQuote(cwdFile)} -Encoding utf8\n` +
      `exit $__ec`;
    return {
      bin: "powershell.exe",
      // -ExecutionPolicy Bypass (process-scoped only) so the model can actually run
      // npm/npx/tsc/jest — their Windows shims are .ps1 scripts, which a Restricted
      // execution policy blocks ("npm.ps1 cannot be loaded because running scripts is
      // disabled"). Without this the verify/test/build story silently can't run.
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
      wrapped,
    };
  }
  // Prefer bash. `/bin/sh` is `dash` on Debian/Ubuntu, where ordinary bash syntax a
  // model writes — `[[ ]]`, `source`, arrays — is a hard syntax error. See posixShell.
  //
  // `pwd -P` reports the PHYSICAL path, with symlinks resolved. That is deliberate and
  // it is why `canonicalRoot` exists: macOS puts /tmp and the whole of os.tmpdir()
  // behind symlinks (/tmp → /private/tmp), so a logical path and a physical one for the
  // same directory differ constantly. Recording the physical form on both sides is what
  // keeps them comparable; recording one of each is what silently moved a session off
  // its own root.
  const wrapped =
    `${command}\n` +
    `__ec=$?\n` +
    `pwd -P > ${shQuote(cwdFile)} 2>/dev/null\n` +
    `exit $__ec`;
  return { bin: posixShell().bin, args: ["-c"], wrapped };
}

/**
 * The line appended to a command's output when it moved the shell (pure).
 *
 * `cd` persisting across calls within a turn is a real convenience, but it is also
 * invisible: the model composes the next command's relative paths from the project
 * root, because nothing ever told it the floor moved. That produces a doubled path
 * (`code-blue/backend/code-blue/backend/manage.py`), which fails, and looks to the
 * model like the file is missing rather than like it is standing somewhere else.
 *
 * So we say it, once, exactly when it happens. `shown` is the new location relative
 * to the project root — the same form paths are addressed in everywhere else.
 * Returns null when the command did not move, which is nearly every command, so
 * ordinary output is untouched.
 */
export function cwdChangeNote(before: string, after: string, shown: string): string | null {
  if (before === after) return null;
  const where = shown === "." ? "the project root" : shown;
  return (
    `[Working directory is now ${where}. It stays there for the rest of this turn, so ` +
    `relative paths in your next command resolve from ${where}, not from the project root. ` +
    `Your next turn starts back at the project root.]`
  );
}

/** Read the cwd the command ended in and adopt it (if it still exists). */
async function applyCwd(cwdFile: string, ctx: ToolContext): Promise<void> {
  try {
    const text = (await fs.readFile(cwdFile, "utf8")).trim();
    if (text) {
      // Confirm it's a real directory before adopting — a half-written file or a
      // deleted dir must not strand the session somewhere invalid.
      const stat = await fs.stat(text);
      // Canonicalise on the way in, so the session only ever holds ONE form of a
      // path. The shell prints whatever form it was handed; adopting that verbatim is
      // how a session ends up describing one directory two ways.
      if (stat.isDirectory()) ctx.cwd = await canonicalRoot(text);
    }
  } catch {
    // No file / unreadable → command didn't change dir (or failed early); keep cwd.
  } finally {
    await fs.rm(cwdFile, { force: true }).catch(() => {});
  }
}

function format(
  command: string,
  ctx: ToolContext,
  output: string,
  truncated: boolean,
  timedOut: boolean,
  exitCode: number | null,
  signal: string | null,
  timeoutMs: number,
  shell: Shell,
  cwdBefore: string,
  /** Wall-clock milliseconds the command ran for. */
  elapsedMs: number,
  /** The killed process, named only when something WAS killed (see withOutcome). */
  pid?: number,
  /** Where the whole output still is, when it was too long to show and the file was
   *  therefore kept. Absent when nothing was dropped — there is nothing to go back for. */
  keptPath?: string,
): ToolResult {
  // A program's stderr under `2>&1` comes back from Windows PowerShell dressed as an error
  // record. Reduced to the line the program printed, or a successful build reads as failed.
  const body = (shell === "powershell" ? stripNativeStderrNoise(output) : output).trim();
  const parts: string[] = [];

  if (timedOut) {
    parts.push(
      `Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. ` +
        `If it was a long-running or watching process, run a form that terminates.`,
    );
  } else if (signal) {
    // A process ended by a signal reports no exit code at all. Treating that as "not
    // non-zero" made a killed command read as a success, and the summary said
    // "exit null" — so a command someone stopped looked like a command that worked.
    parts.push(`Command was terminated by ${signal} before it finished.`);
  } else if (exitCode !== 0 && exitCode !== null) {
    parts.push(`Command exited with code ${exitCode}.`);
  }

  if (body) {
    parts.push(body);
    // The gap is already marked inline, at the point it happened; this only names
    // the shape of what arrived so the model doesn't read the two halves as one run.
    //
    // NAMING THE FILE is what turns a truncation into a bounded read. The whole output
    // was already written to disk to be composed from — it used to be deleted the moment
    // the head and tail had been cut, so the middle of a long build or test log was gone
    // for good and the only recourse was running the command again. Kept and named, the
    // middle is an ordinary `grep`/`read_file` away, which is cheaper than a re-run and
    // possible at all for a command that is not repeatable.
    if (truncated) {
      parts.push(
        keptPath
          ? `(long output: the start and the end are shown. The FULL output is at ${keptPath} — read or search that file for the middle rather than running this again.)`
          : "(long output: the start and the end are shown, the middle was dropped)",
      );
    }
  } else if (!timedOut) {
    parts.push("(no output)");
  }

  // In PowerShell, nudge the model when it wrote a bash-ism that breaks there
  // (advisory only — never blocks; the linter is conservative). Not for cmd, which
  // supports && / || natively.
  if (IS_WINDOWS && shell === "powershell") {
    const lint = powershellLintReason(command);
    if (lint) parts.push(lint);
  }
  // The POSIX mirror of the same idea. Silent on any machine that has bash (nearly
  // all of them), because there the mismatch cannot arise — it only speaks up on a
  // minimal box where the command genuinely could not have parsed, and then it names
  // the construct rather than leaving a bare `dash: syntax error` to be decoded.
  if (!IS_WINDOWS) {
    const mismatch = shellMismatchNote(command);
    if (mismatch) parts.push(mismatch);
  }

  const shown = relativize(ctx, ctx.cwd);
  // Did this command move the shell? If so the model must hear it here, in the tool
  // OUTPUT — the summary line below is display-only and never reaches the model.
  const moved = cwdChangeNote(cwdBefore, ctx.cwd, shown);
  if (moved) parts.push(moved);
  const status = timedOut ? "timed out" : signal ? `killed (${signal})` : exitCode === 0 ? "ok" : `exit ${exitCode}`;
  const failed = timedOut || signal !== null || (exitCode !== 0 && exitCode !== null);
  // Only for a command that RAN to a conclusion. A run killed on a timeout has whatever
  // its runner had printed by then, and summarising a partial log as a result would put a
  // confident set of numbers under a command nobody let finish.
  const testRun = timedOut || signal !== null ? undefined : parseTestRun(body);
  return {
    output: parts.join("\n"),
    isError: failed,
    summary: `ran \`${clip(command)}\` in ${shown} (${status})`,
    // The outcome is appended to what is SHOWN, not just to what the model reads. A
    // command that printed output previously ended its row with the last line of that
    // output and nothing else, so a build that failed and a build that passed looked
    // identical unless you recognised the text — the exit code was known here and
    // simply never displayed.
    // The command leads its own block on its own row. Inline in the header it was
    // clipped to 48 characters, which for a real command line lost the half that said
    // what it actually did (`Run(mkdir -p ..\astra-backup; Move-Item .\astra.htm…)`).
    // A recognised test run is shown as a RESULT rather than as output: its own counts
    // and the first few failures, in place of the thousands of lines it printed to say
    // that nothing was wrong. Anything not recognised falls through to the ordinary
    // block, whole — see testSummary.ts for why that direction is the safe one.
    detail: testRun
      ? testDetail(testRun, formatDuration)
      : withOutcome(shellBody(command, body, failed), timedOut, exitCode, signal, timeoutMs, elapsedMs, pid),
    detailKind: "shell" as const,
  };
}

/**
 * The `$ command` header row above a command's captured output.
 *
 * How many rows of output follow depends on whether the command WORKED. A run that
 * succeeded needs to show that it finished and what it ended up saying; a run that failed
 * is the only one anyone reads, and gets a larger, still fixed, budget. Both are capped
 * from the end — see `shellOutput`.
 */
function shellBody(command: string, body: string, failed: boolean): string {
  const out = shellOutput(body, failed ? SHELL_ROWS_FAILED : SHELL_ROWS_OK);
  return out ? `$ ${command}\n${out}` : `$ ${command}`;
}

/** Single-quote a string for a POSIX shell. */
function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/** Single-quote a string for PowerShell (double any embedded single quotes). */
function psQuote(s: string): string {
  return `'${s.split("'").join("''")}'`;
}

function clip(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

