/**
 * shellTools.ts — the model's handle on background shells.
 *
 * run_command moves a long job to the background and returns a shell id; these read
 * its output, stop it, or list what's running. Reads are INCREMENTAL (only new
 * output since last time) — so polling a chatty process doesn't re-spend the whole
 * log each turn.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { relativize } from "./paths.js";
import { MAX_READ_CHARS, type ShellInfo } from "./backgroundShells.js";
import { fail, failQuietly } from "./results.js";
import { COMMAND_OUTPUT_NOTE, commandReachesOutside } from "./untrusted.js";

/**
 * One read-only tool at two levels of specificity: no `id` lists, an `id` reads.
 *
 * These were `list_shells` and `shell_output`. Same manager, same questions ("what is
 * running" then "what did that one say"), and reading was almost always the direct
 * follow-up to listing — so the split cost two advertised schemas and gave the model a
 * routing decision it did not need.
 *
 * `kill_shell` deliberately stays a separate tool. It is the only mutating one of the
 * three, and the plan-mode filter runs on `tool.readOnly` while BUILDING the advertised
 * list — before any arguments exist. Folding a kill into this tool would therefore force
 * a choice between hiding shell inspection from Architect mode and read-only sub-agents,
 * or offering them a way to kill processes. Neither is acceptable, so the merge stops
 * exactly where the read/write line is.
 */
export const shellsTool: Tool = {
  name: "shells",
  readOnly: true,
  // Always advertised. The tool list is the first thing a provider hashes for its prompt cache,
  // so a tool that appears when the first background shell starts re-bills the system prompt
  // and the whole conversation at full price at that moment. Recorded sessions lost 35k
  // tokens per occurrence on average, and about half of them start a background command.
  // This tool and `kill_shell` weigh roughly 600 tokens, read from the cache after the first
  // request, which costs far less than one rebuild.
  // The description never mentioned polling, while the tool itself pushes a strong
  // don't-poll nudge at runtime; the two now agree. It also never mentioned either cap,
  // and the buffer one matters: a chatty process can roll output out of the retained
  // log between reads, so "everything since last time" is not always literally true.
  description:
    "Look at the background shells run_command has started.\n" +
    "With no `id` it LISTS them, running and recently finished. Each line answers the " +
    "two questions worth asking about a background process: IS IT UP, distinguishing a " +
    "server still starting from one that has come up, and WHY DID IT STOP, " +
    "distinguishing a crash from the user closing it themselves from you stopping it. " +
    "Check this before restarting anything: a process the user shut down should not be " +
    "reopened, and an exit code alone cannot tell you which case you are in.\n" +
    "With an `id` it READS that shell's new output — only what has been printed since " +
    "your last check, plus whether it is still running or has finished and with what " +
    "exit code. " +
    "You normally do NOT need to call this on a loop: whether you are told about the " +
    "shell is set by run_command's 'notify', and when you will be told, you are told " +
    "automatically. Use this when you want the output itself, not to find out whether " +
    "something has happened. " +
    `A single read returns at most ${MAX_READ_CHARS.toLocaleString("en-US")} characters and says when it ` +
    "has dropped earlier lines to fit. Separately, a very chatty process can overflow " +
    "the retained log, in which case the oldest output is gone for good and the status " +
    "line says so.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "integer",
        description: "A background shell id to read (e.g. 1). Omit entirely to list the shells instead.",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const mgr = ctx.backgroundShells;
    if (!mgr) return { output: "No background shells are available in this context.", summary: "no background shells" };
    // The dispatch: naming a shell reads it, otherwise list what there is.
    if (args.id === undefined || args.id === null) return listAll(ctx);
    const id = toId(args.id);
    if (id === null) return failQuietly("`id` must be a shell number.");

    const res = await mgr.read(id);
    if (!res) return fail(`no background shell #${id}.`);
    const head = statusLine(res.info);
    const body = res.chunk.trim();
    // If it's still running, stop the model polling: the event is pushed to it, so a
    // poll loop is pure waste and reads as spam. But the nudge has to promise the
    // RIGHT event. A server is never told about its own stop, so telling the model it
    // would hear "when it finishes" is a promise the tool does not keep — the same
    // false claim that once had it announcing a report that never arrived.
    const nudge =
      res.info.status !== "running"
        ? ""
        : res.info.notify === "on_failure"
          ? "\n[Still starting. You'll be told automatically once it has come up, and you will NOT be " +
            "told when it later stops — do NOT poll again. End your turn.]"
          : res.info.notify === "never"
            ? "\n[Still running. Nothing about this will be reported to you — do NOT poll again. End your turn.]"
            : "\n[Still running. You'll be notified automatically when it finishes — do NOT poll again. " +
              "End your turn and let the user know you'll report when it's done.]";
    return {
      output:
        (body ? `${head}\n${body}${commandReachesOutside(res.info.command) ? `\n${COMMAND_OUTPUT_NOTE}` : ""}` : `${head}\n(no new output)`) +
        nudge,
      summary: `shell #${id} (${res.info.status})`,
    };
  },
};

export const killShell: Tool = {
  name: "kill_shell",
  readOnly: false,
  // Always advertised, for the same reason as `shells`.
  description:
    "Stop a running background shell by id. Kills the whole process tree, not just the " +
    "shell, so a dev server that spawned its own children goes down with it. " +
    "It records that YOU stopped it, which is what later lets the status be reported as " +
    "stopped deliberately rather than guessed at as a crash. " +
    "Stopping something already finished is not an error: you get told it was not " +
    "running, and nothing else happens.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "integer", description: "The background shell id to stop." },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const mgr = ctx.backgroundShells;
    if (!mgr) return fail("no background shells are available in this context.");
    const id = toId(args.id);
    if (id === null) return failQuietly("`id` must be a shell number.");
    const killed = mgr.kill(id);
    return killed
      ? { output: `Stopped background shell #${id}.`, summary: `killed shell #${id}` }
      : { output: `Background shell #${id} wasn't running (already finished, or no such id).`, summary: `shell #${id} not running` };
  },
};

/** The no-`id` half of `shells`: what is running, and why anything stopped. */
function listAll(ctx: ToolContext): ToolResult {
  const mgr = ctx.backgroundShells;
  const shells = mgr?.list() ?? [];
  if (shells.length === 0) return { output: "No background shells.", summary: "no background shells" };
  const running = mgr!.runningCount();
  // The same anti-poll discipline the read path (by `id`) enforces, but for the list. The
  // events worth waking for — a task finishing, a server coming up, a server failing to come
  // up — are PUSHED automatically, so re-listing on a loop is pure waste; and a server's
  // normal stop is never reported, so waiting for one to "finish" waits forever. Without
  // this a model that checks "what's running" repeatedly is told neither, and loops. Only
  // attached while something is running: a finished list is a fact to read, not a poll.
  const nudge =
    running > 0
      ? `\n[${running} still running. You are told automatically when there is something to act on — a ` +
        "task finishing, a server coming up, or a failure to come up. A server's normal stop is NOT " +
        'reported, so never wait for one to "finish." Do NOT list this on a loop — end your turn.]'
      : "";
  return {
    output: shells.map((s) => statusLine(s, ctx)).join("\n") + nudge,
    summary: `${running} running, ${shells.length} total`,
  };
}

/**
 * One line describing a shell, including the facts that decide whether anything needs
 * doing about it.
 *
 * `stoppedBy` and `ready` are recorded precisely so the model can answer "is my app
 * up" and "why did it stop" without guessing, so they have to be rendered here — this
 * is the only place it can go looking. Without them every ending reads as `exited 1`,
 * which is the same thing a crash and a user closing a window both produce.
 */
function statusLine(info: ShellInfo, ctx?: ToolContext): string {
  const where = ctx ? ` in ${relativize(ctx, info.cwd)}` : "";
  // A rolled buffer means output is permanently gone. It was recorded and never shown,
  // so an incomplete log looked exactly like a complete one.
  const rolled = info.truncated ? " [earlier output dropped: this log is incomplete]" : "";
  if (info.status === "running") {
    const secs = Math.round((Date.now() - info.startedAt) / 1000);
    const state = info.notify === "on_failure" ? (info.ready ? "up" : "starting") : "running";
    // A running shell the watchdog has flagged as stuck says so here too, so a manual
    // read agrees with the notification the model was pushed.
    const stall =
      info.stallReason === "prompt"
        ? " [looks blocked on an interactive prompt]"
        : info.stallReason === "silent"
          ? " [no output for a long time — may be stuck]"
          : "";
    return `#${info.id} ${state} (${secs}s)${where}: ${info.command}${rolled}${stall}`;
  }
  const verb =
    info.stoppedBy === "user"
      ? "stopped by the user"
      : info.stoppedBy === "agent"
        ? "stopped by you"
        : info.status === "killed"
          ? "killed"
          : // A signalled process reports no exit code, so reading the number gives
            // "exited null" — which is how a stopped app used to describe itself.
            info.signal
            ? `stopped (${info.signal})`
            : `exited ${info.exitCode}`;
  // Whether it ever came up is what separates "the user closed their app" from "it
  // never started", which the exit code alone cannot tell you.
  const cameUp = info.notify === "on_failure" && !info.stoppedBy ? (info.ready ? ", after it had come up" : ", never came up") : "";
  return `#${info.id} ${verb}${cameUp}${where}: ${info.command}${rolled}`;
}

function toId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

