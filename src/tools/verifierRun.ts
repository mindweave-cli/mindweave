/**
 * verifierRun.ts — running a verifier so that its verdict can be believed.
 *
 * A verifier's report is its own account of what it did. Two things can be checked against the
 * run itself instead of taken from the account:
 *
 *   - Which commands it really made. The report cites `$ <command>` lines as its checks; a line
 *     whose command was never run (a file read written up as if it were a command) is not a check.
 *   - Whether the project's files are the same afterwards. It has a command tool, so "I cannot
 *     modify anything" is a request, and a verifier that changes the code can make it pass.
 *
 * Both the `spawn_subagent verify` tool and Marathon's own check of a goal run a verifier, and both
 * go through here, so there is one way a verdict is earned.
 */
import type { EngineEvent } from "../dynamo/engine.js";
import type { BackgroundShells } from "./backgroundShells.js";
import type { Checkpoints } from "./checkpoints.js";
import { changeCount, giveToUndo, listChanges, snapshotTree, treeChanges } from "./treeGuard.js";
import { parseVerdict, type VerdictReport } from "./verifyReport.js";

/**
 * What a call was, in the words a report would cite it by, or undefined when it is not a command
 * or a look at the app (a file read is a look at a file, and cannot back a check).
 */
export function describeRun(name: string, args: Record<string, unknown>): string | undefined {
  if (name === "run_command") {
    const c = typeof args.command === "string" ? args.command.trim() : "";
    return c || undefined;
  }
  if (name === "ui") {
    if (Array.isArray(args.steps) && args.steps.length > 0) {
      return `ui ${args.steps.map((s) => (s && typeof s === "object" && typeof (s as { action?: unknown }).action === "string" ? (s as { action: string }).action : "step")).join(" ")}`;
    }
    const bits = [args.action, args.name, args.target, args.text, args.key, args.url, args.port].filter((x) => typeof x === "string" || typeof x === "number");
    return `ui ${bits.length > 0 ? bits.join(" ") : "look"}`;
  }
  return undefined;
}

/** A call that was turned away rather than run: no command was made, so none can back a check. */
function turnedAway(summary: string): boolean {
  return /^(blocked|declined|refused|interrupted|not run)/i.test(summary.trim());
}

/** Watches a worker's events and remembers each command it really ran. */
export function watchRuns(): { onEvent: (e: EngineEvent) => void; ran: () => string[] } {
  const started = new Map<string, string>();
  const ran: string[] = [];
  return {
    onEvent(e) {
      if (e.type !== "tool") return;
      if (e.phase === "start") {
        const what = describeRun(e.name, e.args);
        if (what) started.set(e.id, what);
      } else if (e.phase === "end") {
        const what = started.get(e.id);
        started.delete(e.id);
        if (what && !(e.error && turnedAway(e.summary))) ran.push(what);
      }
    },
    ran: () => [...ran],
  };
}

/**
 * Stop the background shells that were not there before the verifier began and are still running: the app
 * or server it started to test. Its own, not the session's: a shell the session had running is left alone,
 * and the verifier has no tool to stop one either.
 */
export function stopStartedBy(shells: BackgroundShells | undefined, known: ReadonlySet<number>): number {
  if (!shells) return 0;
  let stopped = 0;
  for (const s of shells.list()) {
    if (known.has(s.id) || s.status !== "running") continue;
    if (shells.kill(s.id)) stopped++;
  }
  return stopped;
}

/**
 * Run a verifier and judge its report against what it did.
 *
 * `run` runs the worker and returns its reply; it is given the function to feed every event of the
 * worker's to, which is how the commands it makes are known. The project's files are looked at
 * before and after; any that changed are handed to the undo net and named in the verdict.
 */
export async function verifyWithGuards(o: {
  cwd: string;
  checkpoints?: Checkpoints;
  /** The session's background shells: what the verifier starts is stopped when it finishes. */
  shells?: BackgroundShells;
  run: (onEvent: (e: EngineEvent) => void) => Promise<string>;
}): Promise<VerdictReport> {
  const before = await snapshotTree(o.cwd);
  const runs = watchRuns();
  const knownShells = new Set((o.shells?.list() ?? []).map((s) => s.id));
  let reply: string;
  try {
    reply = await o.run(runs.onEvent);
  } finally {
    stopStartedBy(o.shells, knownShells);
  }
  const changes = await treeChanges(before);
  if (changeCount(changes) > 0) await giveToUndo(o.checkpoints, changes);
  return parseVerdict(reply, { executed: runs.ran(), modified: listChanges(o.cwd, changes) });
}
