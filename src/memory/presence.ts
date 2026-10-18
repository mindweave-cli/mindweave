/**
 * presence.ts — which files the model can actually still SEE (pure).
 *
 * The read ledger (`ToolContext.reads`) owns a FACT: "this file was read at this
 * mtime/size, and here are the regions the model focused on." That fact is what the
 * edit freshness gate needs, and it stays true no matter what happens to the
 * transcript.
 *
 * "The content of this file is currently visible to the model" is a different kind of
 * claim. It is not a fact about the past; it is a property of the bytes about to be
 * sent, and it changes every time the transcript changes. The moment it is STORED
 * next to the fact, every future transcript mutation has to remember to update it —
 * and the one that forgets ships a model reasoning about a file it can no longer see.
 *
 * So it is derived, never stored. `workingSetFull` already answers it for the volatile
 * working-set block (emitted by the same pass that renders those bytes). This module
 * answers it for the other half: a full `read_file` result still sitting unstubbed in
 * the transcript. Together they are the whole answer, and `read_file`'s two
 * short-circuits consult one each.
 *
 * See BOUNDARY.md, "Records, derivations, and standing knowledge".
 */
import type { Entry } from "./types.js";
import { fullPathsOf } from "./types.js";
import { CLEARED_STUB } from "./compaction.js";

/**
 * The set of absolute paths whose WHOLE content is still present in the transcript:
 * a `read_file` call with no `offset`/`limit`, whose result has not been cleared to a
 * stub by microcompaction.
 *
 * Pure. `resolve` turns the call's recorded (possibly relative or labelled) path into
 * the same absolute key the read ledger uses; it returns undefined for anything it
 * cannot resolve, which is simply left out.
 */
export function fullReadPaths(entries: Entry[], resolve: (path: string) => string | undefined): Set<string> {
  const callById = new Map<string, { name: string; arguments: string }>();
  for (const e of entries) {
    if (e.role === "assistant" && e.toolCalls) {
      for (const tc of e.toolCalls) callById.set(tc.id, { name: tc.name, arguments: tc.arguments });
    }
  }

  const present = new Set<string>();
  for (const e of entries) {
    if (e.role !== "tool") continue;
    // A cleared body is a stub: the entry survives for navigation, the content does not.
    if (e.content.includes(CLEARED_STUB)) continue;

    // The tool recorded which file this result IS, at the moment it was true. Exact:
    // no re-resolution, so a `cd` since then cannot make it point somewhere else.
    const recorded = fullPathsOf(e);
    if (recorded.length > 0) {
      for (const path of recorded) present.add(path);
      continue;
    }

    // Fallback for sessions written before results carried that fact. Re-resolving the
    // arguments is a guess about where a relative path pointed at the time, so it is
    // used only when there is nothing better, never in preference to the recording.
    const call = callById.get(e.toolCallId ?? "");
    if (!call || call.name !== "read_file") continue;
    let args: { path?: unknown; offset?: unknown; limit?: unknown };
    try {
      args = JSON.parse(call.arguments) as typeof args;
    } catch {
      continue; // malformed args — nothing to claim
    }
    // A ranged read put only a window in the transcript, not the whole file.
    if (args.offset !== undefined || args.limit !== undefined) continue;
    if (typeof args.path !== "string") continue;
    const abs = resolve(args.path);
    if (abs) present.add(abs);
  }
  return present;
}

/**
 * The line ranges of a file whose text is still present in the transcript, from `read_file`
 * calls that took a range (pure). The companion to `fullReadPaths` for a read with
 * `offset`/`limit`: which lines are meant comes from the result's own summary
 * (`read a.ts lines 200-499`), the thing that says what was actually sent, and a result that
 * has since been cleared to a stub, failed, or was itself an "unchanged" answer is left out.
 */
export function visibleReadRanges(
  entries: Entry[],
  resolve: (path: string) => string | undefined,
): Map<string, { start: number; end: number }[]> {
  const callById = new Map<string, { name: string; arguments: string }>();
  for (const e of entries) {
    if (e.role === "assistant" && e.toolCalls) {
      for (const tc of e.toolCalls) callById.set(tc.id, { name: tc.name, arguments: tc.arguments });
    }
  }
  const out = new Map<string, { start: number; end: number }[]>();
  for (const e of entries) {
    if (e.role !== "tool" || e.isError || e.content.includes(CLEARED_STUB) || e.content.startsWith("Error:")) continue;
    const call = callById.get(e.toolCallId ?? "");
    if (!call || call.name !== "read_file") continue;
    const said = /\blines (\d+)-(\d+)/.exec(e.summary ?? "");
    if (!said || /\(unchanged\)/.test(e.summary ?? "")) continue;
    let args: { path?: unknown; paths?: unknown };
    try {
      args = JSON.parse(call.arguments) as typeof args;
    } catch {
      continue;
    }
    // A range applies to a single file; a call naming several read them whole.
    if (typeof args.path !== "string" || Array.isArray(args.paths)) continue;
    const abs = resolve(args.path);
    if (!abs) continue;
    const list = out.get(abs) ?? [];
    list.push({ start: Number(said[1]), end: Number(said[2]) });
    out.set(abs, list);
  }
  return out;
}

/**
 * Absolute paths the model has WRITTEN or EDITED, from tool calls that succeeded.
 *
 * The companion to `fullReadPaths`, and needed for the same reason on resume: a file the
 * model wrote last session is a file it has seen. Its whole content was in the call's own
 * arguments, and an edit could only have happened after a read. Without this the
 * read-before-overwrite gate refuses a file the model itself created, and the model
 * re-reads it — appending another full copy to the transcript, which is the cost the
 * ledger restore exists to stop.
 *
 * Failures are skipped: a write that was refused wrote nothing, and claiming it would
 * open the gate on a file nobody has seen.
 */
export function writtenPaths(entries: Entry[], resolve: (path: string) => string | undefined): Set<string> {
  const callById = new Map<string, { name: string; arguments: string }>();
  for (const e of entries) {
    if (e.role === "assistant" && e.toolCalls) {
      for (const tc of e.toolCalls) callById.set(tc.id, { name: tc.name, arguments: tc.arguments });
    }
  }

  const written = new Set<string>();
  for (const e of entries) {
    if (e.role !== "tool") continue;
    if (e.isError || e.content.startsWith("Error:")) continue;
    const call = callById.get(e.toolCallId ?? "");
    if (!call || !WRITING_TOOLS.has(call.name)) continue;
    let args: { path?: unknown };
    try {
      args = JSON.parse(call.arguments) as typeof args;
    } catch {
      continue;
    }
    if (typeof args.path !== "string") continue;
    const abs = resolve(args.path);
    if (abs) written.add(abs);
  }
  return written;
}

/** Tools whose successful use means the model has seen the file it names. */
const WRITING_TOOLS = new Set(["write_file", "edit", "replace_symbol_body"]);
