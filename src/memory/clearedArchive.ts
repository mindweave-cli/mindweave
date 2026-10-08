/**
 * clearedArchive.ts — keep what a cleared tool result said, and tell the model where.
 *
 * Clearing an old tool result replaced its body with a stub in place, and nothing kept
 * the original: a three-minute test run, a fetched page, an app inspection, anything
 * that cannot simply be asked for again, was gone for good, and the stub could only say
 * "re-read it if you need it". Measured in real sessions, a model that lost a file read
 * repeated the same read, whole file for whole file.
 *
 * Now the original is written to a file under the session's state folder before the stub
 * replaces it, and the stub says where, how big it was, and for a file read whether the
 * file has changed since. A forgotten result becomes a ranged read of a saved file
 * instead of a re-run. What is sent to the model changes only by that one line, at the
 * moment of the clear, when the cached prefix is being rewritten anyway.
 *
 * read_file may open these files (tools/guard.ts allows the `cleared` folder inside
 * Mindweave's state folder). Only the most recent sessions' archives are kept.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./store.js";
import { CLEARED_STUB, estimateTokens } from "./compaction.js";
import type { Entry } from "./types.js";

/** How many sessions per project keep their cleared results on disk. */
const KEEP_SESSIONS = 10;

/** Where one session's cleared results are kept. */
export function clearedDir(cwd: string, sessionId: string): string {
  return join(projectDir(cwd), "cleared", sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/**
 * Save the original of every result cleared between `before` and `after`, and add the
 * saved location to its stub. Returns the entries to keep. Never throws: if saving fails,
 * the plain stub stays, which is what clearing did before.
 *
 * `changedSince` answers, for a file a read_file call read, whether it has changed on
 * disk since (null when it cannot tell).
 */
export function archiveCleared(
  before: readonly Entry[],
  after: Entry[],
  cwd: string,
  sessionId: string,
  changedSince: (path: string) => boolean | null = () => null,
): Entry[] {
  try {
    return archive(before, after, cwd, sessionId, changedSince);
  } catch {
    return after; // saving is a courtesy; the plain stub is what clearing always did
  }
}

function archive(
  before: readonly Entry[],
  after: Entry[],
  cwd: string,
  sessionId: string,
  changedSince: (path: string) => boolean | null,
): Entry[] {
  const original = new Map<string, string>();
  for (const e of before) {
    if (e.role === "tool" && !e.content.includes(CLEARED_STUB)) original.set(e.toolCallId, e.content);
  }
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const e of before) if (e.role === "assistant" && e.toolCalls) for (const c of e.toolCalls) calls.set(c.id, c);

  const dir = clearedDir(cwd, sessionId);
  let made = false;
  return after.map((e) => {
    if (e.role !== "tool" || !e.content.includes(CLEARED_STUB) || e.content.includes("[saved at ")) return e;
    const body = original.get(e.toolCallId);
    if (body === undefined) return e;
    try {
      if (!made) {
        mkdirSync(dir, { recursive: true });
        pruneOldSessions(join(dir, ".."), dir);
        made = true;
      }
      const file = join(dir, `${e.toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
      writeFileSync(file, body);
      // A closing newline ends the last line rather than starting another.
      const lines = body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
      const call = calls.get(e.toolCallId);
      const read = call?.name === "read_file" ? singlePath(call.arguments) : null;
      const changed = read ? changedSince(read) : null;
      const status = changed === null ? "" : changed ? " · the file has CHANGED since" : " · the file is unchanged since";
      const line = `[saved at ${file} · ${lines} lines · ~${estimateTokens(body)} tokens${status}; read_file it with a line range instead of running the call again]`;
      return { ...e, content: `${e.content}\n${line}` };
    } catch {
      return e;
    }
  });
}

/** The one path a read_file call read, or null for several (pure). */
function singlePath(args: string): string | null {
  try {
    const a = JSON.parse(args) as { path?: unknown; paths?: unknown };
    if (typeof a.path === "string") return a.path;
    if (Array.isArray(a.paths) && a.paths.length === 1) {
      const p = a.paths[0] as unknown;
      if (typeof p === "string") return p;
      if (p && typeof p === "object" && typeof (p as { path?: unknown }).path === "string") return (p as { path: string }).path;
    }
  } catch {
    /* not JSON: no path */
  }
  return null;
}

/** Keep the newest KEEP_SESSIONS session folders under `root`, always including `current`. */
function pruneOldSessions(root: string, current: string): void {
  try {
    const dirs = readdirSync(root)
      .map((name) => join(root, name))
      .filter((p) => p !== current)
      .map((p) => ({ p, at: statSync(p).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { p } of dirs.slice(KEEP_SESSIONS - 1)) rmSync(p, { recursive: true, force: true });
  } catch {
    /* nothing to prune */
  }
}
