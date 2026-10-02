/**
 * sessionMemory.ts — a continuously-maintained, structured "state of the session"
 * that survives every compaction.
 *
 * The problem it solves: even with good compaction, a very long session slowly loses
 * fidelity — each summary is a lossy pass over the previous summary. Session memory
 * breaks that: a small, structured notes document (Current State, Task, Files, Errors,
 * Learnings, Worklog) is refreshed at natural breaks as the conversation grows, and is
 * injected into every turn's context. Because it's maintained OUTSIDE the transcript,
 * microcompact/autocompact never touch it — so after any number of compactions the
 * model still has a crisp, current picture of what it's doing and what already failed.
 *
 * It is distinct from the other memories:
 *   - MINDWEAVE.md  = durable project facts the user/model curate (spans sessions).
 *   - auto-memory = cross-session typed notes (spans sessions).
 *   - session memory = THIS session's live working state (dies with the session).
 *
 * The pure parts (the update trigger, rendering, bounding) are unit-tested; the update
 * itself is one cheap model call, degrade-safe (a failure keeps the last good notes).
 */
import { withAuxModel } from "../dynamo/auxModel.js";
import type { Session } from "./types.js";
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
/** Refresh the notes after this much further growth (token-gated). */
const UPDATE_THRESHOLD = env("MINDWEAVE_SESSION_MEMORY_UPDATE", 12_000);
/** How many recent transcript entries feed an update (the notes carry the older state). */
const RECENT_ENTRIES = env("MINDWEAVE_SESSION_MEMORY_RECENT", 40);
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
  "will be given the CURRENT notes and the RECENT conversation. Return the COMPLETE updated " +
  "notes document. Rules:\n" +
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
  "Output ONLY the notes document — no preamble, no commentary, no code fences.";

const UPDATE_REQUEST =
  "Update the notes with anything new from the recent conversation, then output the full " +
  "updated notes document (same section headers and italic descriptions, dense, concise).";

/**
 * Whether to refresh the notes now (pure). The token threshold is ALWAYS the gate,
 * so updates don't fire too often; before the first update we wait for the
 * session to warm past the init bar.
 */
export function shouldUpdateSessionMemory(
  currentTokens: number,
  lastUpdateTokens: number,
  initialized: boolean,
): boolean {
  if (!initialized) return currentTokens >= INIT_THRESHOLD;
  return currentTokens - lastUpdateTokens >= UPDATE_THRESHOLD;
}

/** The injected block (volatile tail — it changes as it's refreshed, so it must NOT
 *  sit in the cached prefix). "" when there are no notes yet. */
export function renderSessionMemory(notes: string): string {
  const trimmed = notes.trim();
  if (!trimmed) return "";
  return (
    "Your maintained notes on THIS session's state (kept current across compaction — " +
    "trust these for what's done, what's in flight, and what already failed):\n" +
    `<session_memory>\n${trimmed}\n</session_memory>`
  );
}

/** Keep the notes under budget: if the model over-produces, trim to the cap (pure). */
export function boundSessionMemory(notes: string, maxTokens: number = SESSION_MEMORY_MAX_TOKENS): string {
  if (estimateTokens(notes) <= maxTokens) return notes;
  const maxChars = Math.floor(maxTokens * 3.5);
  return notes.slice(0, maxChars).trimEnd() + "\n\n(notes truncated to stay within budget)";
}

/**
 * Refresh the session notes from the recent transcript (one cheap model call, thinking
 * off). Mutates `session.sessionMemory` + the token watermark IN MEMORY only — the CLI
 * persists the notes file, keeping the engine filesystem-pure. Degrade-safe: on any
 * failure the previous notes are kept untouched.
 */
export async function updateSessionMemory(session: Session, signal?: AbortSignal): Promise<boolean> {
  const recent = session.transcript.slice(-RECENT_ENTRIES);
  if (recent.length === 0) return false;
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
    const { content } = await withAuxModel(session.modelConfig, async (model, withTools) => {
      await ensureDriver(model.model);
      return activeDriver().toolTurn({
        system: UPDATE_SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `CURRENT NOTES:\n${current}\n\n` +
              `RECENT CONVERSATION:\n${formatTranscriptForSummary(recent)}\n\n${UPDATE_REQUEST}`,
          },
        ],
        model,
        ...(withTools ? { tools: toolSchemas({ readOnlyOnly: true }) } : {}),
      }, { signal }); // Esc reaches this call too; a slow model must not hold a stop open
    });
    const notes = content.trim();
    if (!notes) return false;
    session.sessionMemory = boundSessionMemory(notes);
    session.sessionMemoryTokens = estimateEntriesTokens(session.transcript);
    // The boundary compaction-from-notes splits on: everything up to here is written
    // down, everything after it has to be kept verbatim. Recorded at the same moment
    // as the notes so the two can never describe different transcripts.
    session.sessionMemoryEntries = session.transcript.length;
    session.sessionMemoryInit = true;
    return true;
  } catch {
    return false; // keep the last good notes
  }
}
