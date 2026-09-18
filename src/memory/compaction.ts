/**
 * compaction.ts — keeping the model sharp as a session grows (pure half).
 *
 * A long transcript hurts two ways: the live task gets buried under stale tool
 * output (a coding model "loses its moment" well before any hard context limit —
 * multi-needle retrieval, which is what recalling a long session actually is,
 * sags long before the storage cap), and on BYOK every wasted token is the
 * user's money. The per-model sharp windows live in the drivers.
 * The cascade, cheapest first:
 *
 *   1. MICROCOMPACT (no model call, lossless): once the transcript passes a low
 *      bar, clear the BODIES of old tool results — keep the last N verbatim — so
 *      the recent working set stays dense. The model can always re-read; a
 *      cleared result leaves a stub saying so. Fires early and often.
 *   2. AUTOCOMPACT (one model call): the backstop. When microcompact can't keep
 *      the transcript under the higher bar, replace the old prefix with a
 *      9-section structured summary and keep the last N turns verbatim. The
 *      engine pairs this with re-reading the working-set files (restoration) so
 *      nothing the model was mid-edit on is lost.
 *
 * This module is PURE — estimation, the microcompact transform, the summary
 * prompt, and the splice. It does no I/O and makes no model calls (the engine
 * owns "when" and the summarizer call), so it stays trivially testable and could
 * run on either side of the future client/server line.
 */
import type { Entry } from "./types.js";
import { fullPathsOf } from "./types.js";
import { estimateImagesTokens } from "./images.js";

// ~3.5 chars/token, deliberately tokenizer-free: triggers need a cheap, stable,
// slightly-conservative proxy, not an exact count (better to compact a touch
// early than to overflow).
const CHARS_PER_TOKEN = 3.5;

// The BARS themselves live in `dynamo/contextWindow.ts` and are derived from the
// driver's sharp window, so they move with the model instead of being frozen here.
// This module used to also export fixed MICROCOMPACT_TOKENS / AUTOCOMPACT_TOKENS
// constants; nothing read them once the engine went model-anchored, and their
// doc comment went on asserting 45K/90K while the live bars were 38K/95K. Deleted
// rather than corrected: a second source of truth for the same number is the
// stale-claim trap in BOUNDARY.md. The env overrides
// (MINDWEAVE_MICROCOMPACT_TOKENS / MINDWEAVE_AUTOCOMPACT_TOKENS) are unaffected —
// the engine reads them directly at the point of use.

/** Tool observations kept verbatim; older ones get their body cleared. Kept deliberately
 *  tight — a weaker model regresses on stale tool noise sooner, so we keep less. */
export const KEEP_LAST_N = 8;

/** At a TASK BOUNDARY (a finished task, a new request) we sweep hard: keep only this
 *  many recent observations, since the finished task's detail is no longer load-bearing. */
export const KEEP_LAST_N_BOUNDARY = 2;

export const CLEARED_STUB =
  "[old tool result cleared to save context — re-read the file/search if you need it again]";

/** Old assistant prose (a "here's what I built" recap) is what a weaker model latches
 *  onto and regresses to. Beyond the recent window we condense these to a stub so a
 *  finished task can't resurface. Only pure-text replies (no tool calls) and only
 *  genuine recaps (long enough) are touched — short acknowledgements stay. */
const RECAP_STUB = "[earlier status update condensed — this work is done; focus on the current task]";
const RECAP_MIN_CHARS = 220;

/** Left behind when an attached image's payload is evicted. Keeps the full PATH, which is
 *  the restoration key: with only a file name the one way back was asking the user, and a
 *  model given a name it cannot open will guess a path instead. */
export const IMAGE_CLEARED_STUB = "was attached here but is no longer in context — open it again with view_image if you need to look at it, or ask me to re-attach it if that path is gone";

/** Edit/write tools whose call INPUT carries bulky content (a whole file, a diff, a
 *  symbol body). Once such an edit is old and its result already cleared, the content
 *  it wrote is dead weight — the live file is in the working set or a re-read away — so
 *  we clear the input too. Done here on the transcript, this is provider-AGNOSTIC —
 *  every model, not just DeepSeek, gets the saving, and it stays correct even once a
 *  provider offers an equivalent feature natively. */
export const CONTENT_CARRYING_TOOLS = new Set(["edit", "write_file", "replace_symbol_body"]);

export const CLEARED_INPUT_NOTE =
  "content cleared to save context — the file's current state is in the working set, or re-read it";

/** Shrink a mutation tool-call's arguments to just its identifying fields (which file
 *  or symbol), dropping the bulky payload. Returns null when there's nothing to do —
 *  malformed JSON, or already cleared (idempotent). Keeps valid JSON so the call stays
 *  well-formed on the wire for every provider. */
function clearMutationArgs(raw: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || obj._cleared) return null;
  const kept: Record<string, unknown> = {};
  for (const key of ["path", "symbol", "name"] as const) {
    if (typeof obj[key] === "string") kept[key] = obj[key];
  }
  kept._cleared = CLEARED_INPUT_NOTE;
  return JSON.stringify(kept);
}

/** Cheap token estimate for a string. */
export function estimateTokens(text: string): number {
  return estimateTokensForChars(text.length);
}

/**
 * The same estimate, from a character COUNT rather than the characters themselves —
 * for callers that are counting a stream as it arrives and never hold the whole string
 * (the live token meter). Same arithmetic, so the two agree by construction.
 */
export function estimateTokensForChars(chars: number): number {
  return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) + 1 : 0;
}

/**
 * Estimated token footprint of a transcript (content + tool-call arguments + attached
 * images + small overhead).
 *
 * Images are counted by AREA, not by the length of their path. A screenshot is a few
 * dozen characters of text and a few thousand tokens of context, so leaving it out
 * would make every compaction bar fire late by exactly the amount that matters most.
 */
export function estimateEntriesTokens(entries: Entry[]): number {
  let total = 0;
  for (const e of entries) {
    total += estimateTokens(e.content) + 4;
    if (e.role === "user" && e.images) total += estimateImagesTokens(e.images);
    if (e.role === "assistant" && e.toolCalls) {
      for (const tc of e.toolCalls) total += estimateTokens(tc.arguments) + estimateTokens(tc.name);
    }
  }
  return total;
}

/**
 * Layer 1: clear the bodies of OLD tool results, keeping the last `keepLastN`
 * intact. Pure — returns a new transcript and how many were cleared.
 *
 * WHAT GOES FIRST, AND WHY. The order below is not taste; it falls out of one rule:
 * evict by RECONSTRUCTIBILITY — the more cheaply an authoritative record elsewhere can
 * regenerate a thing, the sooner it goes, and whatever is left behind must carry the
 * key needed to get it back. So: the inputs of old edit/write calls go first and go to
 * nothing, because the filesystem is the record and the sent body is already dead
 * weight. Then the bodies of old tool results, whose source of truth is external (a
 * file, a command, a search) — to a STUB that keeps the first line, and that first line
 * is the restoration key: it is what makes re-acquisition an ordinary tool call instead
 * of a special mechanism. Then old assistant recaps, reconstructible from the summary
 * layer. The conversation itself is never touched at this layer, because no record
 * anywhere can regenerate intent — summarization is its only admissible compression.
 * And results the model has not acted on yet are never touched at any bar: unacted
 * knowledge is full fidelity or the model is working blind.
 *
 * What it must never touch: user/assistant messages (the actual conversation),
 * the last N tool results (the live working set), and any tool result that
 * hasn't been superseded by a newer assistant tool-call round (the model has not
 * even seen those yet). An already-cleared stub is left alone (idempotent).
 */
export function microcompact(
  entries: Entry[],
  keepLastN: number = KEEP_LAST_N,
  supersededPaths: ReadonlySet<string> = new Set(),
): {
  entries: Entry[];
  cleared: number;
  clearedIds: string[];
  recapsCleared: number;
  inputsCleared: number;
  imagesCleared: number;
} {
  const toolIdx = entries.flatMap((e, i) => (e.role === "tool" ? [i] : []));
  let clearable = new Set(keepLastN > 0 ? toolIdx.slice(0, -keepLastN) : toolIdx);

  // Never clear the most recent tool round — the results after the last
  // assistant tool-call are fresh reads the model hasn't acted on yet.
  let lastRoundStart = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.role === "assistant" && e.toolCalls && e.toolCalls.length > 0) lastRoundStart = i;
  }
  if (lastRoundStart >= 0) {
    clearable = new Set([...clearable].filter((i) => i < lastRoundStart));
  }

  // A file the WORKING SET carries in full is represented twice: once here in the
  // transcript, and once again in the <working_files> block that is rebuilt at the
  // boundary every step. Those copies are not equivalent — the working-set one is
  // current by construction, and the transcript one is a snapshot of whatever the file
  // said when it was read — so the transcript copy is the redundant one, and clearing
  // it costs the model nothing it cannot already see, fresher.
  //
  // This deliberately overrides BOTH protections above. keepLastN and the live-round
  // rule exist so the model is never left blind on something it has not acted on; a
  // file rendered whole at the boundary is the one case where neither concern applies.
  //
  // It also deliberately happens HERE rather than eagerly each turn. Clearing an entry
  // rewrites the transcript, and the transcript is the CACHED half of the request: doing
  // it on an ordinary turn would trade a cheap cached-read for a full prefix rewrite at
  // 1.25x, which is a straight loss. Microcompaction is already discarding that cache,
  // so riding along with it is the version that is actually free.
  if (supersededPaths.size > 0) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // EVERY file the entry carries must be superseded before its body can go. One
      // read of four files is one entry; clearing it because one of the four was
      // re-read would drop the other three out from under the model.
      const carried = e ? fullPathsOf(e) : [];
      if (carried.length > 0 && carried.every((path) => supersededPaths.has(path))) {
        clearable.add(i);
      }
    }
  }

  // Which edit/write tool-call INPUTS to clear: map each clearable RESULT back to the
  // call that produced it; if that call was a content-carrying edit/write, its input is
  // dead weight now too. Keyed off the SAME clearable window, so recent edits stay whole.
  const callNameById = new Map<string, string>();
  for (const e of entries) {
    if (e.role === "assistant" && e.toolCalls) for (const tc of e.toolCalls) callNameById.set(tc.id, tc.name);
  }
  const clearInputIds = new Set<string>();
  for (const i of clearable) {
    const e = entries[i];
    if (e && e.role === "tool") {
      const name = callNameById.get(e.toolCallId);
      if (name && CONTENT_CARRYING_TOOLS.has(name)) clearInputIds.add(e.toolCallId);
    }
  }

  // Old assistant recaps are condensed beyond the recent window — this is what stops a
  // finished task from resurfacing. Recent replies (last keepLastN entries) are kept.
  const recapBoundary = Math.max(0, entries.length - keepLastN);
  // Images additionally respect the live tool round, exactly as tool-result bodies do:
  // whatever the model has not acted on yet is full fidelity or it is working blind,
  // and that rule cannot hold for text and not for pictures.
  const imageBoundary = lastRoundStart >= 0 ? Math.min(recapBoundary, lastRoundStart) : recapBoundary;

  let cleared = 0;
  let recapsCleared = 0;
  let inputsCleared = 0;
  let imagesCleared = 0;
  const clearedIds: string[] = [];
  const out = entries.map((e, i) => {
    // 1) Old tool-result bodies → stub (with first line kept for navigation).
    if (clearable.has(i) && e.role === "tool") {
      if (e.content.includes(CLEARED_STUB)) return e; // already cleared
      cleared++;
      clearedIds.push(e.toolCallId); // so the caller can drop the file from the read ledger
      const firstLine = e.content.split("\n", 1)[0]?.trim() ?? "";
      const stub = firstLine && firstLine.length < 120 ? `${firstLine}\n${CLEARED_STUB}` : CLEARED_STUB;
      return { ...e, content: stub };
    }
    // 2) Old standalone assistant recaps → stub (pure text, no tool calls, long enough).
    //
    // NOT a reply the person answered. "yes please", "B", "go" mean nothing without the
    // proposal they answer, and stubbing that proposal left the model holding an answer
    // to a question it could no longer see. A real session: "yes you can pick that up"
    // answered a reply that became this stub, and the model went on to do far more than
    // was agreed, ending in "i did not tell you to do a whole ass work".
    const answered = entries[i + 1]?.role === "user" && !(entries[i + 1] as { synthetic?: true }).synthetic;
    if (
      i < recapBoundary &&
      e.role === "assistant" &&
      !(e.toolCalls && e.toolCalls.length > 0) &&
      e.content.length >= RECAP_MIN_CHARS &&
      e.content !== RECAP_STUB &&
      !answered
    ) {
      recapsCleared++;
      return { ...e, content: RECAP_STUB };
    }
    // 3) Old edit/write tool-call INPUTS → shrunk to just which file, dropping the
    //    content payload. Its paired result is already being cleared above.
    if (e.role === "assistant" && e.toolCalls && e.toolCalls.some((tc) => clearInputIds.has(tc.id))) {
      const toolCalls = e.toolCalls.map((tc) => {
        if (!clearInputIds.has(tc.id)) return tc;
        const shrunk = clearMutationArgs(tc.arguments);
        if (shrunk == null) return tc;
        inputsCleared++;
        return { ...tc, arguments: shrunk };
      });
      return { ...e, toolCalls };
    }
    // 4) Old image attachments → dropped, leaving a line that names the file.
    //    An image is the most expensive thing a turn can carry (thousands of tokens
    //    for a screenshot, re-sent on EVERY subsequent request) and also the most
    //    perfectly reconstructible: the file is still on disk. The note it leaves is
    //    the path, which is exactly the restoration key the rule above asks for. The
    //    user's own words are untouched — only the payload goes.
    //
    //    The window is `imageBoundary`, which is the recap window ALSO held back to
    //    the last tool round. That last clause is the point: this used to key off the
    //    raw entry index alone, while tool-result bodies key off a window that is
    //    additionally capped at `lastRoundStart`, so an image attached during the
    //    live round could be evicted while every tool result around it was kept —
    //    dropping the picture the model was in the middle of looking at. The comment
    //    here claimed the two windows already matched. They did not.
    if (i < imageBoundary && e.role === "user" && e.images && e.images.length > 0) {
      imagesCleared += e.images.length;
      const names = e.images.map((img) => img.path).join(", ");
      const { images: _dropped, ...rest } = e;
      return { ...rest, content: `${e.content}\n\n[${names} ${IMAGE_CLEARED_STUB}]` };
    }
    return e;
  });

  if (cleared === 0 && recapsCleared === 0 && inputsCleared === 0 && imagesCleared === 0) {
    return { entries: [...entries], cleared: 0, clearedIds: [], recapsCleared: 0, inputsCleared: 0, imagesCleared: 0 };
  }
  return { entries: out, cleared, clearedIds, recapsCleared, inputsCleared, imagesCleared };
}

// Trivial continuations that do NOT open a new task — so a "continue"/"yes" after a
// finished task doesn't trigger a task-boundary sweep (there's no new task to make
// room for; the model is resuming the same one). Pure.
const CONTINUATION_RE =
  /^(continue|keep going|go on|go ahead|proceed|resume|yes|yep|yeah|yup|ok|okay|sure|next|do it|carry on|and\b|also\b)/i;

/** Whether a new user message is a trivial continuation rather than a new task. */
export function isContinuation(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  // A short affirmation/continuation; a long message is treated as a real new request.
  return t.length <= 40 && CONTINUATION_RE.test(t);
}

// The 9-section structured summary. NOT "summarize this" — a forced structure
// that preserves intent, the code touched and why, errors already fixed, and a
// verbatim next step, so the loop resumes across the boundary as if nothing
// happened.
export const SUMMARY_SYSTEM_PROMPT =
  "You are compacting a software-engineering conversation so it can continue " +
  "without losing context. Produce a STRUCTURED summary — not a paragraph. Be " +
  "precise and concrete; this summary REPLACES the older transcript, so anything " +
  "you omit is gone.";

export const SUMMARY_REQUEST = `Summarize the conversation so far into these nine numbered sections, in order:

1. Primary Request & Intent — what the user is ultimately trying to build or solve, in their own framing.
2. Key Technical Concepts — frameworks, patterns, files, and decisions that matter.
3. Files & Code — every file touched or discussed, with the relevant snippet(s) AND why each matters. Keep code that future edits depend on.
4. Errors & Fixes — each error hit and how it was resolved, so it is not repeated.
5. Problem Solving — approaches tried, what worked, what was ruled out.
6. All User Messages — list every non-tool message the user sent, as close to verbatim as possible.
7. Pending Tasks — what still needs doing.
8. Current Work — exactly what was happening right before this summary, including the specific file/line/command in flight.
9. Next Step — the single most likely next action; quote the relevant user instruction verbatim so intent does not drift.

Think first inside <analysis>…</analysis> (which will be discarded), then output the nine sections.`;

// Prepended to the summary when the compacted transcript resumes, so the model
// continues seamlessly instead of narrating that a summary happened.
const RESUME_PREFIX =
  "[Earlier conversation summarized to save context. Continue as if the break " +
  "never happened — do not acknowledge the summary or recap it.]\n\n";

/** Render a transcript into plain text for the summarizer's single user turn. */
export function formatTranscriptForSummary(entries: Entry[]): string {
  return entries
    .map((e) => {
      if (e.role === "tool") return `=== TOOL RESULT ===\n${e.content}`;
      if (e.role === "assistant") {
        const calls = e.toolCalls?.length
          ? `\n[called: ${e.toolCalls.map((c) => c.name).join(", ")}]`
          : "";
        return `=== ASSISTANT ===\n${e.content}${calls}`;
      }
      return `=== ${e.role.toUpperCase()} ===\n${e.content}`;
    })
    .join("\n\n");
}

/**
 * Strip the model's <analysis> scratchpad, keeping only the nine sections.
 *
 * Handles the UNCLOSED case too, which is what a cut-off reply looks like: an opening
 * tag with no closing one means the answer stopped mid-scratchpad, so everything from
 * that tag onward is thinking rather than summary. Without this, a truncated reply
 * strips to nothing and the model's raw reasoning becomes the record of the session.
 */
export function stripAnalysis(summary: string): string {
  const closed = summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  const dangling = closed.indexOf("<analysis>");
  return (dangling === -1 ? closed : closed.slice(0, dangling)).trim();
}

/**
 * Decide whether a summarizer reply may replace the transcript. Returns the usable
 * summary, or null to reject it. Pure.
 *
 * This is the single most destructive operation in the system: it throws away the
 * conversation and keeps what comes back instead. So the reply is treated as
 * UNTRUSTED, and every way it can be unusable is checked in one place:
 *
 *   - `truncated` — the reply hit the output ceiling mid-summary. It looks exactly
 *     like a finished one (see StopReason), and accepting it discards the real
 *     transcript in favour of half a summary.
 *   - all scratchpad — the prompt asks the model to think inside <analysis> first, so
 *     a reply that never got past thinking is non-empty before stripping and empty
 *     after. Checking emptiness on the RAW text let that through, and the transcript
 *     was replaced with a heading and nothing else.
 *   - empty or trivial — nothing usable came back.
 *
 * Rejecting is always safe: the caller keeps the full transcript and counts a failure.
 * Compacting late costs tokens; compacting into nothing costs the session.
 */
const MIN_SUMMARY_CHARS = 40;

/** Numbered sections the reply must show before it is believed to be a summary. */
const MIN_SUMMARY_SECTIONS = 2;

/**
 * How many DISTINCT numbered markers the text carries (pure).
 *
 * Deliberately loose: markers are counted anywhere rather than only at the start of
 * a line, so a summary that arrives on one line still passes. The job is telling a
 * structured answer apart from a sentence of prose, not grading the structure.
 */
function numberedSections(text: string): number {
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)(\d)[.)]\s/g)) seen.add(m[1]!);
  return seen.size;
}

export function usableSummary(content: string, stop?: string): string | null {
  // Accept only a CLEAN finish. This was a list of bad stop reasons containing
  // exactly one of them, `truncated`, while the type carries four: a refusal, an
  // overflow, and an overloaded provider all returned text that passed every check
  // below and replaced the conversation. Naming the good case instead means a stop
  // reason added by a future driver fails safe rather than passing by omission —
  // absent still means `end`, which is what a provider means by saying nothing.
  if (stop !== undefined && stop !== "end") return null;
  const cleaned = stripAnalysis(content);
  if (cleaned.length < MIN_SUMMARY_CHARS) return null;
  // A refusal is fluent, well over the length floor, and structurally nothing like
  // the nine numbered sections that were asked for. Length alone could not tell them
  // apart, and the reply is trusted to REPLACE the session.
  if (numberedSections(cleaned) < MIN_SUMMARY_SECTIONS) return null;
  return cleaned;
}

/**
 * Layer 2 apply: replace the old prefix with the summary, keep the last
 * `keepLastN` entries verbatim. Pure.
 *
 * The kept tail must start on a clean boundary — a `tool` entry is only valid
 * immediately after the assistant `toolCalls` that produced it, so if the cut
 * lands mid-round we drop the orphaned leading tool results (their parent turn
 * is captured in the summary). The discriminated union makes this check exhaustive.
 */
export function spliceSummary(
  entries: Entry[],
  summary: string,
  keepLastN: number = KEEP_LAST_N,
): Entry[] {
  let tail = keepLastN > 0 ? entries.slice(-keepLastN) : [];
  while (tail.length > 0 && tail[0].role === "tool") tail = tail.slice(1);
  const summaryEntry: Entry = { role: "summary", content: RESUME_PREFIX + stripAnalysis(summary) };
  return [summaryEntry, ...tail];
}

/**
 * Split the transcript at API-ROUND boundaries: one group per model round-trip.
 *
 * A boundary fires when a NEW assistant entry begins, because that is the one split
 * point the wire format guarantees is safe. Every tool result must be resolved before
 * the next assistant turn, so a group that starts at an assistant carries that
 * assistant's tool calls AND their results together — pairing validity falls out of the
 * boundary rather than needing to be checked.
 *
 * The first group is the preamble (whatever precedes the first assistant entry: the
 * opening user message, a restored summary). Every later group starts with an assistant.
 *
 * Rounds, not entries, is the unit that matters when something has to be DROPPED: a
 * single round with six parallel tool calls is seven entries, so counting entries can
 * cut a round in half or keep one round while claiming to keep eight things.
 */
export function groupByRound(entries: readonly Entry[]): Entry[][] {
  const groups: Entry[][] = [];
  let current: Entry[] = [];
  for (const e of entries) {
    if (e.role === "assistant" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(e);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Fallback share of the conversation to drop when the provider gave no token gap. */
const OVERFLOW_DROP_SHARE = 0.2;

/**
 * Drop the OLDEST whole rounds so an over-long conversation fits, keeping the newest.
 *
 * The failure this exists for: the provider refuses the request because the prompt no
 * longer fits, and the turn simply ends. The user is told to compact by hand, mid-task,
 * having already paid for the refused call. Dropping the oldest rounds and retrying is
 * what turns that into a recoverable hiccup.
 *
 * `tokenGap` is how much the request overshot, when the provider says so; rounds are
 * dropped until that much is reclaimed. Without it, drop a fixed share — enough to make
 * progress, small enough not to throw away a conversation to fix a slight overrun.
 *
 * ALWAYS keeps at least one group. It cannot return a sequence starting with an orphaned
 * tool result, and that is a property of the SPLIT rather than a check performed here:
 * every group after the first begins with an assistant entry, so whatever survives
 * begins with one too. A defensive strip was written here first and deleted — it could
 * never fire, and an unreachable guard reads as protection while providing none.
 */
export function dropOldestRounds(
  entries: readonly Entry[],
  tokenGap?: number,
  estimate: (e: Entry[]) => number = estimateEntriesTokens,
): Entry[] | null {
  const groups = groupByRound(entries);
  if (groups.length < 2) return null;

  let dropCount = 0;
  if (tokenGap !== undefined && tokenGap > 0) {
    let freed = 0;
    for (const g of groups) {
      freed += estimate(g);
      dropCount++;
      if (freed >= tokenGap) break;
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * OVERFLOW_DROP_SHARE));
  }
  dropCount = Math.min(dropCount, groups.length - 1);
  if (dropCount < 1) return null;

  const kept = groups.slice(dropCount).flat();
  return kept.length > 0 ? kept : null;
}

/**
 * The summary request, optionally pointed at what the user cares about.
 *
 * `/compact focus on the auth work` used to be discarded without a word. It is a real
 * feature — the person compacting usually knows which thread they are about to keep
 * working on, and the summarizer does not.
 *
 * The focus is ADDITIVE and says so twice, because the failure mode here is severe and
 * silent: this summary REPLACES the older transcript, so a model that reads "focus on
 * X" as "only keep X" destroys the rest of the session permanently. The instruction
 * therefore never narrows the nine sections, it only ranks detail within them.
 *
 * The user's text is quoted rather than interpolated bare so an instruction that looks
 * like a directive to the summarizer ("ignore the sections above") reads as something
 * the user said, not as something the system is asking for.
 */
export function summaryRequest(focus?: string): string {
  const wanted = focus?.trim();
  if (!wanted) return SUMMARY_REQUEST;
  return (
    `${SUMMARY_REQUEST}\n\n` +
    `The user asked for this summary with a particular focus, quoted here: "${wanted}".\n` +
    `Give that subject the most detail. Do NOT drop or shorten any of the nine sections ` +
    `to make room for it — this summary replaces the older transcript, so anything left ` +
    `out is gone regardless of the focus.`
  );
}
