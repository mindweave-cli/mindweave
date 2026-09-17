/**
 * client.ts — the OpenRouter wire layer.
 *
 * OpenRouter speaks the OpenAI-compatible `/chat/completions` shape, so the shared layer
 * does the streaming, tool-call assembly, retries and in-body error handling. What is
 * OpenRouter's own is small and all in the request:
 *   - the model id loses Mindweave's `openrouter:` namespace on the way out;
 *   - reasoning is one field for every model, `reasoning: { effort | enabled }`;
 *   - Anthropic-served models only cache what carries an explicit breakpoint;
 *   - the privacy switch, `provider.data_collection`, when the user sets it.
 */
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, type CompatProvider } from "../openaiCompat/wire.js";
import { BASE_URL, OPENROUTER_HEADERS } from "./endpoint.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, wireId } from "./manifest.js";

/**
 * Reasoning, in OpenRouter's normalized field.
 *
 * Thinking on sends the chosen effort, which OpenRouter maps onto each vendor's own
 * control. Thinking off sends `enabled: false`. The ladder the user picked from came
 * from the catalogue, so a model whose reasoning is mandatory never reaches the off
 * branch, and a model with no reasoning at all only ever has the off row.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  if (!config) return {};
  return config.thinking ? { reasoning: { effort: config.effort } } : { reasoning: { enabled: false } };
}

/**
 * The cache split, including writes.
 *
 * `prompt_tokens` is the whole prompt; `cached_tokens` the part read from cache and
 * `cache_write_tokens` the part written to it. Writes are reported so the ones billed
 * at a premium (Anthropic's 1.25x) are priced as such.
 */
export function cacheSplit(usage: Record<string, unknown>): { hit: number; miss: number; write?: number } | undefined {
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown; cache_write_tokens?: unknown } | undefined;
  const hit = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
  const write = typeof details?.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
  if (hit === 0 && write === 0) return undefined;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  return { hit, miss: Math.max(0, prompt - hit), ...(write > 0 ? { write } : {}) };
}

/** Models that cache only what is marked. Every other family here caches automatically. */
function needsBreakpoints(model: string): boolean {
  return model.startsWith("anthropic/");
}

/** Put a breakpoint on a message's last content part, turning string content into parts. */
function mark(message: Record<string, unknown>): Record<string, unknown> {
  const content = message.content;
  const breakpoint = { cache_control: { type: "ephemeral" } };
  if (typeof content === "string") {
    return { ...message, content: [{ type: "text", text: content, ...breakpoint }] };
  }
  if (Array.isArray(content) && content.length > 0) {
    const parts = [...content];
    parts[parts.length - 1] = { ...(parts[parts.length - 1] as Record<string, unknown>), ...breakpoint };
    return { ...message, content: parts };
  }
  return message;
}

function hasText(message: Record<string, unknown>): boolean {
  const content = message.content;
  return (typeof content === "string" && content.length > 0) || (Array.isArray(content) && content.length > 0);
}

/**
 * Explicit breakpoints at the two stable boundaries: the end of the system prompt, and
 * the last message before the volatile context tail. The same boundaries the Anthropic
 * driver uses, and never on the tail itself, which changes every step. An assistant
 * message with only tool calls has no text to mark, so the boundary walks back to the
 * nearest one that does.
 */
export function withBreakpoints(messages: Record<string, unknown>[], hasContextTail: boolean): Record<string, unknown>[] {
  const out = [...messages];
  if (out[0]?.role === "system" && hasText(out[0])) out[0] = mark(out[0]);
  let last = out.length - 1 - (hasContextTail ? 1 : 0);
  while (last > 0 && !hasText(out[last]!)) last--;
  if (last > 0) out[last] = mark(out[last]!);
  return out;
}

export function finishBody(body: Record<string, unknown>, req: ModelRequest): Record<string, unknown> {
  const model = wireId(String(body.model ?? DEFAULT_MODEL));
  const out: Record<string, unknown> = { ...body, model };
  if (needsBreakpoints(model) && Array.isArray(body.messages)) {
    out.messages = withBreakpoints(body.messages as Record<string, unknown>[], !!req.context?.trim());
  }
  // Allowed by default, which is OpenRouter's default too; the provider notice says so.
  if (process.env.MINDWEAVE_OPENROUTER_DATA?.trim().toLowerCase() === "deny") {
    out.provider = { data_collection: "deny" };
  }
  return out;
}

export const openrouterProvider: CompatProvider = {
  label: "OpenRouter",
  baseUrl: BASE_URL,
  apiKeyEnv: "OPENROUTER_API_KEY",
  defaultModel: DEFAULT_MODEL,
  reasoningFields,
  cacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
  headers: OPENROUTER_HEADERS,
  finishBody,
};

export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(openrouterProvider, req, options.signal);
}

export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(openrouterProvider, req, options.onEvent, options.signal);
}
