/**
 * client.ts — the Mistral wire layer.
 *
 * Mistral serves an OpenAI-compatible `/chat/completions` surface, so the request
 * shape, SSE framing and fragmented tool-call arguments are handled by the shared
 * layer in `../openaiCompat/wire.js`. This file supplies only what differs.
 */
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, takesEffort } from "./manifest.js";

/** La Plateforme, which runs in EU data centres. */
const BASE_URL = process.env.MINDWEAVE_MISTRAL_URL ?? "https://api.mistral.ai/v1";

/** The model a request runs on, matching the shared layer's own fallback so the
 *  reasoning fields can never be built for a different model than is being called. */
function modelOf(config: ModelConfig | undefined): string {
  return config?.model ?? process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;
}

/**
 * Mistral's reasoning fields.
 *
 * A root-level `reasoning_effort`, served by the flagship and Small 4 only. `none`
 * is the off switch: the model thinks minimally and omits the thinking chunk.
 *
 * Sent only for the models that have the dial. Unlike Qwen, GLM and DeepSeek this
 * provider does not default to thinking-on, so omitting the field on the others is
 * genuinely absent rather than a hidden bill. Worth stating, because after three
 * drivers where the opposite held, always-send has become the reflex.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  if (!takesEffort(modelOf(config))) return {};
  return { reasoning_effort: config?.thinking ? (config.effort ?? "high") : "none" };
}

/**
 * Mistral DOES cache, reports it as `prompt_tokens_details.cached_tokens`, and
 * bills those tokens at a tenth of the standard input rate. An earlier version of
 * this driver claimed it did none of that, which cost twice: the cost estimate paid
 * full price for cached input, and — worse — the token meter counted every step's
 * whole prompt as fresh, so a five-step turn reported several times the tokens it
 * actually used.
 *
 * No `extraStop`: its finish reasons are the plain OpenAI set, so there is nothing
 * extra to map. That absence really is deliberate.
 */
export const mistralProvider: CompatProvider = {
  label: "Mistral",
  baseUrl: BASE_URL,
  apiKeyEnv: "MISTRAL_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit: standardCacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
  // A stable id for the conversation raises the chance that a later request finds the prefix an
  // earlier one cached. It is a random id, never the person or the project.
  finishBody: (body, req) => (req.sessionId ? { ...body, prompt_cache_key: req.sessionId } : body),
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(mistralProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(mistralProvider, req, options.onEvent, options.signal);
}
