/**
 * Mindweave — the program. Started by index.ts, which prepares the process first.
 *
 * This file does one thing: start the terminal UI. It deliberately stays tiny.
 * All real logic lives in its own lane (cli / dynamo / tools / memory / alternator)
 * so the project stays easy to understand as it grows.
 *
 * The shebang above + the `bin` entry in package.json make this the `mindweave`
 * command: install once (`npm link` / `npm i -g`), then `cd` into any project and
 * type `mindweave`. The session roots at the current directory (process.cwd()), so it
 * just works wherever you run it.
 */
import { render } from "ink";
import { createElement } from "react";
import { App } from "./cli/App.js";
import { loadConfig } from "./cli/bootstrap.js";
import { sweepTempInBackground } from "./tools/tempSweep.js";
import { parseStartupArgs, hasInteractiveInput, NO_TERMINAL_MESSAGE } from "./cli/startupArgs.js";
import { enterAltScreen, exitAltScreen } from "./cli/altScreen.js";
import { TERMINAL_RESTORE } from "./cli/terminalRestore.js";
import { instrumentStdout, flush as flushPerf, perf, perfEnabled } from "./cli/perfLog.js";
import { MAX_FPS } from "./cli/frameRate.js";
import { framebufferStdout, setFramebufferEnabled } from "./cli/framebuffer/writer.js";
import { startupMode } from "./cli/screenMode.js";
import { loadScreenMode } from "./cli/screenStore.js";
import { silenceConsole } from "./cli/quietConsole.js";
import { nameSession } from "./cli/appIdentity.js";
import { tuneMemory } from "./cli/memoryTuning.js";
import { spawn } from "node:child_process";
import { relaunch } from "./cli/restart.js";
import { takePendingRestart } from "./cli/updateRunner.js";

// --help / --version answer and exit, BEFORE anything reads config, sweeps a
// directory, or starts the UI. They used to fall through to the interactive app,
// which then hung forever with no TTY to render into — the one thing a packaging
// tool or a script does with a new CLI.
const startup = parseStartupArgs(process.argv.slice(2));
if (startup.kind === "print") {
  process.stdout.write(startup.text + "\n");
  process.exit(0);
}

// Nothing below this point can run without a terminal to read from, and the failure
// without one is a stack trace through React internals on a process that exits 0.
// --help, --version and --reset-terminal are answered above, so they still work
// wherever they are called from.
if (!hasInteractiveInput(process.stdin)) {
  process.stderr.write(NO_TERMINAL_MESSAGE);
  process.exit(1);
}
if (startup.kind === "reset") {
  // Repairing a terminal a dead run left in mouse-reporting mode. Nothing else may run
  // first: this is typed when the terminal is already misbehaving, and loading config or
  // sweeping temp would only add ways for it to fail before it writes the one thing it
  // came to write. Escapes go out only to a real terminal, since into a pipe they would
  // be corruption rather than repair.
  if (process.stdout.isTTY) {
    process.stdout.write(TERMINAL_RESTORE);
    process.stdout.write("terminal restored\n");
  } else {
    process.stdout.write("not a terminal, nothing to restore\n");
  }
  process.exit(0);
}

// Bias V8 toward a smaller footprint before anything heavy allocates. See memoryTuning.ts.
tuneMemory();

// Load config (global ~/.mindweave/.env + project .env) so provider API keys are
// available no matter which project we're launched in.
loadConfig();

// Clear out the temp files and directories earlier runs left behind: screenshots past
// their retention window, and the scratch (cwd hand-off files, command wrappers, test
// fixtures) that every call site removes on its way out and nothing removes when a run
// ends badly. Startup rather than shutdown precisely because that catches what a crash
// left behind, and detached so a slow or unreadable temp directory cannot delay the UI.
sweepTempInBackground();

// Times every frame the renderer writes to the real terminal. No-op unless
// MINDWEAVE_PERF names a file — see cli/perfLog.ts for why this cannot be measured
// from a test probe.
instrumentStdout(process.stdout);
process.on("exit", flushPerf);

// The shell the session starts in decides whether we take the screen at all. Applied
// HERE rather than being left to the app to correct on its first effect: entering and
// then immediately leaving is a visible flash of an empty alternate screen, and one
// frame of Ink output diffed by a framebuffer that is about to stand down.
// The saved choice is read here, not in the app, because the same answer decides whether
// to take the alternate screen at all — which happens before the first render.
const startupShell = startupMode(process.env["MINDWEAVE_SCREEN"], await loadScreenMode(process.cwd()));
// Name the session in the terminal tab and the process list, before the screen is taken
// (the title is a plain control write; doing it first keeps it out of the framebuffer's
// frame parsing). See appIdentity.ts.
nameSession();
enterAltScreen({ buffer: startupShell === "fullscreen" });
setFramebufferEnabled(startupShell === "fullscreen");

// Ink renders into a FRAMEBUFFER rather than straight to the terminal: each frame is
// parsed into a cell grid, diffed against what is already on screen, and only the
// cells that actually differ are written. Measured on a transcript-shaped screen,
// that is ~13x fewer bytes per frame (2,345 -> 178). See `cli/framebuffer/`.
//
// `incrementalRendering` is deliberately NOT enabled alongside it, and this is load
// bearing rather than a preference: that mode makes Ink emit only the LINES it thinks
// changed, interleaved with its own cursor movements, instead of a complete frame.
// The framebuffer's parser expects a whole frame — a partial one would be read as a
// full screen and everything it omitted would be blanked. One diff or the other, and
// ours is per-cell where Ink's is per-line.
// The frame-rate cap is what sets typing latency — see `cli/frameRate.ts` for the
// measurements and for why it is a timer rather than a cost.
// Nothing but the renderer may write to the screen while the UI owns it.
const restoreConsole = silenceConsole();
const instance = render(createElement(App, { resumeSessionId: startup.resumeSessionId, initialScreen: startupShell }), {
  maxFps: MAX_FPS,
  // Ink decides it is not talking to a person whenever CI is set in the environment, and then
  // draws nothing until exit: a developer with CI=1 in their shell profile got a blank screen.
  // This process has already checked that stdin is a real terminal (hasInteractiveInput above),
  // which is the only thing that question should be asking.
  interactive: true,
  // Ctrl+C is handled by the app, not by Ink.
  //
  // Raw mode is on, so Ctrl+C arrives as a BYTE rather than as SIGINT — none of the
  // signal handlers in altScreen.ts ever see it. Ink's default was then to unmount and
  // nothing else: painting stopped, the process stayed alive with the turn still running,
  // and because nothing exited, neither the terminal restore nor the synchronous kill of
  // background shells (both `exit` hooks) ever ran. What that left on screen was a window
  // that was no longer the app and not yet the shell, over work that was still going.
  exitOnCtrlC: false,
  // Console output is NOT a frame, and must not be routed into the stream of them.
  //
  // Ink offers to capture it and write it above the UI. Through the framebuffer that
  // means the parser reads a log line as a frame and stamps foreign text into the model
  // of the screen — and a cell the model has wrong is never revisited, because as far as
  // a diff can see nothing about it changed. See `cli/quietConsole.ts`, which stops the
  // output at the source instead.
  patchConsole: false,
  stdout: framebufferStdout(process.stdout, perfEnabled() ? (s) => perf(`frame in=${s.inBytes} out=${s.outBytes}`) : undefined) as unknown as NodeJS.WriteStream,
});

// `/update` cannot hand the terminal over from inside the UI: the handover has to happen
// after Ink has unmounted, and unmounting is what ends the render. So the command records
// what it wants and the app closes the way it always closes; this is where the intention
// is read, with the screen already given back.
await instance.waitUntilExit();
restoreConsole();
const restart = takePendingRestart();
if (restart) {
  process.exit(
    await relaunch(restart.packageRoot, restart.sessionId, restart.previousVersion, restart.prefix, {
      // The order here is the whole risk. Both processes can write to this terminal and
      // both can want raw mode, so the old one is completely out — alternate screen left,
      // mouse reporting off, cursor and autowrap restored, stdin no longer raw — before
      // the new one is allowed to start. `exitAltScreen` is idempotent, so the exit hook
      // that also calls it later changes nothing.
      teardown: () => {
        exitAltScreen();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
      },
      spawn: (command, args) =>
        new Promise((resolve) => {
          const child = spawn(command, args, { stdio: "inherit" });
          child.on("error", () => resolve({ code: 1, signal: null }));
          child.on("close", (code, signal) => resolve({ code, signal }));
        }),
      report: (text) => process.stdout.write(text + "\n"),
    }),
  );
}
