/**
 * editTarget.ts — the shared pre-edit gauntlet for the edit tool.
 *
 * Both tools must clear the exact same gates before touching a file: path guards
 * (protected + forbidden-with-lift), the file must exist and be a file, and it
 * must have been READ this session (the anti-confabulation rule). Factoring it
 * here keeps that policy in one place so the two tools can never drift apart on
 * safety. Returns the file's content + detected EOL on success, or a ready-made
 * failure ToolResult to hand straight back.
 */
import { promises as fs } from "node:fs";
import type { ToolContext, ToolResult } from "./types.js";
import { foreignAgentReason, guardedPathReason } from "./guard.js";
import { forbiddenRealPathReason } from "../governor/forbidden.js";
import { requestRunsLaterWrite } from "./runsLater.js";
import { requestAgentDataAccess, requestForbiddenLift, requestOutsideWorkspaceWrite } from "./approval.js";
import { resolvePath } from "./paths.js";
import { detectEol } from "./eol.js";
import { fail, failQuietly } from "./results.js";

// Re-exported because the edit tools reach for these alongside the gauntlet itself.
export { fail, failQuietly } from "./results.js";

export interface EditTarget {
  ok: true;
  /** Absolute resolved path. */
  filePath: string;
  /** Current file contents (raw, with its real line endings). */
  content: string;
  /** The file's detected EOL, to preserve on write. */
  eol: ReturnType<typeof detectEol>;
  /**
   * This file is NOT in the read ledger, so the caller must earn the edit by matching.
   *
   * See the read-before-edit gate below for why this is a flag rather than a refusal.
   * The caller proceeds only if every `old_string` matches exactly once in `content`;
   * anything less and it returns `unreadError(rawPath)` instead of writing.
   */
  unread: boolean;
}

export type PrepareResult = EditTarget | { ok: false; error: ToolResult };

/** Run the shared pre-edit checks for `rawPath`. `verb` names the action in
 *  messages (e.g. "editing"); `preview` is the change, shown if the user is asked. */
export async function prepareEditTarget(
  ctx: ToolContext,
  rawPath: string,
  verb: string,
  preview = "",
): Promise<PrepareResult> {
  const filePath = resolvePath(ctx, rawPath);

  const blocked = await guardedPathReason(filePath);
  if (blocked) return { ok: false, error: fail(`Refusing to edit ${rawPath}: it is ${blocked}.`) };

  // Another tool's data. Writing to it is worse than reading it — we'd be editing
  // a history we were never part of — so it goes through the same ask-first gate.
  const otherTool = foreignAgentReason(filePath);
  if (otherTool) {
    const denied = await requestAgentDataAccess(ctx, otherTool, `${verb} ${rawPath}`);
    if (denied) return { ok: false, error: denied };
  }

  const forbidden = await forbiddenRealPathReason(ctx.governance?.forbidden, filePath, ctx.roots ?? []);
  if (forbidden) {
    const lift = await requestForbiddenLift(
      ctx,
      forbidden,
      `${verb} ${rawPath}`,
      `the user has forbidden touching '${forbidden}'.`,
    );
    if (lift) return { ok: false, error: lift }; // refused/deferred; an allow returns null → falls through
  }

  // The workspace boundary. Everything above is about WHICH file; this is about whether
  // the agent should be writing there at all.
  const outside = await requestOutsideWorkspaceWrite(ctx, filePath, `${verb} ${rawPath}`);
  if (outside) return { ok: false, error: outside };

  // A file that runs code later (an editor task, a hook, a workflow) asks first.
  const later = await requestRunsLaterWrite(ctx, filePath, rawPath, preview);
  if (later) return { ok: false, error: later };

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { ok: false, error: fail(`file ${rawPath} not found. Use write_file to create a new file.`) };
  }
  if (stat.isDirectory()) return { ok: false, error: fail(`${rawPath} is a directory, not a file.`) };

  // Read-before-edit: the anti-confabulation gate.
  //
  // It used to refuse here, outright, for any file not in the ledger. That cost far more
  // than it protected. Measured on a real session: the model batched one identical
  // navigation edit across five pages, four were refused, and it then read four whole
  // files (~9,000 tokens each) and re-issued the same four edits — which all applied
  // cleanly, first try. Twelve calls where five would have done, and every byte of those
  // reads was spent proving something the edit was about to prove anyway.
  //
  // Because that is what an edit already does: `old_string` is matched against the
  // file's CURRENT bytes (see the freshness note below, which says as much). A unique
  // match IS evidence the model knows what is there — you cannot quote a line you have
  // not seen. So an unread file is no longer refused; it is made to earn the edit by
  // matching exactly. If it cannot, the caller returns the same "read it first" message
  // it always did, and the read happens then — when it is actually needed.
  // A search-sourced entry does not count as having seen the file: grep shows matching
  // lines, never the file, so the edit still has to earn itself by matching exactly.
  const record = ctx.reads.get(filePath);
  const seen = record && !record.viaSearch ? record : undefined;

  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: fail(`could not read ${rawPath}: ${errText(error)}`) };
  }

  // Freshness: has the file moved since it was read?
  //
  // Without this the situation is still SAFE — the edit is matched against the file's
  // current bytes, so a stale `old_string` simply fails to match — but it is diagnosed
  // WRONGLY. The model is told "old_string not found, re-read and copy the target text
  // precisely", which reads as "you mistyped", so it retries the same doomed string
  // instead of re-reading. The cause has to be named for the recovery to be the right one.
  //
  // And the quieter case is worse: if the change landed somewhere the model is not
  // editing, its edit applies cleanly against content nobody has looked at. That is the
  // only path here where a confident edit is made on stale understanding, so it is worth
  // one comparison of two numbers we already hold.
  if (seen && changedSinceRead(seen, stat)) {
    return {
      ok: false,
      error: failQuietly(
        `${rawPath} changed on disk since you read it (a command, a formatter, or the user). ` +
          `Your view of this file is out of date, so an edit based on it could be wrong even where it matches. ` +
          `Read it again, then redo the edit against what it says now.`,
      ),
    };
  }

  return { ok: true, filePath, content, eol: detectEol(content), unread: seen === undefined };
}

/** The refusal an unread file earns only when its edits do NOT match exactly. Same
 *  message the gate always gave; it is just paid for when it is actually true. */
export function unreadError(rawPath: string): ToolResult {
  return fail(
    `${rawPath} has not been read this session, and your edit did not match it exactly. ` +
      `Read it first so your edit matches the real content.`,
  );
}

/**
 * Did the file change between the read that put it in the ledger and now (pure)?
 *
 * Both signals are checked because either alone misses real cases: mtime resolution is
 * coarse enough on some filesystems that a fast rewrite keeps the same stamp, and a size
 * comparison alone misses any edit that happens to preserve length — a renamed symbol, a
 * flipped boolean, a changed constant. Neither is exotic in a codebase.
 *
 * A file the ledger has no size for (an older record, or one seeded rather than read) is
 * treated as unchanged: refusing on missing bookkeeping would block edits over our own
 * gap rather than over anything the user did.
 */
export function changedSinceRead(
  seen: { mtimeMs?: number; size?: number },
  now: { mtimeMs: number; size: number },
): boolean {
  if (typeof seen.size === "number" && seen.size !== now.size) return true;
  if (typeof seen.mtimeMs === "number" && seen.mtimeMs > 0 && Math.abs(seen.mtimeMs - now.mtimeMs) > 1) return true;
  return false;
}


export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
