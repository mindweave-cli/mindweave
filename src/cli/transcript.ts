/**
 * transcript.ts — the chat transcript as a pure state machine (no React/Ink).
 *
 * A committed/tail drain model, because it fixes the two things that made
 * Mindweave's first streaming cut glitch:
 *
 *  - WHOLE-BLOCK REVEAL, never typewriter. Streamed text tokens accumulate
 *    SILENTLY into `raw`; the assistant block renders nothing until it seals, then
 *    the whole text appears at once. No per-character churn, no half-rendered
 *    markdown.
 *  - A TINY live region. `committed[]` is append-only and feeds Ink's <Static>
 *    (printed once → real terminal scrollback you can scroll). `tail[]` holds only
 *    in-progress blocks. `drain()` moves the finished prefix of the tail into
 *    committed the instant it (and every earlier block) is done — so the
 *    live-rendered region stays a few rows, which is what lets the prompt stay
 *    pinned and the scrollback scroll without jank.
 *
 * App feeds stream events in as Actions and renders `committed` + `tail`. The one
 * invariant: a block only commits once it AND every earlier tail block is done, so
 * a later block can never print before an earlier one.
 */
import { sanitizeStreamText } from "../drivers/registry.js";
import type { ToolKind } from "./toolDisplay.js";
import type { CompactionReport } from "./compaction.js";

export type ToolStatus = "running" | "ok" | "error";

/** One entry in a discovery group (a read/search/list/map call). */
export interface ToolGroupItem {
  toolId: string;
  name: string;
  arg?: string;
  status: ToolStatus;
  /** Action category, for the dot colour. */
  kind?: ToolKind;
  /** The call's one-line result ("195 lines", "12 files"), shown once it resolves. */
  note?: string;
  /** How many things this ONE call covers, when that is not one — `read_file` takes a
   *  list of paths and reads several files at once. The group header counts these rather
   *  than calls, or three files read together announce themselves as one. */
  covers?: number;
}

/** One delegated worker inside a subagent block. */
export interface AgentEntry {
  agentId: string;
  task: string;
  readOnly: boolean;
  status: ToolStatus;
  /** The closing line once done ("3 steps · read-only"), red on failure. */
  summary?: string;
  /** Its own tool calls, streamed live as compact rail items. */
  items: ToolGroupItem[];
}

export type Block =
  | { kind: "user"; id: number; done: boolean; text: string }
  | { kind: "assistant"; id: number; done: boolean; text: string }
  | {
      kind: "tool";
      id: number;
      done: boolean;
      toolId: string;
      /** Display name already mapped (e.g. "Update", "Read", "Run"). */
      name: string;
      /** The telling argument (a filename, a search pattern, a command). */
      arg?: string;
      /** A dim qualifier after the name, e.g. a non-default command timeout. */
      meta?: string;
      /** Action category, for the row's dot colour. */
      action?: ToolKind;
      status: ToolStatus;
      /** One-line result when there's no rich detail (e.g. "195 lines"). */
      summary?: string;
      /** Rich block under the row — an edit diff, file preview, or output. */
      detail?: string;
      /** Whether `detail` is a genuine +/- diff (colour it) or ordinary text (do not).
       *  Absent means text. See ToolResult.detailKind for why this is not inferred. */
      detailKind?: "diff" | "text" | "shell";
      /**
       * When the result landed, for a tool the model has to THINK about before it can
       * speak again — an image handed to vision, which answers far slower than text.
       *
       * Only such a tool sets it. The row counts up from here while the turn is live,
       * so a silence that used to look like nothing happening now shows what is being
       * waited on, and the total is written into the detail once the wait ends.
       */
      since?: number;
      /** Seconds the wait took, once it is over. Absent while it is still running. */
      waited?: number;
      /**
       * When this row's tool STARTED running, so a long command can count up while it
       * works and the user can see it is progressing rather than hung. Set at toolStart;
       * only read while the row is still running, so a resumed (already-finished) row
       * never shows a live count.
       */
      startedAt?: number;
      /** Does this row belong to the turn still in progress? Drives the VERB only
       *  ("Reading" vs "Read"), and is cleared for every row at once by `endTurn`. */
      live?: boolean;
    }
  /** A consolidated group of consecutive discovery calls (reads/searches/maps),
   *  shown as one row naming the burst with a compact list of what it found. */
  | { kind: "tools"; id: number; done: boolean; items: ToolGroupItem[]; live?: boolean }
  /** Sub-agent work, as ONE block however many are delegated at once.
   *
   *  Read-only workers fan out in parallel (see subagent.ts), so two or three can be
   *  live together. As separate blocks they interleaved into an unreadable stripe —
   *  each one's rows landing between the others'. Grouped, the shape of the delegation
   *  is visible: who is doing what, and how far along. Distinct violet identity either
   *  way — these are separate minds working inside the transcript. */
  | { kind: "subagent"; id: number; done: boolean; agents: AgentEntry[] }
  | { kind: "error"; id: number; done: boolean; text: string }
  | { kind: "completion"; id: number; done: boolean; text: string }
  /** A dim meta line (a tool-less activity note or a command header). */
  | { kind: "note"; id: number; done: boolean; text: string }
  /** A set-off, dim context line (compaction / context trimming). */
  | { kind: "context"; id: number; done: boolean; text: string }
  /** A titled block of plain FACTS, on a rail — what an approval is actually about
   *  ("Action: Shell execution / Command: $ git push --force"). Distinct from an
   *  assistant block because Mindweave did not say it: it is a statement of what is
   *  about to happen, and it must not read as chat the user can skim past. */
  | { kind: "notice"; id: number; done: boolean; title: string; body: string }
  /** A compaction pass, with the before/after bars. See cli/compaction.ts for why this
   *  one piece of context machinery is shown when the rest stays invisible. */
  | { kind: "compaction"; id: number; done: boolean; report: CompactionReport };

export interface TranscriptState {
  /** Finished, append-only → <Static> (terminal scrollback). */
  committed: Block[];
  /** In-progress, re-rendered live. Kept tiny by draining. */
  tail: Block[];
  /** Id of the streaming assistant block, if one is open. */
  openAsstId: number | null;
  /** Raw accumulated text for that block (hidden until it seals). */
  raw: string;
  /** toolId → block id, so a tool_end finds its row. */
  toolMap: Record<string, number>;
  /** Monotonic id source. */
  seq: number;
  /** The turn's final reply text (recorded into history on the engine side). */
  lastReply: string;
  /** Has this turn already shown a line of narration? ONE is the budget for a whole
   *  turn, however many tool calls it takes — see sealAssistant. Reset by `user`. */
  narrated: boolean;
}

export type Action =
  | { type: "user"; text: string }
  | { type: "token"; delta: string }
  /** `at`: when the call really started. The row can reach the screen a beat later, and a
   *  running command counts its time from the start, not from when it was shown. */
  | { type: "toolStart"; toolId: string; name: string; arg?: string; meta?: string; action?: ToolKind; group?: boolean; covers?: number; at?: number }
  /** Output from a call that has NOT finished, so a command running for minutes says
   *  what it is doing instead of sitting silent. Carries the latest tail rather than an
   *  increment: the row replaces what it shows, so a dropped update costs nothing and
   *  neither side keeps state the other has to agree with. */
  | { type: "toolProgress"; toolId: string; text: string }
  | {
      type: "toolEnd";
      toolId: string;
      ok: boolean;
      summary?: string;
      detail?: string;
      detailKind?: "diff" | "text" | "shell";
      quiet?: boolean;
      /** This result leaves the model with real work to do before it can answer — an
       *  image going to vision. The row shows the wait rather than sitting silent. */
      awaitsModel?: boolean;
      /** Override the row's category/name — set when the RESULT (not the call) is
       *  what makes this a governor decision rather than an ordinary tool outcome,
       *  discovered only once the call actually runs (see ToolResult.displayKind). */
      action?: ToolKind;
      name?: string;
    }
  // A sub-agent's nested lifecycle: a start opens its rail block, its tool calls fold
  // in as rail items (subTool*), and end collapses it to a summary. Keyed by agentId.
  | { type: "subagentStart"; agentId: string; task: string; readOnly: boolean }
  | { type: "subToolStart"; agentId: string; toolId: string; name: string; arg?: string; action?: ToolKind }
  | { type: "subToolEnd"; agentId: string; toolId: string; ok: boolean; summary?: string }
  | { type: "subagentEnd"; agentId: string; ok: boolean; summary?: string }
  // The turn is over: every tool row still marked `live` drops to its past-tense
  // verb. Nothing else about the rows changes — see endTurn's case below.
  | { type: "endTurn" }
  // The reply gate rejected the draft buffered so far — drop it, so the rewrite that
  // follows streams into a clean block instead of being appended to the draft.
  | { type: "resetReply" }
  | { type: "sealNarration" } // reveal the open narration block (NOT the reply)
  | { type: "finishReply" } // seal the open assistant block AS the turn's reply
  | { type: "error"; text: string }
  | { type: "completion"; text: string }
  | { type: "note"; text: string } // dim meta line (committed directly)
  | { type: "context"; text: string } // a set-off context/compaction line
  | { type: "notice"; title: string; body: string } // titled facts on a rail
  | { type: "compaction"; report: CompactionReport } // a compaction pass, with bars
  | { type: "say"; text: string } // an assistant markdown block, NOT recorded as the reply
  | { type: "clear" }; // /clear — drop the visible conversation, keep the id counter

export function initialState(): TranscriptState {
  return { committed: [], tail: [], openAsstId: null, raw: "", toolMap: {}, seq: 0, lastReply: "", narrated: false };
}

/** Move the contiguous finished prefix of the tail into committed[]. */
function drain(s: TranscriptState): TranscriptState {
  let i = 0;
  while (i < s.tail.length && s.tail[i]!.done) i++;
  if (i === 0) return s;
  return { ...s, committed: s.committed.concat(s.tail.slice(0, i)), tail: s.tail.slice(i) };
}

function patchTail(s: TranscriptState, id: number, fields: Partial<Block>): TranscriptState {
  return { ...s, tail: s.tail.map((b) => (b.id === id ? ({ ...b, ...fields } as Block) : b)) };
}

/**
 * Remove a tool's row entirely — used for a quiet failure, which the user never sees.
 *
 * Two shapes to unwind. A GROUPED call is one item inside a discovery group, so only
 * that item is dropped; if it was the group's last item the empty group goes too, since
 * an "Exploring… (0)" header would be the very noise this is removing. A STANDALONE call
 * owns its whole block, which is dropped outright.
 *
 * The toolMap entry goes as well, so a late or duplicate event for the same id cannot
 * resurrect a row that was deliberately hidden.
 */
function dropTool(s: TranscriptState, toolId: string, blockId: number): TranscriptState {
  const { [toolId]: _gone, ...toolMap } = s.toolMap;
  const block = s.tail.find((b) => b.id === blockId);
  if (block && block.kind === "tools") {
    const items = block.items.filter((it) => it.toolId !== toolId);
    const tail = items.length > 0 ? s.tail.map((b) => (b.id === blockId ? ({ ...b, items } as Block) : b)) : s.tail.filter((b) => b.id !== blockId);
    return drain({ ...s, tail, toolMap });
  }
  return drain({ ...s, tail: s.tail.filter((b) => b.id !== blockId), toolMap });
}

/** Close an open discovery group so it can commit, before any non-grouped event. */
function closeToolGroup(s: TranscriptState): TranscriptState {
  const open = s.tail.find((b) => b.kind === "tools" && !b.done);
  return open ? drain(patchTail(s, open.id, { done: true } as Partial<Block>)) : s;
}

/**
 * Seal the streaming assistant block: finalize its text and commit it, or drop it
 * if it never produced visible prose. `asReply` records the text as the turn's
 * reply (for history); narration sealed by a following tool is not the reply.
 */

/** Sentences of narration SHOWN between tool calls. */
export const NARRATION_LINES = 2;

/**
 * Cut narration to the budget before it reaches the screen.
 *
 * This is a DISPLAY cut, and it is the only version of this rule that actually holds.
 * The prompt asks for two sentences and the engine nudges when it sees more; both are
 * requests, and a model that is mid-deliberation ignores both — measured, repeatedly,
 * with the nudge firing and six-paragraph blocks arriving anyway.
 *
 * The model still receives its own full text, so nothing about its reasoning changes.
 * What changes is that the user reads the first two sentences — the finding and the
 * next step, which is all this position ever carries — instead of the working-out.
 * The reply that ENDS a turn is never touched: that one is the answer.
 */
export function trimNarration(text: string, max = NARRATION_LINES): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  // Sentence ends, plus a blank line or a list bullet — a paragraph break is a
  // sentence boundary here even when the punctuation says otherwise.
  const parts = trimmed.split(/(?<=[.!?])\s+|\n{2,}|\n(?=\s*[-*•]|\s*\d+[.)])/);
  const kept = parts.filter((p) => p.trim()).slice(0, max);
  return kept.length >= parts.filter((p) => p.trim()).length ? trimmed : kept.join(" ").trim();
}
function sealAssistant(s: TranscriptState, asReply: boolean): TranscriptState {
  const id = s.openAsstId;
  if (id == null) return asReply ? { ...s, lastReply: "" } : s;
  const clean = sanitizeStreamText(s.raw);

  // `asReply` is false exactly when a tool call follows this text, so this is narration
  // between steps. It is TRIMMED to a couple of sentences and otherwise left alone.
  //
  // It used to be capped at one block per TURN, which was aimed at a real problem: a
  // 23-call turn printed 24 blocks and said the same thing in four of them. But the cap
  // is the wrong instrument, because it cannot tell a repetitive model from a quiet one.
  // Against a model that narrates sparingly it does nothing but guarantee silence for the
  // rest of a long turn, which is exactly how the tool came to look like it had stopped
  // responding. The per-block trim already bounds the wall; the cap only bounded the
  // conversation.
  const text = asReply ? clean : trimNarration(clean);

  let next: TranscriptState = { ...s, openAsstId: null, raw: "" };
  if (text) next = patchTail(next, id, { text, done: true });
  else next = { ...next, tail: next.tail.filter((b) => b.id !== id) };
  if (asReply) next = { ...next, lastReply: text };
  else if (text) next = { ...next, narrated: true };
  return drain(next);
}

/**
 * Close any wait that is still counting, because the model has just spoken or acted.
 *
 * The number belongs to the gap between handing something over and getting an answer,
 * so it is stopped by the first sign of that answer — a token, or the next tool call —
 * rather than at the end of the turn. Stopping at the turn would fold in every step the
 * model took afterwards and report a wait that never happened.
 *
 * Idempotent: a row that already has its number is left exactly as it is.
 */
function settleWaits(s: TranscriptState): TranscriptState {
  const now = Date.now();
  const settle = (b: Block): Block =>
    b.kind === "tool" && b.since !== undefined && b.waited === undefined
      ? ({ ...b, waited: Math.max(0, Math.round((now - b.since) / 1000)) } as Block)
      : b;
  // BOTH lists, the same as endTurn. A finished tool row drains into `committed` almost
  // immediately, so by the time the model answers, the row holding the clock is no longer
  // in the tail — and a version that only walked the tail left every wait unstamped.
  const tail: Block[] = s.tail.map(settle);
  const committed: Block[] = s.committed.map(settle);
  const changed =
    tail.some((b: Block, i: number) => b !== s.tail[i]) ||
    committed.some((b: Block, i: number) => b !== s.committed[i]);
  return changed ? { ...s, tail, committed } : s;
}

export function reduce(s: TranscriptState, a: Action): TranscriptState {
  switch (a.type) {
    case "clear":
      // Everything the conversation put on screen goes, and `seq` deliberately does
      // NOT. Block ids are React keys: restarting the counter makes the first block of
      // the new conversation collide with a key React has just seen, and Ink reuses the
      // old node instead of mounting a fresh one. Nothing else in the state survives —
      // a half-open assistant block or a toolMap entry pointing at a discarded id would
      // outlive the conversation it belonged to.
      return { ...initialState(), seq: s.seq };
    case "user": {
      // The open tool group is closed FIRST, like every other block that can arrive
      // mid-turn. A user message used to be able to arrive only between turns, when
      // nothing was open; it can now be steered into a running one, and a group left
      // open would keep collecting rows that happened AFTER this line while sitting
      // above it. The group is a claim about what ran together, and that would make it
      // a false one.
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      // The narration budget refills here and nowhere else — including for a message
      // steered mid-turn, which is a new instruction and worth one line of answer.
      return drain({ ...c, seq: id, narrated: false, tail: c.tail.concat({ kind: "user", id, done: true, text: a.text }) });
    }
    case "token": {
      // The model answering IS the end of the wait, and this is the first sign of it.
      s = settleWaits(s);
      // Accumulate SILENTLY — the assistant block renders nothing until it seals,
      // then the whole text appears at once. We still open the block so a later
      // seal can find it. Narration after a discovery burst closes the group.
      let next = closeToolGroup(s);
      let openId = next.openAsstId;
      if (openId == null) {
        openId = next.seq + 1;
        next = {
          ...next,
          seq: openId,
          openAsstId: openId,
          raw: "",
          tail: next.tail.concat({ kind: "assistant", id: openId, done: false, text: "" }),
        };
      }
      return { ...next, raw: next.raw + a.delta };
    }
    case "toolStart": {
      // The next call is also the model having moved on: stop any wait still running.
      s = settleWaits(s);
      // Seal any narration before the tool (commit it) first.
      const sealed = sealAssistant(s, false);

      if (a.group) {
        // A discovery call: fold it into the open group, or open a new one. The
        // group is NOT drained — it stays live so more calls can join it.
        const open = sealed.tail.find((b) => b.kind === "tools" && !b.done);
        if (open && open.kind === "tools") {
          const item: ToolGroupItem = { toolId: a.toolId, name: a.name, arg: a.arg, kind: a.action, status: "running", ...(a.covers ? { covers: a.covers } : {}) };
          return {
            ...sealed,
            toolMap: { ...sealed.toolMap, [a.toolId]: open.id },
            tail: sealed.tail.map((b) =>
              b.id === open.id && b.kind === "tools" ? { ...b, items: [...b.items, item] } : b,
            ),
          };
        }
        const gid = sealed.seq + 1;
        return {
          ...sealed,
          seq: gid,
          toolMap: { ...sealed.toolMap, [a.toolId]: gid },
          tail: sealed.tail.concat({
            kind: "tools",
            id: gid,
            done: false,
            live: true,
            items: [{ toolId: a.toolId, name: a.name, arg: a.arg, kind: a.action, status: "running" }],
          }),
        };
      }

      // A mutating/standalone tool: close any open group, then show it on its own row.
      const closed = closeToolGroup(sealed);
      const id = closed.seq + 1;
      return drain({
        ...closed,
        seq: id,
        toolMap: { ...closed.toolMap, [a.toolId]: id },
        tail: closed.tail.concat({
          kind: "tool",
          id,
          done: false,
          live: true,
          toolId: a.toolId,
          name: a.name,
          arg: a.arg,
          meta: a.meta,
          action: a.action,
          status: "running",
          startedAt: a.at ?? Date.now(),
        }),
      });
    }
    case "toolProgress": {
      const blockId = s.toolMap[a.toolId];
      if (blockId == null) return s;
      const block = s.tail.find((b) => b.id === blockId);
      // Only a standalone row, and only while it is still running. A grouped call folds
      // into a one-line summary that has nowhere to put output, and a row that has already
      // resolved must keep the result it settled on rather than being overwritten by a
      // late tail from before it finished.
      if (!block || block.kind !== "tool" || block.done) return s;
      return patchTail(s, blockId, { detail: a.text, detailKind: "shell" } as Partial<Block>);
    }

    case "toolEnd": {
      const blockId = s.toolMap[a.toolId];
      if (blockId == null) return s;
      const block = s.tail.find((b) => b.id === blockId);
      // A quiet failure never becomes a visible row: the model asked for something it
      // could not have, was told why, and will ask again. Showing "could not edit
      // because…" for a step the agent resolves by itself teaches the user to ignore
      // error rows, which is worse than showing nothing. The model still gets the full
      // reason, and the transcript still records it — this is a display decision only.
      if (a.quiet) return dropTool(s, a.toolId, blockId);
      if (block && block.kind === "tools") {
        // Resolve this item's status in place AND capture its one-line result, so the
        // group list shows what each call found (195 lines / 12 files), not just a name.
        return patchTail(s, blockId, {
          items: block.items.map((it) =>
            it.toolId === a.toolId ? { ...it, status: a.ok ? "ok" : "error", note: a.summary } : it,
          ),
        } as Partial<Block>);
      }
      return drain(
        patchTail(s, blockId, {
          status: a.ok ? "ok" : "error",
          summary: a.summary,
          detail: a.detail,
          detailKind: a.detailKind,
          done: true,
          ...(a.action ? { action: a.action } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.awaitsModel ? { since: Date.now() } : {}),
        }),
      );
    }
    case "error": {
      const sealed = sealAssistant(closeToolGroup(s), false);
      const id = sealed.seq + 1;
      return drain({ ...sealed, seq: id, tail: sealed.tail.concat({ kind: "error", id, done: true, text: a.text }) });
    }
    case "endTurn": {
      // The one moment a tool row is allowed to change after it appears, and it
      // changes by exactly one word: "Reading 2 files" → "Read 2 files". Committed
      // rows are patched as well as tail ones — every block is re-rendered each
      // frame (there is no <Static>), so a row that has already scrolled up still
      // settles into the past tense with the rest of the turn.
      s = settleWaits(s);
      const clear = (b: Block): Block =>
        (b.kind === "tool" || b.kind === "tools") && b.live ? ({ ...b, live: false } as Block) : b;
      return { ...s, committed: s.committed.map(clear), tail: s.tail.map(clear) };
    }
    case "resetReply":
      // Only the buffer, never a committed block: text accumulates into `raw` and is
      // revealed whole on seal, so a draft rejected before it seals was never on screen.
      return { ...s, raw: "" };
    case "sealNarration":
      return sealAssistant(closeToolGroup(s), false);
    case "finishReply":
      return sealAssistant(closeToolGroup(s), true);
    case "completion": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "completion", id, done: true, text: a.text }) });
    }
    case "note": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "note", id, done: true, text: a.text }) });
    }
    case "context": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "context", id, done: true, text: a.text }) });
    }
    case "say": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "assistant", id, done: true, text: a.text }) });
    }
    case "notice": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "notice", id, done: true, title: a.title, body: a.body }) });
    }
    case "compaction": {
      const c = closeToolGroup(s);
      const id = c.seq + 1;
      return drain({ ...c, seq: id, tail: c.tail.concat({ kind: "compaction", id, done: true, report: a.report }) });
    }
    case "subagentStart": {
      const entry: AgentEntry = {
        agentId: a.agentId,
        task: a.task,
        readOnly: a.readOnly,
        status: "running",
        items: [],
      };
      // A worker starting while another is still going JOINS that block rather than
      // opening its own. Read-only workers fan out in parallel, and as separate blocks
      // their rows interleaved into a stripe nobody could follow.
      const open = s.tail.find((b) => b.kind === "subagent" && !b.done);
      if (open && open.kind === "subagent") {
        return patchTail(s, open.id, { agents: [...open.agents, entry] } as Partial<Block>);
      }
      // Otherwise a new nested block: seal any narration, close any open discovery
      // group, then open it. Left LIVE (done:false) so more workers and their tool
      // calls can join it.
      const sealed = closeToolGroup(sealAssistant(s, false));
      const id = sealed.seq + 1;
      return drain({
        ...sealed,
        seq: id,
        tail: sealed.tail.concat({ kind: "subagent", id, done: false, agents: [entry] }),
      });
    }
    case "subToolStart": {
      const item: ToolGroupItem = { toolId: a.toolId, name: a.name, arg: a.arg, kind: a.action, status: "running" };
      return patchAgent(s, a.agentId, (ag) => ({ ...ag, items: [...ag.items, item] }));
    }
    case "subToolEnd": {
      return patchAgent(s, a.agentId, (ag) => ({
        ...ag,
        items: ag.items.map((it) =>
          it.toolId === a.toolId ? { ...it, status: a.ok ? "ok" : "error", note: a.summary } : it,
        ),
      }));
    }
    case "subagentEnd": {
      // The BLOCK is done only when every worker in it is. One finishing while another
      // is mid-flight must not commit the block and strand the other's rows.
      const next = patchAgent(s, a.agentId, (ag) => ({
        ...ag,
        status: a.ok ? "ok" : "error",
        summary: a.summary,
      }));
      const blk = findAgentBlock(next, a.agentId);
      if (!blk) return next;
      const allDone = blk.agents.every((ag) => ag.status !== "running");
      return allDone ? drain(patchTail(next, blk.id, { done: true } as Partial<Block>)) : next;
    }
  }
}

/** The open sub-agent block containing this worker, if one is in the tail. */
function findAgentBlock(s: TranscriptState, agentId: string): (Block & { kind: "subagent" }) | undefined {
  const blk = s.tail.find((b) => b.kind === "subagent" && !b.done && b.agents.some((ag) => ag.agentId === agentId));
  return blk && blk.kind === "subagent" ? blk : undefined;
}

/** Apply a change to ONE worker inside its block, leaving its siblings untouched. */
function patchAgent(
  s: TranscriptState,
  agentId: string,
  change: (agent: AgentEntry) => AgentEntry,
): TranscriptState {
  const blk = findAgentBlock(s, agentId);
  if (!blk) return s;
  return patchTail(s, blk.id, {
    agents: blk.agents.map((ag) => (ag.agentId === agentId ? change(ag) : ag)),
  } as Partial<Block>);
}
