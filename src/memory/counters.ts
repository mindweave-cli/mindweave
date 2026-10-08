/**
 * counters.ts — what a session did, counted as it happens.
 *
 * Almost every measurement behind the decisions about re-reading, forgetting and cost had
 * to be reconstructed afterwards by parsing saved transcripts, from data that mostly
 * predated the build being judged, and a result that had been cleared could not even be
 * sized. These are kept live, in the session's meta file, so the same questions can be
 * answered about any session from now on: how many files were read, how often a file the
 * model could still see was read again, how often one it no longer could, how many
 * results were cleared, how many tools failed, how often the person steered.
 *
 * Counting only. Nothing here changes what the model sees or does.
 */
import type { Session } from "./types.js";

export interface SessionCounters {
  /** Tool calls made. */
  toolCalls: number;
  /** Of those, ones that failed. */
  toolErrors: number;
  /** Files read by read_file (a batch of three counts three). */
  reads: number;
  /** A file read again while its earlier whole read was still in the conversation: nothing was gained. */
  rereadsVisible: number;
  /** A file read again after its earlier read was cleared, or was only a range: forgetting, or a new need. */
  rereadsCleared: number;
  /** Tool results replaced by a stub. */
  stubbed: number;
  /** Messages the person typed into a running turn. */
  steers: number;
}

export function emptyCounters(): SessionCounters {
  return { toolCalls: 0, toolErrors: 0, reads: 0, rereadsVisible: 0, rereadsCleared: 0, stubbed: 0, steers: 0 };
}

/** What was called and how it ended, for one finished call. */
export interface CountedCall {
  name: string;
  args: Record<string, unknown>;
  isError?: boolean;
}

/** Files read earlier in this session and not edited since. Runtime only. */
const seen = new WeakMap<object, Set<string>>();

/** The files a call names, as the caller resolves them (pure but for `resolve`). */
function pathsOf(call: CountedCall, resolve: (p: string) => string | undefined): string[] {
  const raw: unknown[] = [];
  if (Array.isArray(call.args.paths)) raw.push(...call.args.paths);
  if (typeof call.args.path === "string") raw.push(call.args.path);
  return raw
    .map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? (p as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === "string")
    .map((p) => resolve(p))
    .filter((p): p is string => typeof p === "string");
}

const EDITS = new Set(["edit", "write_file", "replace_symbol_body"]);

/**
 * Count one round of finished calls. `fullyVisible` is the set of files whose whole read is
 * still in the conversation (ToolContext.transcriptFull), as it stood when the model made
 * these calls.
 */
export function countRound(
  session: Session,
  calls: readonly CountedCall[],
  resolve: (p: string) => string | undefined,
  fullyVisible: ReadonlySet<string> | undefined,
): void {
  const c = (session.counters ??= emptyCounters());
  const read = seen.get(session) ?? new Set<string>();
  seen.set(session, read);
  for (const call of calls) {
    c.toolCalls++;
    if (call.isError) c.toolErrors++;
    if (call.isError) continue;
    if (call.name === "read_file") {
      for (const path of pathsOf(call, resolve)) {
        c.reads++;
        if (read.has(path)) {
          if (fullyVisible?.has(path)) c.rereadsVisible++;
          else c.rereadsCleared++;
        }
        read.add(path);
      }
    } else if (EDITS.has(call.name)) {
      // What the file says has changed: reading it again is no longer a repeat.
      for (const path of pathsOf(call, resolve)) read.delete(path);
    }
  }
}

/** Count `n` results turned into stubs. */
export function countStubbed(session: Session, n: number): void {
  if (n > 0) (session.counters ??= emptyCounters()).stubbed += n;
}

/** Count `n` messages typed into a running turn. */
export function countSteers(session: Session, n: number): void {
  if (n > 0) (session.counters ??= emptyCounters()).steers += n;
}
