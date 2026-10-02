/**
 * client.ts — the Anthropic wire layer.
 *
 * The single place that knows how to talk to Anthropic's Messages API. Nothing
 * above the driver knows about URLs, headers, or keys.
 *
 * This is a bigger translation than an OpenAI-compatible provider needs, because
 * the stored transcript and Anthropic's wire format disagree in five places:
 *
 *   1. `system` is a top-level request field, not the first message.
 *   2. Assistant tool calls are `tool_use` content BLOCKS, and their arguments are
 *      a parsed object — the transcript stores them as a JSON string.
 *   3. Tool results are `tool_result` blocks inside a USER message; there is no
 *      `role: "tool"`.
 *   4. All results from one assistant turn must arrive in a SINGLE user message.
 *      The transcript records them as consecutive `role: "tool"` entries, so runs
 *      of them are coalesced here. Splitting them would quietly teach the model to
 *      stop making parallel tool calls.
 *   5. Caching is explicit: `cache_control` breakpoints mark the stable prefix,
 *      where an OpenAI-compatible provider just caches the longest identical one.
 *
 * All of that is format. None of it changes what the model is asked to do — the
 * system prompt is the same bytes here as on any other provider.
 */
import Anthropic from "@anthropic-ai/sdk";
import { basename } from "node:path";
import { clientId } from "../clientId.js";
import { RETRY_MAX_ATTEMPTS } from "../retryPolicy.js";
import { isAbortLike } from "../retryPolicy.js";
import { salvagePartialTurn } from "../partialTurn.js";
import { extractSearch, SEARCH_MAX_USES, SEARCH_SYSTEM } from "../searchBlocks.js";
import { cacheBreakpoints, needsLadder } from "./cachePoints.js";
import type {
  ModelRequest,
  SearchOptions,
  SearchResult,
  StreamEvent,
  StreamOptions,
  StreamResult,
  ToolCall,
  StopReason,
  Turn,
  TurnOptions,
  Usage,
} from "../types.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, surfaceOf } from "./manifest.js";

const MODEL = process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;

/** Output ceiling. This caps thinking AND answer together, so it needs headroom
 *  at the higher effort levels. The current-surface models accept up to 128K when
 *  streaming; Haiku 4.5 caps at exactly this number, which is why it is the value
 *  chosen rather than anything larger — one ceiling that is legal on all of them. */
const MAX_TOKENS_STREAM = 64_000;
/** Buffered calls are the small internal ones (summaries, page distillation), and
 *  a non-streaming request that runs long risks an HTTP timeout. The value lives
 *  in the manifest because core reserves room for it when setting the compaction
 *  bars — one constant, so the request and the reservation can't drift apart. */
const MAX_TOKENS_BUFFERED = BUFFERED_OUTPUT_TOKENS;

let client: Anthropic | null = null;
/** The key `client` was built with. A different live key (switched with /key, or by the
 *  app's key manager) rebuilds it; the old code kept the first key for the whole process. */
let clientKey: string | undefined;

/** The shared SDK client, or a clear setup error if no key is configured yet. */
function api(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!client || apiKey !== clientKey) {
    if (!apiKey) {
      throw new Error(
        "No ANTHROPIC_API_KEY found. Add your key to the global config so Mindweave works " +
          "in every project:\n" +
          "  ~/.mindweave/.env  →  ANTHROPIC_API_KEY=your-key-here\n" +
          "(A per-project .env or an exported shell variable also works.)",
      );
    }
    // Retries made explicit rather than inherited. These two drivers reach their
    // provider through a vendor SDK that retries on its own, while the other eleven
    // go through `openaiCompat/wire.ts` and use `retryPolicy.ts`. Pinning the count
    // here means a session behaves the same way whichever provider it is pointed at,
    // and that an SDK upgrade changing its default cannot quietly change ours.
    client = new Anthropic({ apiKey, maxRetries: RETRY_MAX_ATTEMPTS - 1, defaultHeaders: { "User-Agent": clientId() } });
    clientKey = apiKey;
  }
  return client;
}

/** Parse a tool call's stored JSON-string arguments into the object the API wants.
 *  A malformed string becomes an empty object rather than failing the whole turn. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Convert the stored transcript into Anthropic messages, coalescing each run of
 * tool results into one user message (see note 4 in the header).
 *
 * Any system message that sneaks into the conversation is pulled out and returned
 * separately: Anthropic has no in-conversation system role, and dropping it would
 * silently lose instructions.
 */
export function renderMessages(req: ModelRequest): {
  messages: Anthropic.MessageParam[];
  extraSystem: string[];
} {
  const messages: Anthropic.MessageParam[] = [];
  const extraSystem: string[] = [];
  let pendingResults: Anthropic.ToolResultBlockParam[] = [];

  const flushResults = () => {
    if (pendingResults.length === 0) return;
    messages.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };

  for (const msg of req.messages) {
    if (msg.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: msg.content || "(no output)",
      });
      continue;
    }
    flushResults();

    if (msg.role === "system") {
      if (msg.content.trim()) extraSystem.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      // Images first: the model reads an image-then-text message more reliably than
      // the reverse, and each one is labelled so a later turn can refer to it by name.
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const img of msg.images ?? []) {
        blocks.push({ type: "text", text: `Image (${basename(img.path)}):` });
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data },
        });
      }
      if (msg.content.trim()) blocks.push({ type: "text", text: msg.content });
      if (blocks.length > 0) messages.push({ role: "user", content: blocks });
      continue;
    }

    // Assistant: prose and/or tool calls, in that order.
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (msg.content.trim()) blocks.push({ type: "text", text: msg.content });
    for (const call of msg.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseArgs(call.function.arguments),
      });
    }
    if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
  }
  flushResults();

  return { messages, extraSystem };
}

/** Mark one message's last content block as a cache breakpoint. */
function markAt(messages: Anthropic.MessageParam[], idx: number): void {
  const msg = messages[idx];
  if (!msg || typeof msg.content === "string") return;
  const block = msg.content[msg.content.length - 1];
  if (block && typeof block === "object") {
    (block as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
  }
}

/**
 * Attach cache breakpoints so the conversation so far is served from cache next turn.
 *
 * A LADDER, not a single mark, and that is a bug fix rather than a refinement. A
 * breakpoint searches backward only 20 content blocks for a prior entry; an agentic
 * round with a few parallel tool calls adds `tool_use` + `tool_result` blocks fast
 * enough to push the previous entry out of that window, after which every request
 * silently re-pays for the whole conversation. See `cachePoints.ts`.
 *
 * Short conversations still get exactly one mark: below the spacing there is nowhere
 * else useful to put one, and the budget is better left unspent than spent inside a
 * window a single breakpoint already covers.
 */
function markStablePrefix(messages: Anthropic.MessageParam[]): void {
  const blockCounts = messages.map((m) => (typeof m.content === "string" ? 1 : m.content.length));
  if (!needsLadder(blockCounts)) {
    markAt(messages, messages.length - 1);
    return;
  }
  for (const idx of cacheBreakpoints(blockCounts)) markAt(messages, idx);
}

/** Translate the tool schemas from their stored OpenAI shape. */
function renderTools(req: ModelRequest): Anthropic.Tool[] {
  return (req.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Build the request body shared by both paths.
 *
 * Cache breakpoints go in two places, well under the four allowed: one on the last
 * system block (which covers the tools rendered before it) and one on the last
 * stable message. The volatile `context` is appended AFTER both, so a changing code
 * map or todo list never invalidates the prefix — the property the ModelRequest
 * split exists to guarantee.
 */
/**
 * The thinking budget sent on the LEGACY surface (Haiku 4.5), which asks for a
 * token count instead of an effort rung.
 *
 * Half the output ceiling, and the API's own two constraints decide the shape: the
 * budget must be strictly below `max_tokens` (it is spent from the same allowance
 * as the answer, so an equal budget leaves nothing to answer with) and at least
 * 1024. Deriving it from the ceiling rather than fixing it means the small buffered
 * calls get a small budget and a streamed turn gets a real one.
 *
 * Those two constraints can contradict each other: below a ceiling of 1025 there is
 * no number that satisfies both. That returns 0, meaning "no room to think here",
 * and the caller omits the field rather than sending a value the API would reject.
 * Neither of this driver's real ceilings is anywhere near that, but a caller passing
 * a small one should get a working request, not a 400.
 */
export function thinkingBudget(maxTokens: number): number {
  const budget = Math.max(1024, Math.floor(maxTokens / 2));
  return budget < maxTokens ? budget : 0;
}

/**
 * Put the reasoning selection on the body in the shape THIS model accepts.
 *
 * The three branches are the three wire surfaces described in `manifest.ts`, and
 * each rejects the other two's shape outright rather than ignoring it:
 *
 *   - Fable 5 thinks unconditionally and rejects any explicit `thinking` config,
 *     `{type:"disabled"}` included, so the field is simply omitted.
 *   - Haiku 4.5 predates adaptive thinking and `effort` both: it takes a token
 *     budget, and sending `output_config` is an error.
 *   - Everything else takes adaptive thinking plus an effort rung.
 *
 * `normalize` has already made the config legal for the model (Fable never arrives
 * here with thinking off, Opus 5 never with no-thinking above `high`), so this only
 * has to render it.
 */
function applyReasoning(
  body: Anthropic.MessageCreateParamsNonStreaming,
  model: string,
  cfg: ModelRequest["model"],
  maxTokens: number,
): void {
  const surface = surfaceOf(model);

  if (!surface.canDisableThinking) {
    // The model is always thinking; `disabled` and a token budget are both 400s.
    // `adaptive` is its own mode restated, and is sent only to ask for the text of
    // its between-tool-call progress updates, which is empty by default. Reasoning
    // stays hidden under `updates`. See `progressRequestOptions` for the beta header.
    if (surface.progressUpdates) {
      // The SDK's types predate the `updates` value; the wire accepts it with the header.
      body.thinking = { type: "adaptive", display: "updates" } as unknown as Anthropic.ThinkingConfigParam;
    }
  } else if (!surface.takesEffort) {
    const budget = thinkingBudget(maxTokens);
    if (cfg?.thinking && budget > 0) body.thinking = { type: "enabled", budget_tokens: budget };
  } else if (cfg?.thinking) {
    // A model that writes progress updates is asked for their text; the rest just think.
    body.thinking = surface.progressUpdates
      ? ({ type: "adaptive", display: "updates" } as unknown as Anthropic.ThinkingConfigParam)
      : { type: "adaptive" };
  } else {
    // Sonnet 5.5 rejects `disabled`; its lowest setting is `between_tools`, which takes no
    // other field. The SDK's types predate it. `normalize` has already kept the effort at
    // `high` or below, the only range it accepts.
    body.thinking =
      surface.thinkingOff === "between_tools"
        ? ({ type: "between_tools" } as unknown as Anthropic.ThinkingConfigParam)
        : { type: "disabled" };
  }

  if (surface.takesEffort) body.output_config = { effort: cfg?.effort ?? "high" };
}

/** The beta that makes `thinking.display: "updates"` legal. Without it that value is a 400. */
export const PROGRESS_UPDATES_BETA = "thinking-display-updates-2026-08-18";

/** Per-request options for a body from `buildBody`: the beta header rides along exactly
 *  when the body asks for progress updates, so the two can never disagree. */
export function progressRequestOptions(
  body: Anthropic.MessageCreateParamsNonStreaming,
  signal?: AbortSignal,
): Anthropic.RequestOptions {
  const updates = (body.thinking as { display?: string } | undefined)?.display === "updates";
  return { signal, ...(updates ? { headers: { "anthropic-beta": PROGRESS_UPDATES_BETA } } : {}) };
}

export function buildBody(req: ModelRequest, maxTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  const cfg = req.model;
  const { messages, extraSystem } = renderMessages(req);

  const systemText = [req.system, ...extraSystem].filter((s) => s.trim()).join("\n\n");
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
  ];

  markStablePrefix(messages);

  if (req.context && req.context.trim()) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `<current_context>\n${req.context}\n</current_context>` }],
    });
  }
  // Anthropic rejects an empty conversation; the engine never sends one, but a
  // tool-less internal call could in principle.
  if (messages.length === 0) {
    messages.push({ role: "user", content: [{ type: "text", text: "(no input)" }] });
  }

  const model = cfg?.model ?? MODEL;
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
  };
  // How reasoning is expressed differs by model; the sampling parameters do not —
  // `temperature`, `top_p` and `top_k` are rejected across this lineup, so none of
  // them is ever sent on any path.
  applyReasoning(body, model, cfg, maxTokens);

  const tools = renderTools(req);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }
  return body;
}

/** Fold Anthropic's usage into the shared shape. Note `input_tokens` is only the
 *  UNCACHED remainder — the full prompt is that plus both cache figures, which is
 *  what the cost summary needs to avoid under-reporting. */
export function toUsage(usage: Anthropic.Usage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const cacheHit = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  const promptTokens = fresh + cacheWrite + cacheHit;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitTokens: cacheHit,
    // Cache writes are fresh input, so they belong on the miss side — but they are not
    // priced like it. Anthropic bills a write at 1.25x base input (the tokens are
    // processed AND stored), and reporting the total alone under-stated every turn of
    // an agentic loop, which writes a new prefix segment constantly. The slice is
    // carried alongside so pricing can charge it at the right rate; the total stays
    // inclusive so nothing that only reads `cacheMissTokens` becomes wrong.
    cacheMissTokens: fresh + cacheWrite,
    cacheWriteTokens: cacheWrite,
  };
}

/** Map Anthropic's stop reason onto the shared one. `tool_use` and `end_turn` are
 *  both a normal finish; the rest are conditions the engine has to know about. */
export function toStop(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "max_tokens":
      return "truncated";
    case "refusal":
      return "refused";
    case "model_context_window_exceeded":
      return "overflow";
    default:
      return "end";
  }
}

/** What goes between a progress update and the text on either side of it: enough to
 *  make a paragraph break, and nothing if one is already there. */
export function paragraphBreak(before: string): string {
  if (!before || before.endsWith("\n\n")) return "";
  return before.endsWith("\n") ? "\n" : "\n\n";
}

/**
 * Pull the assembled reply and tool calls out of a finished message.
 *
 * On a model with `progressUpdates`, a `thinking` block that carries text is a
 * progress update (the request asked for `display: "updates"`, under which reasoning
 * comes back empty), and it is part of the reply: the note the model wrote for the
 * user before a tool call. It is kept as reply text, a paragraph of its own, exactly
 * as `emit` streamed it, so the stored reply matches what was on screen.
 */
export function toTurn(message: Anthropic.Message, progressUpdates = surfaceOf(message.model).progressUpdates): Turn {
  let content = "";
  let afterUpdate = false;
  const toolCalls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (afterUpdate) content += paragraphBreak(content);
      content += block.text;
      afterUpdate = false;
    } else if (block.type === "thinking" && progressUpdates && block.thinking) {
      content += paragraphBreak(content) + block.thinking;
      afterUpdate = true;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        // Back to the JSON string the transcript stores.
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
    // Reasoning `thinking` blocks are deliberately dropped: reasoning reaches the live
    // UI as deltas, never the stored transcript.
  }
  return { content, toolCalls, stop: toStop(message.stop_reason) };
}

/**
 * Search the web.
 *
 * The parsing lives in `../searchBlocks.ts` because it is the PROTOCOL's shape, not
 * this provider's: other providers serve their own native search over the same
 * Messages protocol, and one parser shared beats two that drift.
 */
export async function webSearch(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const message = await api().messages.create(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS_BUFFERED,
      system: SEARCH_SYSTEM,
      messages: [{ role: "user", content: query }],
      // The dated variant is the tool VERSION, not a date to keep current, and
      // which one is legal depends on the model — the manifest holds that fact.
      // The newer one filters results before they reach the context window, and it
      // runs code execution internally to do it, which is why `code_execution` must
      // NOT also be declared here: two execution environments confuse the model.
      tools: [{ type: surfaceOf(MODEL).searchTool, name: "web_search", max_uses: SEARCH_MAX_USES }],
    },
    { signal: options.signal },
  );
  return extractSearch(message);
}

/** Ask the model for one turn. Usage rides back with it: these are core's internal
 *  calls, and they spend real tokens that the meter would otherwise never see. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  const body = buildBody(req, MAX_TOKENS_BUFFERED);
  const message = await api().messages.create(body, progressRequestOptions(body, options.signal));
  // The surface of the model ASKED for, as the streaming path uses, not the name the response
  // echoes: an echoed alias this table does not know would fall back to the default model's
  // behaviour and show (or hide) reasoning text the request never asked for.
  return { ...toTurn(message, surfaceOf(body.model).progressUpdates), usage: toUsage(message.usage) };
}

/**
 * Ask the model for one turn, STREAMING. Deltas go to `options.onEvent` for the
 * live UI; the assembled turn is the return value, in the same shape the engine
 * records either way. The SDK assembles the final message (including each tool
 * call's JSON), so nothing here has to reassemble fragmented arguments by hand.
 */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  const body = buildBody(req, MAX_TOKENS_STREAM);
  const stream = api().messages.stream(body, progressRequestOptions(body, options.signal));

  // Accumulated alongside the emit so a stream that dies partway can still hand back
  // what the user watched arrive. Only the onEvent path needs it: with no sink nothing
  // reached the screen, so there is no visible reply to keep in step with.
  const reply = replyStream(surfaceOf(body.model).progressUpdates);
  try {
    if (options.onEvent) {
      for await (const event of stream) emit(event, options.onEvent, reply);
    }
    const message = await stream.finalMessage();
    return { ...toTurn(message, surfaceOf(body.model).progressUpdates), usage: toUsage(message.usage) };
  } catch (error) {
    if (isAbortLike(error)) throw error;
    return salvagePartialTurn(reply.text, error);
  }
}

/** The reply as streamed so far, carried across `emit` calls so a progress update gets
 *  its own paragraph. `text` is everything sent as a `text` event. */
export interface ReplyStream {
  progressUpdates: boolean;
  text: string;
  /** Index of the block the last text came from. */
  block: number;
  /** True when that block was a progress update. */
  afterUpdate: boolean;
}

export function replyStream(progressUpdates: boolean): ReplyStream {
  return { progressUpdates, text: "", block: -1, afterUpdate: false };
}

/**
 * Map one streaming event onto the shared event shape. Anthropic streams blocks
 * rather than a flat delta channel, so a tool call announces itself with a
 * `content_block_start` and then streams its arguments as `input_json_delta`.
 */
export function emit(event: Anthropic.MessageStreamEvent, onEvent: (e: StreamEvent) => void, reply?: ReplyStream): void {
  if (event.type === "content_block_start") {
    const block = event.content_block;
    if (block.type === "tool_use") {
      onEvent({ type: "tool_start", index: event.index, id: block.id, name: block.name });
    }
    return;
  }
  if (event.type !== "content_block_delta") return;

  const delta = event.delta;
  if (delta.type === "text_delta" && delta.text) {
    let text = delta.text;
    if (reply) {
      if (reply.afterUpdate && reply.block !== event.index) text = paragraphBreak(reply.text) + text;
      reply.afterUpdate = false;
      reply.block = event.index;
      reply.text += text;
    }
    onEvent({ type: "text", delta: text });
  } else if (delta.type === "thinking_delta" && delta.thinking) {
    if (reply?.progressUpdates) {
      // A progress update — the same rule `toTurn` applies, so screen and transcript agree.
      let text = delta.thinking;
      if (reply.block !== event.index) text = paragraphBreak(reply.text) + text;
      reply.afterUpdate = true;
      reply.block = event.index;
      reply.text += text;
      onEvent({ type: "text", delta: text });
    } else {
      onEvent({ type: "reasoning", delta: delta.thinking });
    }
  } else if (delta.type === "input_json_delta" && delta.partial_json) {
    onEvent({ type: "tool_args", index: event.index, delta: delta.partial_json });
  }
}
