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
import type { ModelRequest, StopReason, Usage } from "../drivers/types.js";
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
  "will be given the CURRENT notes and what has happened SINCE they were written, and you " +
  "reply with only the parts of the notes that change.";

/**
 * How the notes writer is told to answer, the same wording in both ways of calling it.
 *
 * It answers with the sections that CHANGED, not the whole document. Writing the whole thing back
 * every time cost as many output tokens as the notes are long (6.5K for a 25 KB document, per
 * refresh, several refreshes in a minute during busy work), and a long enough document no longer
 * fits in one answer at all: the reply was cut off mid-way and thrown away, and the next refresh
 * paid for the same attempt again. A changed section is a few hundred tokens, however long the
 * notes have grown.
 */
const UPDATE_RULES =
  "Reply with ONLY the sections of the notes that need to change, each as its exact \"# Heading\" line " +
  "followed by its new content. Leave out every section with nothing new; an unchanged section must not appear. " +
  "If nothing at all changed, reply: NO CHANGES.\n" +
  "- A section you list REPLACES the one in the notes, so write its complete new content, dense and specific " +
  "(file paths, function names, exact commands, error messages, decisions).\n" +
  "- To add to a section without rewriting it, make the first line of its content APPEND: and write only the new " +
  "lines after it. Use this for the Worklog.\n" +
  "- Never repeat the italic _description_ line under a heading; it is kept for you.\n" +
  `- Keep each section under ~${SESSION_MEMORY_SECTION_TOKENS} tokens: when one grows past that, CYCLE OUT the ` +
  "least important details while preserving the most critical. A section over its budget has to be rewritten shorter.\n" +
  "- Where the new activity contradicts what the notes say, the new activity is right: correct the notes, and do not " +
  "write about the correction.\n" +
  "- ALWAYS keep \"Current State\" accurate to the latest turn — it is what continues the work after compaction.\n" +
  "- Do NOT record facts about the machine that change on their own: process ids, whether an app or server is " +
  "currently running, ports in use, temporary files or database rows that exist only for a test. They are wrong " +
  "within minutes. If one matters, say what was done and when (\"started the dev server at 09:04\"), never that it " +
  "is still so.\n" +
  "- Reply with text only. Do not call any tool. No preamble, no commentary, no code fences.";

/** The `# Heading` lines of the template, in order (pure). */
function templateHeaders(): string[] {
  return SESSION_MEMORY_TEMPLATE.split("\n").filter((l) => l.startsWith("# "));
}

/** One section of a reply: its words replace the section's, or are added to the end of it. */
export interface NotesPatchSection {
  mode: "set" | "append";
  body: string;
}

/** The sections a reply names, in the order it gave them. */
export type NotesPatch = Map<string, NotesPatchSection>;

const DESCRIPTION_LINE = /^_.*_$/;
const NOTHING_CHANGED = /^\W*(no changes?|n\/a|none|nothing (new|to (add|change|update))|unchanged)\b/i;

function stripFences(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && /^\s*```/.test(lines[0]!)) lines.shift();
  while (lines.length > 0 && /^\s*```\s*$/.test(lines[lines.length - 1]!)) lines.pop();
  return lines;
}

/**
 * The sections a reply gave, read as changes to the notes (pure).
 *
 * Only a template heading starts a section, so a model that wraps its answer in a sentence, or
 * writes a "# Something" line of its own inside a section, does not break the parse. A section's
 * words are what follows its heading, minus the italic description line a model is told not to
 * repeat but often does. `truncated` says the reply was cut off by the output limit: the last
 * section is then incomplete and is dropped, rather than written over the real one half-finished.
 */
export function parseNotesPatch(reply: string, truncated = false): NotesPatch {
  const known = new Map(templateHeaders().map((h) => [h.toLowerCase(), h]));
  const raw: { header: string; lines: string[] }[] = [];
  for (const line of stripFences(reply)) {
    const header = known.get(line.trim().toLowerCase());
    if (header) raw.push({ header, lines: [] });
    else raw.at(-1)?.lines.push(line);
  }
  if (truncated) raw.pop();
  const patch: NotesPatch = new Map();
  for (const { header, lines } of raw) {
    const body = [...lines];
    while (body.length > 0 && (body[0]!.trim() === "" || DESCRIPTION_LINE.test(body[0]!.trim()))) body.shift();
    let mode: "set" | "append" = "set";
    const first = body[0]?.match(/^\s*APPEND:?\s*(.*)$/i);
    if (first) {
      mode = "append";
      body[0] = first[1] ?? "";
    }
    const text = body.join("\n").trim();
    if (!text || NOTHING_CHANGED.test(text) && text.length < 40) continue;
    patch.set(header, { mode, body: text });
  }
  return patch;
}

/** Whether a reply says, in words, that there was nothing to change (pure). */
export function saysNothingChanged(reply: string): boolean {
  const text = reply.trim();
  return text.length < 80 && NOTHING_CHANGED.test(text);
}

interface NotesSection {
  header: string;
  /** The italic description line(s) under the heading, as written. */
  description: string;
  body: string;
  /** The section exactly as it was in the document, kept for one nobody touched. */
  raw: string;
}

/** The notes as sections, in document order; anything before the first heading is dropped (pure). */
function splitSections(notes: string): NotesSection[] {
  const known = new Set(templateHeaders().map((h) => h.toLowerCase()));
  const out: { header: string; lines: string[] }[] = [];
  for (const line of notes.replace(/\r\n/g, "\n").split("\n")) {
    if (known.has(line.trim().toLowerCase())) out.push({ header: line.trim(), lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out.map(({ header, lines }) => {
    const body = [...lines];
    const description: string[] = [];
    while (body.length > 0 && (body[0]!.trim() === "" || DESCRIPTION_LINE.test(body[0]!.trim()))) {
      if (body[0]!.trim() !== "") description.push(body[0]!);
      body.shift();
    }
    return { header, description: description.join("\n"), body: body.join("\n").trim(), raw: [header, ...lines].join("\n").trimEnd() };
  });
}

/** A section's tokens, for telling the writer which ones are over their budget (pure). */
export function oversizedSections(notes: string, limit = SESSION_MEMORY_SECTION_TOKENS): string[] {
  return splitSections(notes)
    .filter((sec) => estimateTokens(sec.body) > limit)
    .map((sec) => sec.header.replace(/^#\s*/, ""));
}

/**
 * The notes with a reply's changes folded in (pure). A heading the notes lack is added from the
 * template; a replacement that would throw away most of a long section is refused, so one bad
 * answer cannot empty a record the rest of the notes depend on. `changed` names what was
 * actually written, which is what tells "nothing new" from "an answer nothing could be done with".
 */
export function applyNotesPatch(current: string, patch: NotesPatch): { notes: string; changed: string[]; refused: string[] } {
  const have = new Map(splitSections(current).map((sec) => [sec.header, sec]));
  const template = new Map(splitSections(SESSION_MEMORY_TEMPLATE).map((sec) => [sec.header, sec]));
  const changed: string[] = [];
  const refused: string[] = [];
  const parts: string[] = [];
  for (const header of templateHeaders()) {
    const base = have.get(header) ?? template.get(header)!;
    const change = patch.get(header);
    if (!change) {
      parts.push(have.has(header) ? base.raw : [base.header, base.description].filter(Boolean).join("\n"));
      continue;
    }
    const body = change.mode === "append" ? [base.body, change.body].filter(Boolean).join("\n") : change.body;
    const collapsed = change.mode === "set" && base.body.length > 1_200 && body.length < base.body.length * 0.25;
    if (collapsed || body === base.body) {
      if (collapsed) refused.push(header);
      parts.push(base.raw);
      continue;
    }
    changed.push(header);
    parts.push([base.header, base.description, body].filter(Boolean).join("\n"));
  }
  return { notes: boundSessionMemory(parts.join("\n\n")), changed, refused };
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
 * A request for the notes writer to build on: the main request's system prompt, tools and
 * conversation, the conversation as it stands now. `entries` is how many transcript entries it carries and
 * `last` the one it ends on.
 * The provider holds the beginning of it in its cache; only what the main work has added since is new.
 *
 * The function returns null when it cannot or should not: the cached copy is gone, the conversation was
 * rewritten since, or reading it from the cache would cost more than sending only what is new.
 * `unseenTokens` is what the other way would have to send.
 */
export type SharedPrefix = { request: ModelRequest; entries: number; last: Entry };
export type SharedPrefixFor = (unseenTokens: number) => Promise<SharedPrefix | null>;

/** What the covered end of the transcript says, so a reader of the conversation can find it (pure). */
function boundaryNote(transcript: readonly Entry[], covered: number): string {
  if (covered <= 0) return "nothing: the notes are still empty, so everything above is new";
  const e = transcript[Math.min(covered, transcript.length) - 1];
  if (!e) return "the start";
  const text = (e.role === "assistant" || e.role === "user" || e.role === "summary" ? e.content : "").replace(/\s+/g, " ").trim().slice(0, 100);
  return `the ${e.role} message that begins: "${text}"`;
}

/**
 * Refresh the session notes from what happened since they were written (one model call, thinking
 * off). Mutates `session.sessionMemory` and the coverage marks IN MEMORY only — the CLI persists
 * the notes file, keeping the engine filesystem-pure. Degrade-safe: on any failure the previous
 * notes are kept untouched.
 *
 * Two ways to make the call. When the provider still holds the conversation in its cache and
 * reading it from there is cheaper than sending what is new at full price (`shared`), the call is
 * the main request with one more message on the end: the model reads the real conversation, at the
 * cached price, and the instruction goes after it. Otherwise the call stands alone and is given the
 * entries the notes have not seen. Either way the answer is only the sections that changed.
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
  onUsage?: (usage: Usage) => void,
  shared?: SharedPrefixFor,
): Promise<boolean> {
  const current = session.sessionMemory?.trim() || SESSION_MEMORY_TEMPLATE;
  const covered0 = Math.min(session.sessionMemoryEntries ?? 0, session.transcript.length);
  const tokensOf = (from: number, to: number) => estimateEntriesTokens(session.transcript.slice(from, to));

  // Which snapshot this refresh describes: the whole transcript as it is, or the part of it the
  // last main request carried.
  const fresh = session.transcript.length;
  const unseenNow = tokensOf(Math.max(covered0, fresh - FEED_ENTRIES), fresh);
  const prefix = session.sharedNotesOff ? null : ((await shared?.(unseenNow)) ?? null);
  const upto = prefix ? prefix.entries : fresh;
  if (upto === 0) return false;
  const last = prefix ? prefix.last : session.transcript[upto - 1];
  const covered = Math.min(covered0, upto);
  // Only what the notes have not seen, as far back as one refresh reads. Reading a fixed
  // number of the newest entries instead dropped the middle of anything longer than that.
  const from = Math.max(covered, upto - FEED_ENTRIES);
  const unseen = session.transcript.slice(from, upto);
  if (unseen.length === 0) return false;
  const skipped = from - covered;
  const tokensAtStart = estimateEntriesTokens(session.transcript.slice(0, upto));
  const over = oversizedSections(current);
  const budgetNote = over.length > 0 ? `\nOver their budget and to be rewritten shorter: ${over.join(", ")}.` : "";

  const ask = async (): Promise<{ content: string; stop: StopReason | undefined; usage: Usage | undefined; calls: boolean } | null> => {
    if (prefix) {
      try {
        const model = prefix.request.model ?? session.modelConfig;
        await ensureDriver(model.model);
        const turn = await activeDriver().toolTurn(
          {
            ...prefix.request,
            // The volatile tail is dropped: this message takes its place, right after the cached part.
            context: undefined,
            messages: [
              ...prefix.request.messages,
              {
                role: "user",
                content:
                  `The conversation above is the session the notes describe. Do not continue it and do not call a tool: ` +
                  `this message asks only for an update of the session notes.\n\n` +
                  `NOW: ${new Date().toISOString()}\n\n` +
                  `CURRENT NOTES. They already cover everything up to and including ${boundaryNote(session.transcript, covered)}; ` +
                  `what comes after it is new:\n${current}\n\n${UPDATE_RULES}${budgetNote}`,
              },
            ],
          },
          { signal },
        );
        if (turn.usage) onUsage?.(turn.usage);
        if (turn.content.trim() || turn.toolCalls.length === 0) {
          return { content: turn.content, stop: turn.stop, usage: turn.usage, calls: turn.toolCalls.length > 0 };
        }
        // The model answered with a tool call instead of notes. Not something to keep asking this way.
        session.sharedNotesOff = true;
      } catch {
        if (signal?.aborted) return null;
        // This model or provider would not take the main request as it is: use the plain call.
      }
    }
    // With reasoning off where the model allows it; see dynamo/auxModel.ts.
    // `ensureDriver` first: `activeDriver()` is a plain global, and a sub-agent (or
    // another background aux call) running its own model in between leaves it
    // pointed at THAT provider — this call would then hand ITS model string to the
    // wrong provider's API. See the matching fix + comment in dynamo/engine.ts's
    // summarizeAndSplice, which hit the exact same failure shape.
    //
    // `withTools`: a real (read-only) tool set, attached only if the model already
    // refused a bare call — some free models serve only tool-shaped requests.
    const turn = await withAuxModel(session.modelConfig, async (model, withTools) => {
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
              `:\n${formatTranscriptForSummary(unseen)}\n\n${UPDATE_RULES}${budgetNote}`,
          },
        ],
        model,
        ...(withTools ? { tools: toolSchemas({ readOnlyOnly: true }) } : {}),
      }, { signal }); // Esc reaches this call too; a slow model must not hold a stop open
    });
    if (turn.usage) onUsage?.(turn.usage);
    return { content: turn.content, stop: turn.stop, usage: turn.usage, calls: false };
  };

  try {
    const answer = await ask();
    if (!answer) return failed(session, tokensAtStart);
    const patch = parseNotesPatch(answer.content, answer.stop === "truncated");
    let notes: string;
    if (patch.size === 0) {
      // "Nothing new" is an answer; anything else with no sections in it is not one.
      if (!saysNothingChanged(answer.content)) return failed(session, tokensAtStart);
      notes = session.sessionMemory ?? "";
    } else {
      const applied = applyNotesPatch(current, patch);
      // A reply that only repeats what the notes say is an answer; one whose every change was refused is not.
      if (applied.changed.length === 0 && applied.refused.length > 0) return failed(session, tokensAtStart);
      notes = applied.notes;
      if (applied.changed.length > 0 && !notesAreUsable(session.sessionMemory, notes)) return failed(session, tokensAtStart);
    }
    // The snapshot has to still be the start of the transcript. Compaction, a rewind, /clear
    // and the shedding of old rounds all replace it, and a refresh that began before one of
    // them describes entries that may no longer be where it thinks.
    if (session.transcript[upto - 1] !== last) return false;
    if (notes) session.sessionMemory = notes;
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
  onUsage?: (usage: Usage) => void,
  shared?: SharedPrefixFor,
): Promise<boolean> {
  if (session.sessionMemoryRun) return session.sessionMemoryRun;
  const run: Promise<boolean> = updateSessionMemory(session, signal, onUsage, shared).finally(() => {
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
