/**
 * sessionTools.ts — the model's handle on its OWN past work in this project.
 *
 * Every session is already saved to disk: a transcript, a descriptor, and a running
 * notes file the session maintains as it goes. Nothing could read any of it. Asked
 * "what did we do last session", the agent could only say that some number of
 * sessions existed and tell the user to run a command themselves — which is not an
 * answer, it is a deflection with a citation.
 *
 * One tool fixes that, at two levels of specificity:
 *
 *  - with NO id it lists, and listing is cheap. Dates, opening prompt, last prompt,
 *    size. No transcript is opened, so the model can always afford to look.
 *  - with an id it reads, defaulting to the NOTES rather than the transcript. The
 *    notes are the session's own maintained summary of what it did and where it got
 *    to — already written, already compact, already the thing a human means by "what
 *    did we do". When a session kept no notes it falls back to the (clipped)
 *    transcript in the SAME call rather than asking the model to try again, so one
 *    call always answers. `full:true` forces the transcript when that is wanted.
 *
 * This was two tools, `list_sessions` and `read_session`. They shared a store, an
 * access pattern, and a caller — reading was nearly always the direct follow-up to
 * listing — so the split only ever gave the model a decision to get wrong, and cost
 * two advertised schemas to describe one idea.
 *
 * Read-only, and scoped to THIS project's directory: these read the agent's own
 * saved work and nothing else. Another tool's data stays behind the ask-first gate
 * in guard.ts.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { anchorOf } from "./paths.js";
import { listSessions, loadSessionNotes, loadTranscript } from "../memory/store.js";
import type { Entry, SessionMeta } from "../memory/types.js";
import { fail } from "./results.js";

/** How many sessions to list at once unless asked for more. */
const DEFAULT_LIMIT = 10;
/** Characters of transcript to return before clipping — a transcript is unbounded. */
const MAX_TRANSCRIPT_CHARS = 20_000;

/**
 * One tool, two levels of specificity: no `id` lists, an `id` reads.
 *
 * These were `list_sessions` and `read_session`. Same store, same access pattern, and
 * the second was almost always a direct follow-up to the first — so the split bought
 * the model a routing decision and cost two advertised schemas to describe one idea.
 */
export const sessionsTool: Tool = {
  name: "sessions",
  deferred: true,
  readOnly: true,
  description:
    "Look at your own past sessions in this project. Use this whenever the user refers " +
    "to earlier work ('last session', 'what did we do', 'the bug we fixed yesterday') — " +
    "you have this history, so look it up instead of guessing or saying you cannot see " +
    "it.\n" +
    "With no `id` it LISTS past sessions, newest first: when each ran, what the user " +
    "opened with, what they last asked, how long it went. Cheap — no transcripts are " +
    "opened.\n" +
    "With an `id` it READS that session, returning its maintained notes (its own running " +
    "summary of the work and where it got to, which is what 'what did we do' means). If " +
    "that session kept no notes you get its raw exchange instead, in the same call, so " +
    "one call always answers. Pass `id: 'latest'` for the most recent past session, and " +
    "`full: true` only when you specifically want the raw exchange over the notes.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: {
        type: "string",
        description:
          "A session id to read, or 'latest' for the most recent. Omit entirely to list sessions instead.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: `Listing only: how many to list (default ${DEFAULT_LIMIT}, newest first).`,
      },
      full: {
        type: "boolean",
        description: "Reading only: return the raw transcript instead of the notes. Large.",
      },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    // The dispatch: naming a session means read it, otherwise list what there is.
    const wanted = typeof args.id === "string" ? args.id.trim() : "";
    return wanted ? readOne(args, ctx, wanted) : listAll(args, ctx);
  },
};

async function listAll(args: Record<string, unknown>, ctx: Parameters<Tool["execute"]>[1]): Promise<ToolResult> {
    const root = anchorOf(ctx);
    const all = await listSessions(root);
    const past = all.filter((m) => m.id !== ctx.sessionId);
    if (past.length === 0) {
      return { output: "No earlier sessions are saved for this project.", summary: "no past sessions", quiet: true };
    }
    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, 50);
    const shown = past.slice(0, limit);
    const lines = shown.map(describe);
    const more = past.length > shown.length ? `\n\n(${past.length - shown.length} older, raise \`limit\` to see them.)` : "";
    return {
      output:
        `Your past sessions in this project, newest first. Call sessions again with an ` +
        `id for what happened in one:\n\n${lines.join("\n\n")}${more}`,
      summary: `${past.length} past session${past.length === 1 ? "" : "s"}`,
      // Looking up its own history is bookkeeping, not news — same call made for
      // compaction/verification. The answer shows up in the reply itself.
      quiet: true,
    };
}

async function readOne(
  args: Record<string, unknown>,
  ctx: Parameters<Tool["execute"]>[1],
  wanted: string,
): Promise<ToolResult> {
    const root = anchorOf(ctx);
    const all = await listSessions(root);
    const past = all.filter((m) => m.id !== ctx.sessionId);
    if (past.length === 0) {
      return { output: "No earlier sessions are saved for this project.", summary: "no past sessions", quiet: true };
    }

    // "latest" is the explicit spelling of what used to be "omit the id". Omitting it
    // now means LIST, so the shorthand needs a word of its own rather than a gap.
    const meta = wanted === "latest" ? past[0] : past.find((m) => m.id === wanted);
    if (!meta) {
      return fail(
        `no saved session with id '${wanted}'. Call sessions with no id to see which ids exist.`,
      );
    }

    const header = describe(meta);
    if (args.full === true) {
      const transcript = await loadTranscript(root, meta.id);
      return {
        output: `${header}\n\n${renderTranscript(transcript ?? [])}`,
        summary: `session ${short(meta.id)} (transcript)`,
        quiet: true,
      };
    }

    const notes = await loadSessionNotes(root, meta.id);
    if (!notes) {
      // No notes → answer anyway, from the transcript, in THIS call. Telling the model
      // to come back with full:true bought nothing: it spent an extra round trip to
      // reach the same clipped transcript we can already return, and a model that reads
      // "call again" as "that failed" answers from the project files instead — the exact
      // deflection these tools exist to stop. The render is bounded, so this is safe.
      const transcript = await loadTranscript(root, meta.id);
      const body = renderTranscript(transcript ?? []);
      return {
        output:
          `${header}\n\nThat session kept no notes (it may have been short), so this is its ` +
          `raw exchange instead:\n\n${body}`,
        summary: `session ${short(meta.id)} (transcript, no notes)`,
        quiet: true,
      };
    }
    // The notes are as current as their last refresh, which can be a few turns before the
    // session ended. Say so, and add what came after, so a question about "where did we stop"
    // is answered from the end of that session and not from where its notes stopped.
    const after = await afterTheNotes(root, meta);
    return {
      output: `${header}\n\nWhat that session recorded about its own work:\n\n${notes}${after}`,
      summary: `session ${short(meta.id)} (notes)`,
      // Reading its own history is bookkeeping, not news — same as the listing above.
      // The answer is what shows up, not the lookup itself.
      quiet: true,
    };
}

/** How much of what happened after the notes were last written is repeated beside them. */
const AFTER_NOTES_CHARS = 5_000;

/**
 * What that session did after its notes were last refreshed, ready to append (or "" when the
 * notes reach the end, or when it is not known how far they reach).
 */
async function afterTheNotes(root: string, meta: SessionMeta): Promise<string> {
  const cover = meta.notesCover;
  if (!cover || cover.entries >= meta.entryCount) return "";
  const transcript = await loadTranscript(root, meta.id);
  const rest = (transcript ?? []).slice(cover.entries);
  const body = renderTranscript(rest);
  if (!rest.length || body.startsWith("(that session's transcript is empty)")) return "";
  const clipped = body.length > AFTER_NOTES_CHARS ? body.slice(-AFTER_NOTES_CHARS) : body;
  return (
    `\n\nThe notes above were last written ${meta.entryCount - cover.entries} messages before that session ended. ` +
    `What happened after them (newest at the bottom${body.length > AFTER_NOTES_CHARS ? ", earlier part left out" : ""}):\n\n${clipped}`
  );
}

/** One session as a compact block: id, when, size, and the prompts that bracket it. */
function describe(meta: SessionMeta): string {
  const parts = [
    `id: ${meta.id}`,
    `when: ${timeAgo(meta.updatedAt)} (${new Date(meta.updatedAt).toISOString().slice(0, 16).replace("T", " ")})`,
    `length: ${meta.entryCount} messages`,
    `opened with: ${clip(meta.firstPrompt)}`,
  ];
  // The last prompt is only worth a line when it differs — a one-exchange session
  // would otherwise print the same text twice.
  if (meta.lastPrompt && meta.lastPrompt.trim() !== meta.firstPrompt.trim()) {
    parts.push(`last asked: ${clip(meta.lastPrompt)}`);
  }
  return parts.join("\n");
}

/** Render a saved transcript readably, clipped — transcripts have no size bound. */
function renderTranscript(entries: Entry[]): string {
  const body = entries
    .filter((e) => e.role === "user" || e.role === "assistant")
    .map((e) => `${e.role === "user" ? "User" : "You"}: ${e.content.trim()}`)
    .filter((line) => line.length > 6)
    .join("\n\n");
  if (!body) return "(that session's transcript is empty)";
  return body.length > MAX_TRANSCRIPT_CHARS
    ? body.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n… (transcript clipped)"
    : body;
}

/** "3 days ago" / "2 hours ago" — how a human refers to a past session. */
export function timeAgo(when: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
  ];
  let label = "minute";
  let size = 60;
  for (const [unitSeconds, name] of units) {
    if (seconds >= unitSeconds) {
      size = unitSeconds;
      label = name;
    }
  }
  const n = Math.floor(seconds / size);
  return `${n} ${label}${n === 1 ? "" : "s"} ago`;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function clip(text: string, max = 140): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  if (!line) return "(nothing recorded)";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

