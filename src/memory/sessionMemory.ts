/**
 * sessionMemory.ts — a continuously-maintained, structured "state of the session",
 * kept for the moment the conversation has to be cut down.
 *
 * The problem it solves: even with good compaction, a very long session slowly loses
 * fidelity — each summary is a lossy pass over the previous summary. Session memory
 * breaks that: a small, structured notes document (Current State, Task, Files, Errors,
 * Learnings, Worklog) is refreshed as the work goes on, outside the transcript. When the
 * transcript is compacted, those notes ARE the summary of the part that is cut away, and
 * the recent entries after the point the notes cover are kept exactly as they were (see
 * `sessionMemoryCompact.ts`). That is the whole use of them.
 *
 * They are NOT shown to the model on every turn. They used to be, labelled "trust these",
 * and a copy that lags behind what just happened is a second source that can disagree with
 * the conversation the model is actually in. A real session did exactly that: the notes
 * still said an app was running and a test row existed after both were gone, and a small
 * free model spent twenty-five calls announcing that its own memory was corrupt. While the
 * conversation holds everything, it is the one source of truth; the notes only stand in for
 * what has been cut away.
 *
 * Because of that, what matters is how current they are when a compaction needs them. They
 * are refreshed during a turn, not only between turns (a long run of tool calls is one turn),
 * in the background so the work is not held up, and every refresh records exactly how much of
 * the transcript it covered.
 *
 * It is distinct from the other memories:
 *   - MINDWEAVE.md  = durable project facts the user/model curate (spans sessions).
 *   - auto-memory = cross-session typed notes (spans sessions).
 *   - session memory = THIS session's live working state (dies with the session).
 *
 * The pure parts (the update trigger, validation, bounding) are unit-tested; the update
 * itself is one cheap model call, degrade-safe (a failure keeps the last good notes).
 */
import { withAuxModel } from "../dynamo/auxModel.js";
import type { Entry, Session } from "./types.js";
import { estimateEntriesTokens, estimateTokens, formatTranscriptForSummary } from "./compaction.js";
import { activeDriver, ensureDriver } from "../drivers/registry.js";
import { toolSchemas } from "../tools/registry.js";

const env = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/**
 * First update once the transcript passes this (let a session warm up first).
 *
 * Deliberately LOW. At 10K a session could do a whole piece of real work and end
 * having never written a note, so a later `read_session` found nothing and fell back
 * to the raw transcript — a worse answer, for more tokens, after an extra round trip.
 * The bar only exists so a two-message session doesn't pay for a model call; 4K is
 * enough warm-up for that and cheap enough that ordinary sessions get real notes.
 */
const INIT_THRESHOLD = env("MINDWEAVE_SESSION_MEMORY_INIT", 4_000);
/** Refresh the notes after this much further growth (always required). */
const UPDATE_THRESHOLD = env("MINDWEAVE_SESSION_MEMORY_UPDATE", 6_000);
/**
 * And after this many tool calls, which together with the growth means real work has
 * happened since. Without a count of work, a few large reads alone would refresh the notes
 * with nothing worth writing, and a long quiet run of small calls would not refresh them
 * at all until much later than it should.
 */
const UPDATE_TOOL_CALLS = env("MINDWEAVE_SESSION_MEMORY_TOOL_CALLS", 3);
/** The most entries one refresh reads. The notes already carry everything older. */
const FEED_ENTRIES = env("MINDWEAVE_SESSION_MEMORY_FEED", 120);
/** Hard cap on the notes so they can't themselves bloat context (~12K tokens total,
 *  ~2K per section). */
export const SESSION_MEMORY_MAX_TOKENS = env("MINDWEAVE_SESSION_MEMORY_MAX_TOKENS", 12_000);
/** Per-section soft budget — condense a section past this (~2K/section). */
export const SESSION_MEMORY_SECTION_TOKENS = env("MINDWEAVE_SESSION_MEMORY_SECTION_TOKENS", 2_000);

/** The structured skeleton the model fills in and keeps current. The
 *  italic _descriptions_ are template instructions (kept intact); the model only fills
 *  the content beneath each. "Current State" is first-class: it's what lets the model
 *  pick up cleanly after a compaction. */
export const SESSION_MEMORY_TEMPLATE = `# Session Title
_A short and distinctive 3-6 word title for the session, like a commit subject ("Fix SQL injection in login"). No project name, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_`;

const UPDATE_SYSTEM =
  "You maintain a running notes document that captures the live state of a software " +
  "engineering session, so work can continue seamlessly across context compaction. You " +
  "will be given the CURRENT notes and what has happened SINCE they were written. Return the " +
  "COMPLETE updated notes document. Rules:\n" +
  "- Keep EVERY section header exactly, and keep the italic _description_ line under each " +
  "header intact (those are template instructions, not content) — only update the content " +
  "beneath them.\n" +
  "- Fold new activity into the right sections; write DENSE, specific content (file paths, " +
  "function names, exact commands, error messages, decisions).\n" +
  `- Keep each section under ~${SESSION_MEMORY_SECTION_TOKENS} tokens: when one grows past that, ` +
  "CYCLE OUT the least important details while preserving the most critical.\n" +
  "- Leave a section unchanged if there's nothing substantial to add (no filler like 'N/A').\n" +
  "- ALWAYS keep 'Current State' accurate to the latest turn — it's what continues the work " +
  "after compaction.\n" +
  "- Where the new activity contradicts what the notes say, the new activity is right: " +
  "correct the notes, and do not write about the correction.\n" +
  "- Do NOT record facts about the machine that change on their own: process ids, whether " +
  "an app or server is currently running, ports in use, temporary files or database rows " +
  "that exist only for a test. They are wrong within minutes. If one matters, say what was " +
  "done and when (\"started the dev server at 09:04\"), never that it is still so.\n" +
  "Output ONLY the notes document — no preamble, no commentary, no code fences.";

const UPDATE_REQUEST =
  "Update the notes with anything new from the conversation since they were written, then " +
  "output the full updated notes document (same section headers and italic descriptions, " +
  "dense, concise).";

/** The `# Heading` lines of the template, in order (pure). */
function templateHeaders(): string[] {
  return SESSION_MEMORY_TEMPLATE.split("\n").filter((l) => l.startsWith("# "));
}

/**
 * How many tool calls the entries from `from` on contain (pure). Counted from the point the
 * notes last covered, so there is no counter to keep in step with the transcript.
 */
export function toolCallsSince(transcript: readonly Entry[], from: number): number {
  let n = 0;
  for (let i = Math.max(0, from); i < transcript.length; i++) {
    const e = transcript[i]!;
    if (e.role === "assistant" && e.toolCalls) n += e.toolCalls.length;
  }
  return n;
}

/**
 * Whether to refresh the notes now (pure).
 *
 * Growth is ALWAYS required, so refreshes never fire too often, and before the first one
 * the session has to warm past the init bar. Past that, either enough work has happened
 * (growth AND tool calls), or the agent has reached a natural break (a reply with no tool
 * calls after it) and there has been growth.
 */
export function shouldUpdateSessionMemory(
  currentTokens: number,
  lastUpdateTokens: number,
  initialized: boolean,
  toolCalls: number = UPDATE_TOOL_CALLS,
  atBreak = true,
): boolean {
  if (!initialized) return currentTokens >= INIT_THRESHOLD;
  const grown = currentTokens - lastUpdateTokens >= UPDATE_THRESHOLD;
  if (!grown) return false;
  return toolCalls >= UPDATE_TOOL_CALLS || atBreak;
}

/**
 * Is a refresh due for this session right now (pure)? `atBreak` is whether the agent is
 * between turns rather than in the middle of working.
 */
export function sessionMemoryDue(session: Session, atBreak: boolean): boolean {
  return shouldUpdateSessionMemory(
    estimateEntriesTokens(session.transcript),
    session.sessionMemoryTokens ?? 0,
    session.sessionMemoryInit ?? false,
    toolCallsSince(session.transcript, session.sessionMemoryEntries ?? 0),
    atBreak,
  );
}

/** Keep the notes under budget: if the model over-produces, trim to the cap (pure). */
export function boundSessionMemory(notes: string, maxTokens: number = SESSION_MEMORY_MAX_TOKENS): string {
  if (estimateTokens(notes) <= maxTokens) return notes;
  const maxChars = Math.floor(maxTokens * 3.5);
  return notes.slice(0, maxChars).trimEnd() + "\n\n(notes truncated to stay within budget)";
}

/**
 * Whether a model's rewrite of the notes is fit to replace the last good ones (pure).
 *
 * A small or struggling model asked to return a long document can return a fragment, a
 * refusal, or the skeleton with nothing in it. Taking that as the new notes would throw away
 * a good record for a bad one, and the only thing that would notice is the next compaction.
 * So a rewrite must keep every section, say something, and not collapse what was there.
 */
export function notesAreUsable(previous: string | undefined, next: string): boolean {
  const text = next.trim();
  if (!text) return false;
  for (const header of templateHeaders()) if (!text.includes(header)) return false;
  if (text === SESSION_MEMORY_TEMPLATE.trim()) return false;
  const before = (previous ?? "").trim();
  if (before.length > 1_500 && text.length < before.length * 0.4) return false;
  return true;
}

/**
 * Refresh the session notes from what happened since they were written (one cheap model
 * call, thinking off). Mutates `session.sessionMemory` and the coverage marks IN MEMORY
 * only — the CLI persists the notes file, keeping the engine filesystem-pure. Degrade-safe:
 * on any failure the previous notes are kept untouched.
 *
 * Runs while the turn goes on, so it works from a snapshot: it reads the entries as they
 * were when it started, and records THAT as what the notes cover. If the transcript was
 * compacted, rewound or cleared in the meantime the snapshot no longer lines up with it, and
 * the result is dropped rather than claiming to cover entries it never saw.
 */
export async function updateSessionMemory(
  session: Session,
  signal?: AbortSignal,
  /** Told what the call cost: it is a real model call on the user's key that nobody asked for. */
  onUsage?: (usage: import("../drivers/types.js").Usage) => void,
): Promise<boolean> {
  const upto = session.transcript.length;
  if (upto === 0) return false;
  const last = session.transcript[upto - 1];
  const covered = Math.min(session.sessionMemoryEntries ?? 0, upto);
  // Only what the notes have not seen, as far back as one refresh reads. Reading a fixed
  // number of the newest entries instead dropped the middle of anything longer than that.
  const from = Math.max(covered, upto - FEED_ENTRIES);
  const unseen = session.transcript.slice(from, upto);
  if (unseen.length === 0) return false;
  const skipped = from - covered;
  const tokensAtStart = estimateEntriesTokens(session.transcript.slice(0, upto));
  const current = session.sessionMemory?.trim() || SESSION_MEMORY_TEMPLATE;
  try {
    // With reasoning off where the model allows it; see dynamo/auxModel.ts.
    // `ensureDriver` first: `activeDriver()` is a plain global, and a sub-agent (or
    // another background aux call) running its own model in between leaves it
    // pointed at THAT provider — this call would then hand ITS model string to the
    // wrong provider's API. See the matching fix + comment in dynamo/engine.ts's
    // summarizeAndSplice, which hit the exact same failure shape.
    //
    // `withTools`: a real (read-only) tool set, attached only if the model already
    // refused a bare call — some free models serve only tool-shaped requests.
    const { content, usage } = await withAuxModel(session.modelConfig, async (model, withTools) => {
      await ensureDriver(model.model);
      return activeDriver().toolTurn({
        system: UPDATE_SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `NOW: ${new Date().toISOString()}\n\n` +
              `CURRENT NOTES:\n${current}\n\n` +
              `WHAT HAPPENED SINCE THEY WERE WRITTEN` +
              (skipped > 0 ? ` (${skipped} earlier entries were too many to include)` : "") +
              `:\n${formatTranscriptForSummary(unseen)}\n\n${UPDATE_REQUEST}`,
          },
        ],
        model,
        ...(withTools ? { tools: toolSchemas({ readOnlyOnly: true }) } : {}),
      }, { signal }); // Esc reaches this call too; a slow model must not hold a stop open
    });
    if (usage) onUsage?.(usage);
    const notes = boundSessionMemory(content.trim());
    if (!notesAreUsable(session.sessionMemory, notes)) return failed(session, tokensAtStart);
    // The snapshot has to still be the start of the transcript. Compaction, a rewind, /clear
    // and the shedding of old rounds all replace it, and a refresh that began before one of
    // them describes entries that may no longer be where it thinks.
    if (session.transcript[upto - 1] !== last) return false;
    session.sessionMemory = notes;
    session.sessionMemoryTokens = tokensAtStart;
    // The boundary compaction-from-notes splits on: everything up to here is written
    // down, everything after it has to be kept verbatim. Recorded at the same moment
    // as the notes so the two can never describe different transcripts, and from the
    // snapshot, not the transcript as it is now, which has grown while this ran.
    session.sessionMemoryEntries = upto;
    session.sessionMemoryInit = true;
    return true;
  } catch {
    return failed(session, tokensAtStart); // keep the last good notes
  }
}

/**
 * A refresh that did not produce notes: keep the last good ones, and do not try again until
 * the work has grown by another full step. The refresh is considered after every round of tool
 * results now, so without this a model that cannot do the call (one that refuses background
 * requests, or is rate limited) would be asked again after every round, each time paying for
 * the attempt and, on a rate-limited key, making the real work slower.
 */
function failed(session: Session, tokensAtStart: number): false {
  session.sessionMemoryTokens = tokensAtStart;
  session.sessionMemoryInit = true;
  return false;
}

/**
 * Start a refresh, or join the one already running (one at a time per session).
 *
 * Two refreshes at once would each read the same unseen entries and the later one would
 * overwrite the earlier with notes that know less. The returned promise never rejects.
 */
export function refreshSessionMemory(
  session: Session,
  signal?: AbortSignal,
  onUsage?: (usage: import("../drivers/types.js").Usage) => void,
): Promise<boolean> {
  if (session.sessionMemoryRun) return session.sessionMemoryRun;
  const run: Promise<boolean> = updateSessionMemory(session, signal, onUsage).finally(() => {
    if (session.sessionMemoryRun === run) session.sessionMemoryRun = undefined;
  });
  session.sessionMemoryRun = run;
  return run;
}

/** Wait for a refresh that is already running, if any. Never starts one and never throws. */
export async function settleSessionMemory(session: Session): Promise<void> {
  try {
    await session.sessionMemoryRun;
  } catch {
    // a refresh never rejects; this is only a guard
  }
}
