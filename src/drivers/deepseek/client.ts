/**
 * client.ts — the DeepSeek wire layer.
 *
 * DeepSeek's chat API is OpenAI-compatible, so the request shape, SSE framing,
 * fragmented tool-call arguments and the `reasoning_content` channel are all
 * handled by the shared layer in `../openaiCompat/wire.ts`. This file supplies the
 * facts that differ — and DeepSeek has more of those than any other provider on
 * that layer, which is why they are each explained below rather than listed.
 *
 * Historically this file carried its own copy of all that plumbing. It was the
 * first driver, so there was nothing to share with; three more OpenAI-compatible
 * providers later, a second copy of the SSE reader is just a second place for the
 * same bug to be fixed once and missed.
 */
import type {
  ModelConfig,
  ModelRequest,
  SearchOptions,
  SearchResult,
  StopReason,
  StreamOptions,
  StreamResult,
  ToolCall,
  Turn,
  TurnOptions,
} from "../types.js";
import { compatStreamTurn, compatToolTurn, requireApiKey, type CompatProvider } from "../openaiCompat/wire.js";
import { clientId } from "../clientId.js";
import { extractSearch, SEARCH_MAX_USES, SEARCH_SYSTEM } from "../searchBlocks.js";
import { parseInlineToolCalls } from "./inlineTools.js";
import { DEFAULT_MODEL } from "./manifest.js";

const BASE_URL = process.env.MINDWEAVE_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;

/**
 * Where DeepSeek serves its own web search.
 *
 * DeepSeek speaks two protocols on one account and one key. Chat and tools run over
 * the OpenAI-compatible path above; the native web search is served ONLY over this
 * Anthropic-Messages-compatible one, as a server-side tool. So this driver talks to
 * both, and which one a request uses is decided by the OPERATION rather than by
 * configuration — there is nothing for the user to choose and no second key.
 *
 * Only the search call moves. Putting the whole driver here would cost real things:
 * this endpoint ignores `cache_control` (so the prompt cache the OpenAI path relies
 * on would be gone) and does not carry MCP tools, images, or code execution.
 */
const ANTHROPIC_BASE_URL = process.env.MINDWEAVE_DEEPSEEK_ANTHROPIC_URL ?? "https://api.deepseek.com/anthropic";

/** Output ceiling for the buffered search call. */
const SEARCH_MAX_TOKENS = 8_000;

/**
 * Output ceiling for a streamed turn. Left unset, DeepSeek stopped a reply at 8,192 tokens, and with thinking
 * counted against that, one new page written in a single call was cut off and lost. The same ceiling as the other
 * large-output drivers; the model's own limit is far above it.
 */
const STREAM_MAX_TOKENS = 64_000;

/**
 * DeepSeek's reasoning fields.
 *
 * The `thinking` field is ALWAYS sent, one way or the other — DeepSeek's own docs
 * say omitting it entirely defaults to ENABLED at high effort, not disabled. So
 * every internal call that never sets `req.model` (the session-memory summarizer,
 * the web-page distiller) was once silently paying for full reasoning it never
 * asked for and the UI was never going to show, since reasoning deltas are
 * discarded unconditionally. Sending an explicit `{ type: "disabled" }` is what
 * actually turns it off.
 *
 * This turned out to be the family pattern rather than a DeepSeek quirk: Qwen and
 * GLM default to thinking-on in exactly the same way, and their drivers send the
 * off switch explicitly for exactly this reason.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  if (!config?.thinking) return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: config.effort };
}

/**
 * DeepSeek's documented sampling settings for agent use.
 *
 * Two facts from their docs, and the second is why this is a function rather than a
 * constant spread into every body:
 *
 *  1. The recommended operating point is `temperature = 1.0` with `top_p = 0.95` for
 *     agentic use (`1.0` otherwise). We were sending NEITHER, so every call ran on
 *     whatever the endpoint's default happened to be — fine until it changes, and
 *     invisible when it does.
 *  2. "Thinking mode does not support the temperature, top_p, presence_penalty, or
 *     frequency_penalty parameters. These parameters will not trigger an error but
 *     will have no effect." So with thinking ON there is nothing to set.
 *
 * Which means this bites exactly where thinking is off: the Standard `/think` level,
 * and every internal buffered call — the session summarizer, the web-page distiller —
 * since `reasoningFields` sends `{ type: "disabled" }` for those. Those are the calls
 * that were silently un-tuned, and they are also the ones whose output feeds straight
 * back into the transcript.
 *
 * Temperature is NOT lowered to shorten output, ever, however tempting that looks for
 * a summarizer: DeepSeek warns that lower temperatures collapse the reasoning trace
 * and degrade the answer, and that length belongs to `max_tokens`. Written down here
 * because it is exactly the "optimisation" a later reader would otherwise try.
 */
export function sampling(config: ModelConfig | undefined): Record<string, unknown> {
  if (config?.thinking) return {};
  return { temperature: 1.0, top_p: 0.95 };
}

/**
 * `insufficient_system_resource` is DeepSeek-specific, not part of the OpenAI
 * spec: the request was cut off by DeepSeek's own infrastructure, not a token limit
 * or a safety decision. Without a case for it, it falls through to `"end"` — a
 * resource-starved, incomplete reply reported as a clean finish.
 */
export function extraStop(reason: string): StopReason | undefined {
  return reason === "insufficient_system_resource" ? "overloaded" : undefined;
}

/**
 * DeepSeek reports BOTH sides of the cache split directly, as siblings of
 * `prompt_tokens`, rather than nesting a `cached_tokens` figure that the miss side
 * has to be derived from. Read as given: deriving one from the other here would
 * disagree with the provider whenever the two do not sum to the prompt exactly.
 */
export function cacheSplit(usage: Record<string, unknown>): { hit: number; miss: number } | undefined {
  const num = (key: string): number => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const hit = num("prompt_cache_hit_tokens");
  const miss = num("prompt_cache_miss_tokens");
  if (hit === 0 && miss === 0) return undefined;
  return { hit, miss };
}

/**
 * Recover tool calls DeepSeek leaked into the TEXT channel as DSML markup, and
 * strip that markup from the content either way.
 *
 * The recovery only fires when the structured list is empty: a model that emitted
 * a proper `tool_calls` array and also narrated one in prose has already had its
 * call registered, and adding the narrated copy would run it twice.
 */
export function repairContent(content: string, toolCalls: ToolCall[], seen = ""): { content: string; toolCalls: ToolCall[] } {
  const inline = parseInlineToolCalls(content, seen);
  const recovered = toolCalls.length === 0 ? inline.toolCalls : toolCalls;
  return { content: inline.cleaned, toolCalls: recovered };
}

/** Everything the shared wire layer needs to talk to DeepSeek. */
export const deepseekProvider: CompatProvider = {
  label: "DeepSeek",
  baseUrl: BASE_URL,
  apiKeyEnv: "DEEPSEEK_API_KEY",
  defaultModel: MODEL,
  streamMaxTokens: STREAM_MAX_TOKENS,
  reasoningFields,
  sampling,
  extraStop,
  cacheSplit,
  repairContent,
};

/** Ask the model for one turn. An empty `tools` array forces a plain-text answer. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(deepseekProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(deepseekProvider, req, options.onEvent, options.signal);
}

/**
 * Search the web, over DeepSeek's own Anthropic-protocol endpoint.
 *
 * DeepSeek runs the search on its own servers with the key the user already has.
 * Nothing third-party is involved and there is no second key — the same account,
 * reached over the protocol that happens to carry its search.
 *
 * The SDK is imported HERE rather than at the top of the file so that a DeepSeek
 * session that never searches does not load it. That lazy split is measured and
 * deliberate (it is why drivers load on demand at all), and a top-level import would
 * quietly undo it for every DeepSeek user.
 *
 * The model id is passed through as DeepSeek's own (`deepseek-v4-pro`), which is what
 * their documented example does. Their Claude-name mapping is a compatibility shim
 * for clients that only know Anthropic model names, and routing through it would mean
 * naming a Claude model to get a DeepSeek one — indirection with nothing to gain.
 */
export async function webSearch(query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({
    apiKey: requireApiKey(deepseekProvider),
    baseURL: ANTHROPIC_BASE_URL,
    // DeepSeek authenticates this endpoint with `x-api-key`, which is what the SDK
    // sends for `apiKey`. It ignores `anthropic-version` rather than requiring it.
    defaultHeaders: { "User-Agent": clientId() },
  });
  const message = await client.messages.create(
    {
      model: MODEL,
      max_tokens: SEARCH_MAX_TOKENS,
      system: SEARCH_SYSTEM,
      messages: [{ role: "user", content: query }],
      // The original tool version, not Anthropic's newer dated one: this is
      // DeepSeek's implementation of the protocol, and the widely-implemented
      // version is the one to send to a compatibility endpoint.
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: SEARCH_MAX_USES }],
    },
    { signal: options.signal },
  );
  return extractSearch(message);
}
