/**
 * client.ts — the Qwen wire layer.
 *
 * Qwen serves an OpenAI-compatible `/chat/completions` surface, so almost nothing
 * here is Qwen-specific: the request shape, the SSE framing, the fragmented
 * tool-call arguments and the `reasoning_content` channel are all handled by the
 * shared layer in `../openaiCompat/wire.ts`. This file supplies only the facts
 * that differ, which is what a provider binding should be.
 *
 * The one part that is genuinely Qwen's own is how reasoning is expressed — see
 * `reasoningFields` below.
 */
import { endpointUrl } from "../endpoints.js";
import type {
  ModelConfig,
  ModelRequest,
  StopReason,
  StreamOptions,
  StreamResult,
  Turn,
  TurnOptions,
} from "../types.js";
import {
  compatStreamTurn,
  compatToolTurn,
  type CompatProvider,
} from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL } from "./manifest.js";

/**
 * The international DashScope endpoint. The Chinese Mainland endpoint is a
 * different host with different prices, and the key is not interchangeable, so
 * this is an override rather than a guess: a user on the Mainland account sets
 * `MINDWEAVE_QWEN_URL` and everything else works unchanged.
 */

/**
 * Thinking budgets, in tokens, for each shared effort rung.
 *
 * Qwen caps `thinking_budget` at 32,768 and the top rung deliberately sits exactly
 * there. The rungs below are spaced to be visibly different in behaviour rather
 * than evenly: the gap that matters to a user is between "a little" and "a lot",
 * not between two adjacent large numbers.
 */
const THINKING_BUDGETS: Record<string, number> = {
  low: 4_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 24_000,
  max: 32_768,
};

/** The budget for an effort rung, falling back to the middle of the ladder. */
export function thinkingBudget(effort: string | undefined): number {
  return THINKING_BUDGETS[effort ?? "high"] ?? THINKING_BUDGETS.high!;
}

/**
 * Qwen's reasoning fields.
 *
 * `enable_thinking` is ALWAYS sent, both ways, and that is the load-bearing detail
 * in this file. Every model in this lineup has thinking ON by default, so omitting
 * the field does not mean "no thinking" — it means full reasoning, billed at the
 * higher thinking rate. Every internal call that never sets `req.model` (the
 * session summarizer, the page distiller) would silently pay for reasoning it never
 * asked for and that the UI discards. Sending an explicit `false` is what actually
 * turns it off. This is the same trap the DeepSeek driver documents; it is a
 * property of the family, not a coincidence.
 *
 * `thinking_budget` is deliberately preferred over `reasoning_effort`: both are
 * accepted, but the budget's units are unambiguous and its cap is documented,
 * whereas the effort ladder's accepted values are provider-specific and not the
 * same set as the shared one.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  if (!config?.thinking) return { enable_thinking: false };
  return { enable_thinking: true, thinking_budget: thinkingBudget(config.effort) };
}

/**
 * Qwen reports its cache hit as `prompt_tokens_details.cached_tokens`, where
 * `prompt_tokens` is the FULL prompt including the cached part — so the miss side
 * is the remainder rather than a separate figure to add.
 */
export function cacheSplit(usage: Record<string, unknown>): { hit: number; miss: number } | undefined {
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const hit = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
  if (hit === 0) return undefined;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  return { hit, miss: Math.max(0, prompt - hit) };
}

/**
 * A request cut short by the provider's own capacity rather than by a token limit
 * or a safety decision. Without a case for it this falls through to `"end"`, and a
 * starved, incomplete reply gets reported as a clean finish.
 */
export function extraStop(reason: string): StopReason | undefined {
  return reason === "insufficient_system_resource" ? "overloaded" : undefined;
}

/** Everything the shared wire layer needs to talk to Qwen. */
export const qwenProvider: CompatProvider = {
  label: "Qwen",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("qwen");
  },
  apiKeyEnv: "DASHSCOPE_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  extraStop,
  cacheSplit,
  // Must match the manifest's `bufferedOutputTokens`, which is what core reserves
  // room for below the context window.
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(qwenProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(qwenProvider, req, options.onEvent, options.signal);
}
