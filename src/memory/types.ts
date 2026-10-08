/**
 * types.ts — the transcript model.
 *
 * The conversation is a list of `Entry`. This is a discriminated union on
 * `role`, which is the whole point: the compaction transforms and the wire
 * conversion below switch on `role` exhaustively, so the compiler — not a
 * runtime check — guarantees we never build an impossible message (an assistant
 * tool-call with no calls, a tool result with no id). The fragile invariants
 * that a loosely-typed (e.g. Python) implementation can only *hope* hold —
 * "a tool result must follow the assistant tool-call that spawned it" — become
 * things the types make hard to get wrong.
 *
 * The transcript never contains the system message: that's regenerated each turn
 * (it carries the live shell label and project memory), so storing it would just
 * pin a stale copy. Everything here is plain JSON — the same data that will cross
 * the wire when the engine later moves to a server.
 */
import type { ToolKind } from "../cli/toolDisplay.js";
import type { ToolContext } from "../tools/types.js";

/** One tool call the assistant made, stored so the turn can be replayed. */
export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string; // raw JSON string, as the model emitted it
  /**
   * Opaque provider data for this call, stored so it survives a resume and can be
   * echoed back verbatim. Core never reads it. See `drivers/types.ts` ToolCall.meta —
   * Gemini 3 rejects a follow-up request whose tool call lost its `thought_signature`.
   */
  meta?: Record<string, unknown>;
}

/**
 * One message in the conversation.
 *  - `user`      — something the person said.
 *  - `assistant` — Mindweave's reply; may carry tool calls it wants run.
 *  - `tool`      — one tool's result, tied to the call by `toolCallId`. The model
 *                  only ever sees `content`; `summary`/`detail`/`isError` are the
 *                  display fields captured at run time so a resumed session can
 *                  replay the exact same rows (the ● Tool + ⎿ result/diff) instead
 *                  of dropping all tool activity. They ride along in the JSONL for
 *                  free (JSON.stringify) and are ignored when building the wire
 *                  request (only `content` is sent).
 *  - `summary`   — a compaction summary that replaced older turns; sent to the
 *                  model as a user message (see toChatMessages in the engine).
 */
export type Entry = EntryOf & {
  /**
   * When this entry was first written, in epoch ms.
   *
   * Stamped once, at its first save (see store.ts). It is what lets a RESUMED session
   * judge each file against its own read rather than against whenever the session
   * happened to close — a file touched after the model read it is stale, and without a
   * per-entry time there is nothing to notice that with.
   *
   * Optional because sessions written before it exist and must still load; anything
   * reading it treats an absent stamp as unknown, never as zero.
   */
  ts?: number;
};

type EntryOf =
  | {
      role: "user";
      content: string;
      /** Images the person attached to this message, stored as REFERENCES (path +
       *  media type), never bytes — see `memory/images.ts` for why. Loaded into the
       *  request only while the payload is still live; microcompaction drops the
       *  array once the turn is old, leaving `content` naming the file so the model
       *  keeps the key to ask for it again. Absent on messages with no images. */
      images?: import("./images.js").ImageRef[];
      /** True when the engine wrote this, not the person: the verify, batching and
       *  narration nudges all arrive as `user` messages so the model reads them as
       *  instruction. They must never be mistaken for something the user typed —
       *  the session list showed a nudge as the session's `lastPrompt`, so the
       *  `/continue` picker described a session by a reminder the user never sent. */
      synthetic?: true;
      /**
       * How this message reached the conversation, when it was not simply the next
       * thing said.
       *
       *  - `steered`      — typed while a turn was running and delivered INTO that turn.
       *  - `interrupting` — typed after the user stopped a turn, so it opens a new one.
       *
       * Both mean the model has to be told when it arrived, or a message landing after
       * a round of tool results reads as if it had always been the request. Stored as a
       * flag rather than by rewriting `content`, because the two readers need different
       * things: the wire needs the explanation (see `arrivalNote` in the engine, applied
       * when the request is built), while the chat, the history and the session's own
       * label need exactly what was typed. A message wrapped at rest would replay on
       * `/continue` with the explanation showing, as if the person had typed that too.
       */
      arrival?: "steered" | "interrupting";
    }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRecord[] }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
      summary?: string;
      detail?: string;
      /** How to read `detail`: a real +/- diff, shell output on a rail, or plain text.
       *  Without it a resumed edit replays as dim plain lines — the markers still there,
       *  the colour gone — because `detail` alone does not say what it is. */
      detailKind?: "diff" | "text" | "shell";
      /** This result was shown to the MODEL but never drawn — a routine internal step the
       *  user cannot act on, like a clean diagnostics sweep. Stored because a resume that
       *  does not know a row was hidden replays it, and the screen fills with exactly the
       *  rows the tool went out of its way to suppress. */
      quiet?: boolean;
      /** The row's name and category as the RESULT set them, not as the call implied.
       *  A diagnostics sweep that finds errors renames itself "Build Error" and turns red;
       *  without these the same row replays as a routine "Check", which is the opposite of
       *  what it said at the time. */
      displayName?: string;
      displayKind?: ToolKind;
      /** Paths of images this result produced (a screenshot), so a resumed session can
       *  show the picture in the row again. Display only; the model gets them separately. */
      imagePaths?: string[];
      /** What a web search found or a fetch read, so a resumed session draws the same row.
       *  Display only; see ToolResult.web. */
      web?: import("../tools/types.js").WebDisplay;
      /** One step of testing an app, so a resumed session draws the same test.
       *  Display only; see ToolResult.ui. */
      ui?: import("../tools/types.js").UiDisplay;
      /** The model has real work to do on this result before it can answer (an image
       *  going to vision). The row counts the wait instead of sitting silently finished. */
      awaitsModel?: boolean;
      isError?: boolean;
      /** Absolute paths whose WHOLE content this result carries (see ToolResult). While
       *  this entry is unstubbed the model can see those files; `memory/presence.ts`
       *  reads it. Absent on results that aren't whole-file reads, and on sessions
       *  written before it existed — presence falls back to the call's arguments there.
       *
       *  A LIST because one read_file call can carry several files. Sessions written
       *  before that hold a bare string, so anything reading this must go through
       *  `fullPathsOf` rather than assuming an array. */
      fullContentOf?: string[] | string;
    }
  | { role: "summary"; content: string };

/**
 * The whole-file paths a tool entry carries, as a list.
 *
 * Exists because the field was a single path before read_file could read several files
 * at once, and sessions on disk still hold that shape. Resuming one and silently getting
 * no presence for its reads would make the model re-read files it already has — the
 * exact waste the recording was added to prevent.
 */
export function fullPathsOf(entry: Entry): string[] {
  if (entry.role !== "tool" || !entry.fullContentOf) return [];
  return typeof entry.fullContentOf === "string" ? [entry.fullContentOf] : entry.fullContentOf;
}

/** Lightweight session descriptor for the resume picker (no transcript body). */
export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  firstPrompt: string;
  lastPrompt: string;
  /** What the session is about, from its notes' title (memory/sessionTitle.ts). Absent
   *  until the notes have one; a list falls back to `firstPrompt`. */
  title?: string;
  entryCount: number;
  /**
   * Which model answered in this session.
   *
   * Recorded deliberately rather than inferred. It used to exist only inside callLog
   * entries, which are written only when a session actually spent something, so most
   * sessions carried no attribution at all and questions of the form "did behaviour
   * change, or did the model change?" could not be answered from what was on disk.
   * The last model configured wins: a session that switches provider mid-way is rare
   * and callLog still holds the per-call detail for that case.
   */
  model?: string;
  /** Extra roots added via `/include` (absolute paths, excluding the primary cwd).
   *  Restored on resume so a multi-root workspace survives across sessions. */
  extraRoots?: string[];
  /**
   * What this session has cost so far, accumulated across every turn.
   *
   * Persisted because it was previously computed per turn, rendered once, and thrown
   * away — so "how much did that session spend?" had no answer anywhere on the machine,
   * and no before/after comparison was possible after changing anything about caching.
   *
   * Cache-aware by construction: `billed` counts each token once (misses + output),
   * never the inflated per-call totals that re-count a cached prefix on every tool
   * round. `estimated` is true when NO call in the session reported a cache split, in
   * which case these are inferred and must be shown as approximate.
   */
  spend?: SessionSpend;
  /** Per-call token usage for this session, most recent last. See `CallUsage`. */
  callLog?: CallUsage[];
  /**
   * The measured size of everything sent besides the transcript (Session.contextOverhead),
   * so a reopened session knows how full its context is before its first call. Stored
   * with its model, and used only while that still matches, as in the live session.
   */
  contextOverhead?: { tokens: number; model: string };
  /**
   * Deferred tools surfaced via `find_tools` during this session (ToolContext.activatedTools).
   * Persisted so a resumed session re-advertises them — otherwise a continued session would
   * strip a tool the model was mid-way through using, and it could no longer call it.
   */
  activatedTools?: string[];
  /**
   * The task list (ToolContext.todos). It lived only in memory, so `/continue` started with
   * none, and once its result had been cleared nothing remained to rewrite it from.
   */
  todos?: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[];
  /** What the session did, counted live. See memory/counters.ts. */
  counters?: import("./counters.js").SessionCounters;
  /** A running or finished Marathon on this session. See `dynamo/marathon.ts`. */
  marathon?: import("../dynamo/marathon.js").MarathonState;
}

/**
 * One model call's token usage, as the provider reported it.
 *
 * Kept per CALL, not just per turn, because the totals cannot answer the question people
 * actually ask about a bill. A turn that billed 36K is six calls carrying an 11K prompt
 * or one call carrying 36K; a session that cached 40% of its input did so evenly on every
 * call or entirely on three of seven. Those have different causes and different fixes,
 * and every one of them produces the same turn total.
 */
export interface CallUsage {
  /** When the call's usage was recorded, epoch ms. */
  at: number;
  /** The whole prompt the provider counted, cached part included. */
  prompt: number;
  /** How much of it was served from the provider's cache. */
  hit: number;
  /** How much was fresh, and therefore paid for at full rate. */
  miss: number;
  /** Generated tokens. */
  out: number;
  /**
   * Which model answered.
   *
   * Recorded because a question that should have been trivial — "did batching stop
   * because we changed something, or because the model changed?" — could not be
   * answered at all. Sessions store the transcript and the cost but never said what
   * produced them, and the project's saved model is only ever the CURRENT one, so the
   * history rewrites itself every time someone runs `/model`.
   */
  model: string;
  /**
   * Why the cached prefix did not survive since the previous call, when it did not
   * ("history: message 41 changed"). Without it a low-hit call can only be guessed at.
   */
  broke?: string;
  /** Whether thinking was on for this call, and at what effort. */
  thinking?: boolean;
  effort?: string;
  /**
   * Generated tokens nobody saw: what the provider counted as output minus an estimate
   * of the reply text and tool-call arguments. Hidden reasoning is most of the output of
   * the thinking models people run, and it was not visible anywhere.
   */
  hidden?: number;
  /** Estimated tokens of the per-call tail (rules, plan, notes) sent after the conversation, which never caches. */
  tail?: number;
  /**
   * Set on a call the person did not ask for: the notes update, the compaction summary, the
   * page distiller. The log held only the main conversation's calls, so a third of what a
   * session cost could not be seen.
   */
  aux?: "notes" | "summary" | "fetch";
}

/** Accumulated, cache-aware usage for one session. All token counts are sums; `costUsd`
 *  is priced from the model's own rate table at the time each turn ran. */
export interface SessionSpend {
  /** Tokens counted exactly once: fresh input plus output. Never the per-call totals. */
  billed: number;
  /** Input served from the provider's prompt cache. */
  cacheHit: number;
  /** Fresh input, inclusive of anything written to the cache. */
  cacheMiss: number;
  /** The written slice of `cacheMiss`, billed at the higher write rate where one exists. */
  cacheWrite: number;
  /** Generated tokens. */
  output: number;
  /** Estimated USD, cache-aware. An estimate by nature — list prices, not an invoice. */
  costUsd: number;
  /** Model turns counted into the figures above. */
  turns: number;
  /** True when no call ever reported a cache split, so the split is inferred. */
  estimated: boolean;
}

/**
 * A live session: the conversation plus the working state it needs. One of these
 * exists for the whole chat (the CLI owns it). `cwd` is the project root the
 * session is filed under (fixed); the live working directory lives on
 * `toolContext.cwd` and may move as `run_command` does `cd`.
 */
export interface Session {
  id: string;
  cwd: string;
  createdAt: number;
  transcript: Entry[];
  toolContext: ToolContext;
  /**
   * Everything in the prompt that is NOT the transcript, as last MEASURED from the
   * provider's reported prompt size: the system prompt, every tool schema, the working
   * set block, the relevance map, todos, the governor. The compaction bars ask "how
   * full is the context", so they have to include it — estimating the transcript alone
   * made every bar fire late by however large this is. Undefined until the first call
   * of a session reports usage; the bars fall back to their estimate until then.
   *
   * The MODEL it was measured against is stored with it, and the bars use the figure
   * only when the two still match. A measurement carries a provider's tool-schema
   * serialisation and prompt shape baked in, so switching model silently invalidates
   * it — pairing them means the switch invalidates it by construction instead of
   * relying on someone remembering to clear it.
   */
  contextOverhead?: { tokens: number; model: string };
  /** Contents of the project's MINDWEAVE.md, injected into the system prompt. "" if none. */
  projectMemory: string;
  /**
   * Set when MINDWEAVE.md has been edited and the frozen copy above is behind the file.
   *
   * It is deliberately NOT acted on immediately: re-reading changes the system prompt
   * string, which throws away the entire cached prefix at 1.25x rewrite cost. The flag
   * is cleared at the next point where the cache is being discarded anyway (a
   * compaction), so the refresh rides along for free. See reloadProjectMemory.
   */
  projectMemoryStale?: boolean;
  /**
   * The cross-session memory directory for this project (where MEMORY.md and the
   * topic files live) and the loaded MEMORY.md index. The index is injected into
   * the system prompt each turn; the directory path is given to the model so it
   * can read/grep individual topic files on demand. `memoryIndex` is "" when no
   * memory has been saved yet.
   */
  memoryDir: string;
  memoryIndex: string;
  /**
   * How many EARLIER sessions this project already has on disk, not counting the
   * current one. Surfaced in the system prompt so the model knows its own past
   * work exists and can point the user at `/continue`.
   *
   * Without this it has no way to know: transcripts are on disk but nothing loads
   * or announces them, so asked "what did we do last time?" it would answer that
   * it has no record — while a 70KB transcript of that exact work sat unread. It
   * is a COUNT, not the content: resuming is the user's call, and reading a whole
   * past session into every new one would be enormously wasteful.
   */
  priorSessions: number;
  /**
   * Entries compaction took out of `transcript`, oldest first. For the SCREEN only:
   * never sent to the model, never counted as context. Without them a reopened
   * compacted session showed nothing above its summary. See memory/earlier.ts.
   * `earlierUnsaved` is the part not yet appended to disk.
   */
  earlier?: Entry[];
  earlierUnsaved?: Entry[];
  /**
   * The project orientation snapshot (environment + git + signals + tree),
   * rendered for the system prompt. Captured once at session start — a snapshot
   * in time, like the rest of the startup context. "" if nothing useful.
   */
  projectContext: string;
  /**
   * The per-project governor: standing rules, the skill catalog, and the
   * forbidden deny-list. Loaded at session start from this project's state dir, and
   * RE-READ when those files change on disk — a person editing a rule in their editor
   * is at least as likely as the model writing one, and that edit used to do nothing
   * until restart. Rules + skill catalog are rendered into the system prompt; the
   * forbidden config also rides on `toolContext` for mechanical enforcement.
   */
  governance: import("../governor/types.js").Governance;
  /**
   * Fingerprint of the governance files as of the last load (governor/freshness.ts).
   * Compared at the start of each turn; a difference triggers a reload. Absent means
   * "never stamped", which reloads once and then settles.
   */
  governanceStamp?: string;
  /**
   * Which model answers and how hard it thinks (`/model` + `/think`). Loaded from
   * the project's saved choice at session start (sticky per project); the engine
   * passes it to the provider on every turn. Mutated in place when the user picks.
   */
  modelConfig: import("../dynamo/model.js").ModelConfig;
  /**
   * True when the previous turn finished a task (a todo list completed). The next turn
   * uses it to decide whether a NEW request is a task boundary — at which point the
   * finished task's detail is swept so a weaker model can't drift back to it. Transient
   * session state; rides on the session, not persisted meaningfully.
   */
  taskJustCompleted?: boolean;
  /**
   * Consecutive autocompact failures this session — the circuit-breaker that stops
   * retrying a doomed summarization every turn. Reset to 0 on a clean compaction.
   */
  compactFailures?: number;
  /**
   * The maintained "state of this session" notes (session memory) — a structured,
   * continuously-refreshed document injected into every turn so the model keeps a crisp
   * picture across compaction. Lives outside the transcript (compaction never touches
   * it). "" / undefined until the first update. Persisted as a sidecar notes file.
   */
  sessionMemory?: string;
  /** Transcript token count at the last session-memory update (the refresh watermark). */
  sessionMemoryTokens?: number;
  /** Whether session memory has been initialized (past the warm-up bar) yet. */
  sessionMemoryInit?: boolean;
  /**
   * How many transcript entries the notes were written from, i.e. the boundary between
   * what has been recorded in session memory and what has not.
   *
   * A token watermark cannot serve here. Compacting from the notes has to keep every
   * entry the notes do NOT cover, and "everything after token N" does not name an
   * entry. See `sessionMemoryCompact.ts`.
   */
  sessionMemoryEntries?: number;
  /** Whether the user has been told autocompact gave up for this session. Told once. */
  compactGaveUpTold?: boolean;
  /**
   * When the last model call went out, as epoch ms. In-memory only — deliberately not
   * persisted, because a resumed session's cache is cold regardless of what the file
   * says, and a stale timestamp read back from disk would claim otherwise.
   *
   * Used to tell a warm provider cache from an expired one: past the TTL there is no
   * entry left to invalidate, so microcompaction becomes free. See `cacheLikelyCold`.
   * 0 / undefined means no call has been made yet.
   */
  lastCallAt?: number;
  /** Running cost for this session, accumulated per turn and persisted with the meta.
   *  See `dynamo/spend.ts`; undefined until the first turn completes. */
  spend?: SessionSpend;
  /**
   * Fingerprint of the cacheable prefix as it was last SENT, so the next call can tell
   * whether it still matches. See `dynamo/cacheBreak.ts`.
   *
   * In-memory only, and deliberately not persisted: a resumed session's provider-side
   * cache is gone regardless of what a file says, so restoring a print from disk would
   * claim a match that cannot exist and suppress the one report worth making.
   */
  prefixPrint?: import("../dynamo/cacheBreak.js").PrefixPrint;
  /** Per-call token usage, most recent last. See `CallUsage`. */
  callLog?: CallUsage[];
  /** State of a running or finished Marathon (goal-mode autonomy) — the objective,
   *  how far it's gotten, and how it ended, if it has. See `dynamo/marathon.ts`.
   *  Persisted so a goal survives a restart instead of vanishing mid-run. */
  marathon?: import("../dynamo/marathon.js").MarathonState;
  /** What the session did, counted live and saved with it. See memory/counters.ts. */
  counters?: import("./counters.js").SessionCounters;
  /** SessionStart hooks have run for this live session (not saved: a resume starts again). */
  hooksStarted?: boolean;
}
