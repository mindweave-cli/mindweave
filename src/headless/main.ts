/**
 * main.ts (headless) — the real process around `runHeadless`.
 *
 * The only file that touches stdin, signals and the exit code. Loaded by index.ts for `-p`
 * INSTEAD of the terminal program, so React, Ink and the framebuffer are never loaded: a script
 * starts faster and cannot be broken by a missing terminal.
 */
import { loadConfig } from "../cli/bootstrap.js";
import { parseHeadlessArgs } from "./args.js";
import { EXIT_USAGE, EXIT_SIGINT, EXIT_SIGTERM } from "./output.js";
import { MAX_STDIN_BYTES, runHeadless } from "./run.js";

/** How long to wait for the first byte of piped input when the task itself was typed as an argument. */
export const STDIN_GRACE_MS = 1500;

export interface PipedInput {
  text: string | null;
  tooBig: boolean;
}

/**
 * What was piped in, if anything.
 *
 * With a typed task, stdin is optional context, and a CI runner or a parent process can leave stdin
 * open with nothing ever written to it. Waiting for an end that never comes would hang a job forever, so
 * the first byte gets a short grace period; once input starts it is read to the end however long that
 * takes (`git diff` on a big repo is slow). With no typed task, stdin IS the task and is waited for.
 */
export async function readPipedInput(stdin: NodeJS.ReadableStream & { isTTY?: boolean }, hasTypedTask: boolean, graceMs = STDIN_GRACE_MS): Promise<PipedInput> {
  // A terminal is not input. Anything else (a pipe, a file, /dev/null, NUL) is read: asking the OS what kind of
  // stream it is gave a different answer for a Windows pipe than for a POSIX one, and missed real input.
  if (stdin.isTTY) return { text: null, tooBig: false };
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (tooBig: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
      stdin.removeAllListeners("error");
      (stdin as NodeJS.ReadStream).pause?.();
      resolve({ text: size > 0 ? Buffer.concat(chunks).toString("utf8") : null, tooBig });
    };
    stdin.on("data", (chunk: Buffer | string) => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_STDIN_BYTES) return done(true);
      chunks.push(buf);
    });
    stdin.on("end", () => done(false));
    stdin.on("error", () => done(false));
    if (hasTypedTask) timer = setTimeout(() => done(false), graceMs);
  });
}

export async function runHeadlessMain(argv: string[]): Promise<number> {
  const parsed = parseHeadlessArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`mindweave: ${parsed.error}\nRun mindweave --help for the options.\n`);
    return EXIT_USAGE;
  }
  // Keys from ~/.mindweave/.env and the project's .env, as in an interactive start.
  loadConfig();

  const input = await readPipedInput(process.stdin, Boolean(parsed.options.prompt?.trim()));

  // One signal stops the turn cleanly (the session is saved, background commands are stopped); a second one means
  // the caller is out of patience, and the process goes at once.
  const abort = new AbortController();
  let fired: "SIGINT" | "SIGTERM" | null = null;
  const on = (name: "SIGINT" | "SIGTERM") => () => {
    if (fired) process.exit(name === "SIGTERM" ? EXIT_SIGTERM : EXIT_SIGINT);
    fired = name;
    abort.abort();
  };
  process.on("SIGINT", on("SIGINT"));
  process.on("SIGTERM", on("SIGTERM"));

  const code = await runHeadless(
    parsed.options,
    { stdout: process.stdout, stderr: process.stderr, stdin: input.text, stdinTooBig: input.tooBig },
    { cwd: process.cwd(), signal: abort.signal, firedSignal: () => fired },
  );
  // A pipe can still hold unwritten bytes when the process exits, which cuts a long answer short.
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((r) => s.write("", () => r()))));
  return code;
}
