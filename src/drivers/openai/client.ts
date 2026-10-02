/**
 * client.ts — the OpenAI wire layer.
 *
 * The single place that knows how to talk to OpenAI's Responses API. Nothing above
 * the driver knows about URLs, headers, or keys.
 *
 * WHY THE RESPONSES API AND NOT CHAT COMPLETIONS. OpenAI serves both, and this
 * driver could otherwise have reused the OpenAI-compatible path DeepSeek uses. It
 * cannot, and the reason is specific rather than stylistic: on GPT-5.6,
 * `/v1/chat/completions` REJECTS a request that combines function tools with any
 * reasoning effort other than `none`. These models reason by default, so that
 * combination is not an edge case for an agent — it is every single turn. The
 * choice is therefore forced: a tool-calling agent that reasons has one endpoint.
 *
 * The translation from the stored transcript is a real one, because the Responses
 * API disagrees with it in four places:
 *
 *   1. The system prompt is `instructions`, a top-level field, not a message.
 *   2. Assistant tool calls are `function_call` ITEMS in the input array, not a
 *      `tool_calls` array hanging off an assistant message.
 *   3. Tool results are `function_call_output` items keyed by `call_id`, not
 *      messages with `role: "tool"`.
 *   4. Tool definitions are FLAT (`{type, name, parameters}`) rather than nested
 *      under a `function` key.
 *
 * All of that is format. None of it changes what the model is asked to do — the
 * system prompt is the same bytes here as on any other provider.
 *
 * ON REASONING CONTINUITY. OpenAI can carry a turn's reasoning into the next tool
 * round if the reasoning items are echoed back. This driver does not do that, and
 * the reason is the seam rather than an oversight: the stored transcript is a
 * provider-neutral shape with nowhere to put an opaque provider-specific blob, and
 * adding somewhere would change a core type for one provider's benefit. Every other
 * driver already behaves this way (the Anthropic one drops thinking blocks
 * explicitly), so this is the house rule, consistently applied.
 */
import type OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import { basename } from "node:path";
import { clientId } from "../clientId.js";
import { RETRY_MAX_ATTEMPTS } from "../retryPolicy.js";
import type {
  ModelRequest,
  StreamEvent,
  StreamOptions,
  StreamResult,
  StopReason,
  ToolCall,
  Turn,
  TurnOptions,
  Usage,
} from "../types.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, canSkipReasoning } from "./manifest.js";

const MODEL = process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;

/** Output ceiling for a streamed turn. This caps reasoning AND answer together, so
 *  it needs headroom at the higher rungs; the family accepts up to 128K. */
const MAX_TOKENS_STREAM = 64_000;
/** Buffered calls are the small internal ones (summaries, page distillation), and a
 *  non-streaming request that runs long risks an HTTP timeout. The value lives in
 *  the manifest because core reserves room for it when setting the compaction bars. */
const MAX_TOKENS_BUFFERED = BUFFERED_OUTPUT_TOKENS;

let client: OpenAI | null = null;
/** The key `client` was built with. A different live key (switched with /key, or by the
 *  app's key manager) rebuilds it; the old code kept the first key for the whole process. */
let clientKey: string | undefined;

/** The shared SDK client, or a clear setup error if no key is configured yet. */
async function api(): Promise<OpenAI> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!client || apiKey !== clientKey) {
    if (!apiKey) {
      throw new Error(
        "No OPENAI_API_KEY found. Add your key to the global config so Mindweave works " +
          "in every project:\n" +
          "  ~/.mindweave/.env  →  OPENAI_API_KEY=your-key-here\n" +
          "(A per-project .env or an exported shell variable also works.)",
      );
    }
    const { default: OpenAIClient } = await import("openai");
    // Retries made explicit rather than inherited. These two drivers reach their
    // provider through a vendor SDK that retries on its own, while the other eleven
    // go through `openaiCompat/wire.ts` and use `retryPolicy.ts`. Pinning the count
    // here means a session behaves the same way whichever provider it is pointed at,
    // and that an SDK upgrade changing its default cannot quietly change ours.
    client = new OpenAIClient({ apiKey, maxRetries: RETRY_MAX_ATTEMPTS - 1, defaultHeaders: { "User-Agent": clientId() } });
    clientKey = apiKey;
  }
  return client;
}

/**
 * Convert the stored transcript into Responses input items.
 *
 * Two shapes have no direct equivalent and are converted rather than passed
 * through: an assistant message's `tool_calls` become sibling `function_call`
 * items, and a `role: "tool"` message becomes a `function_call_output`. A stray
 * in-conversation system message is pulled out and returned separately, because
 * the Responses API carries system text in `instructions` and dropping it would
 * silently lose instructions.
 */
export function renderInput(req: ModelRequest): {
  input: Responses.ResponseInputItem[];
  extraSystem: string[];
} {
  const input: Responses.ResponseInputItem[] = [];
  const extraSystem: string[] = [];

  for (const msg of req.messages) {
    if (msg.role === "system") {
      if (msg.content.trim()) extraSystem.push(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: msg.content || "(no output)",
      });
      continue;
    }

    if (msg.role === "user") {
      // Images first: the model reads an image-then-text message more reliably
      // than the reverse, and each is labelled so a later turn can name it.
      const content: Responses.ResponseInputContent[] = [];
      for (const img of msg.images ?? []) {
        content.push({ type: "input_text", text: `Image (${basename(img.path)}):` });
        content.push({
          type: "input_image",
          detail: "auto",
          image_url: `data:${img.mediaType};base64,${img.data}`,
        });
      }
      if (msg.content.trim()) content.push({ type: "input_text", text: msg.content });
      if (content.length > 0) input.push({ role: "user", content });
      continue;
    }

    // Assistant: prose first, then each tool call as its own item. Plain-string
    // content is the simple input form; the block form is the OUTPUT shape and
    // requires an id and status we neither have nor should invent.
    if (msg.content.trim()) input.push({ role: "assistant", content: msg.content });
    for (const call of msg.tool_calls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments || "{}",
      });
    }
  }

  return { input, extraSystem };
}

/** Translate the tool schemas from their stored OpenAI CHAT shape (nested under
 *  `function`) into the Responses shape (flat). The two are not interchangeable —
 *  sending the nested form here is a validation error, not a tolerated variant. */
function renderTools(req: ModelRequest): Responses.Tool[] {
  return (req.tools ?? []).map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description,
    parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
    // Loose schema validation: the tool schemas are hand-written and some carry
    // shapes strict mode rejects. The engine validates arguments itself anyway.
    strict: false,
  }));
}

/**
 * Build the request body shared by both paths.
 *
 * `store: false` is deliberate and load-bearing: by default OpenAI RETAINS the
 * response server-side for later retrieval. Mindweave is a local-first tool whose
 * transcript lives on the user's disk, so leaving a copy of every turn on a vendor's
 * servers is not a default it should inherit silently.
 *
 * The volatile `context` is appended as the LAST input item so a changing code map
 * or todo list never invalidates the cached prefix — OpenAI caches the longest
 * identical prefix from the start, which is the property the ModelRequest split
 * exists to guarantee.
 */
export function buildBody(req: ModelRequest, maxTokens: number): Responses.ResponseCreateParamsNonStreaming {
  const cfg = req.model;
  const { input, extraSystem } = renderInput(req);

  if (req.context && req.context.trim()) {
    input.push({
      role: "user",
      content: [{ type: "input_text", text: `<current_context>\n${req.context}\n</current_context>` }],
    });
  }
  // The API rejects an empty conversation; the engine never sends one, but a
  // tool-less internal call could in principle.
  if (input.length === 0) {
    input.push({ role: "user", content: [{ type: "input_text", text: "(no input)" }] });
  }

  const body: Responses.ResponseCreateParamsNonStreaming = {
    model: cfg?.model ?? MODEL,
    instructions: [req.system, ...extraSystem].filter((s) => s.trim()).join("\n\n"),
    input,
    max_output_tokens: maxTokens,
    // Reasoning is ONE dial here: `none` is the off switch rather than a separate
    // flag, so the shared thinking/effort pair collapses into a single rung.
    // Astra and GPT-6.1 Sol have no `none`; `normalize` keeps them thinking, and a stray
    // no-thinking config still gets the lightest rung rather than a refused request.
    reasoning: { effort: cfg?.thinking ? (cfg.effort as "high") : canSkipReasoning(cfg?.model ?? MODEL) ? "none" : "low" },
    store: false,
  };

  const tools = renderTools(req);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return body;
}

/** Fold the Responses usage into the shared shape. `input_tokens` here is the FULL
 *  prompt including the cached part, unlike Anthropic's, so the miss side is the
 *  remainder after cache reads rather than a sum. */
export function toUsage(usage: Responses.ResponseUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens ?? 0;
  const cacheHit = usage.input_tokens_details?.cached_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: Math.max(0, promptTokens - cacheHit),
  };
}

/**
 * Map a finished response onto the shared stop reason.
 *
 * The signal lives in two places: an unfinished response says WHY in
 * `incomplete_details`, and a refusal arrives as a content part rather than a
 * status. Both have to be read, or a cut-off reply and a declined one both look
 * like a clean finish and the loop carries on with half an answer.
 */
export function toStop(response: Pick<Responses.Response, "status" | "incomplete_details" | "output">): StopReason {
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ? "refused" : "truncated";
  }
  if (response.status === "failed") return "overloaded";
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "refusal") return "refused";
    }
  }
  return "end";
}

/** Pull the assembled reply and tool calls out of a finished response. */
export function toTurn(response: Responses.Response): Turn {
  let content = "";
  const toolCalls: ToolCall[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") content += part.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        // The engine echoes this back as the result's key, and the API matches
        // results on `call_id` — NOT on the item's own `id`. Sending the wrong
        // one is an unmatched-result error on the following turn.
        id: item.call_id,
        name: item.name,
        arguments: item.arguments || "{}",
      });
    }
    // `reasoning` items are deliberately dropped — see the note in the file header.
  }

  return { content, toolCalls, stop: toStop(response) };
}

/** Ask the model for one turn. Usage rides back with it: these are core's internal
 *  calls, and they spend real tokens that the meter would otherwise never see. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  const response = await (await api()).responses.create(buildBody(req, MAX_TOKENS_BUFFERED), {
    signal: options.signal,
  });
  return { ...toTurn(response), usage: toUsage(response.usage) };
}

/**
 * Ask the model for one turn, STREAMING. Deltas go to `options.onEvent` for the
 * live UI; the assembled turn is the return value, in the same shape the engine
 * records either way. The SDK assembles the final response (including each tool
 * call's JSON), so nothing here reassembles fragmented arguments by hand.
 */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  const stream = (await api()).responses.stream(
    { ...buildBody(req, MAX_TOKENS_STREAM), stream: true },
    { signal: options.signal },
  );

  if (options.onEvent) {
    // Tool calls are announced by item index, and the shared event shape keys on a
    // dense index — so map the API's `output_index` onto one.
    const indexOf = new Map<number, number>();
    for await (const event of stream) {
      emit(event, options.onEvent, indexOf);
    }
  }

  const response = await stream.finalResponse();
  return { ...toTurn(response), usage: toUsage(response.usage) };
}

/**
 * Map one streaming event onto the shared event shape.
 *
 * Reasoning arrives on two different channels depending on how the model was
 * asked — `reasoning_text` when the raw stream is available, `reasoning_summary_text`
 * when only a summary is. Both are handled: whichever one the provider sends, the
 * UI shows reasoning rather than an unexplained pause.
 */
export function emit(
  event: Responses.ResponseStreamEvent,
  onEvent: (e: StreamEvent) => void,
  indexOf: Map<number, number>,
): void {
  switch (event.type) {
    case "response.output_text.delta":
      if (event.delta) onEvent({ type: "text", delta: event.delta });
      return;

    case "response.reasoning_text.delta":
    case "response.reasoning_summary_text.delta":
      if (event.delta) onEvent({ type: "reasoning", delta: event.delta });
      return;

    case "response.output_item.added": {
      const item = event.item;
      if (item.type !== "function_call") return;
      const index = indexOf.size;
      indexOf.set(event.output_index, index);
      onEvent({ type: "tool_start", index, id: item.call_id, name: item.name });
      return;
    }

    case "response.function_call_arguments.delta": {
      const index = indexOf.get(event.output_index);
      // A fragment before its item was announced has nowhere to go; the final
      // response still carries the whole call, so dropping the delta only costs
      // the live preview, never the call itself.
      if (index === undefined || !event.delta) return;
      onEvent({ type: "tool_args", index, delta: event.delta });
      return;
    }

    default:
      // Every other event (created, in_progress, content_part.*, done, usage) has
      // no shared equivalent — the assembled response carries what they describe.
      return;
  }
}
