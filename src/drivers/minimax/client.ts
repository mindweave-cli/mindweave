/**
 * client.ts — the MiniMax wire layer.
 *
 * MiniMax serves an OpenAI-compatible `/chat/completions` surface, so the request
 * shape, SSE framing, fragmented tool-call arguments and the `reasoning_content`
 * channel are all handled by the shared layer in `../openaiCompat/wire.js`. This
 * file supplies only the facts that differ.
 */
import { endpointUrl } from "../endpoints.js";
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, normalize, surfaceOf } from "./manifest.js";


/**
 * MiniMax's reasoning fields, sent EXPLICITLY every call rather than left to the
 * provider's default (which is the deepest setting).
 *
 *   - M3.1 Flash always reasons, so `thinking: "disabled"` is never sent (it is rejected).
 *     The one dial is the top-level `reasoning_effort`. An internal buffered call carries
 *     no `ModelConfig`; it gets the lightest rung rather than silently reasoning at max.
 *   - M3 takes a nested `{type: "adaptive" | "disabled"}`, sent both ways.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  // An unknown model id falls back to the default's surface here, as `normalize` does for the request itself.
  if (surfaceOf(config?.model ?? DEFAULT_MODEL).takesEffort) return { reasoning_effort: config ? normalize(config).effort : "low" };
  return { thinking: { type: config?.thinking !== false ? "adaptive" : "disabled" } };
}

/** MiniMax reports its cache hit the standard OpenAI-compatible way, the same
 *  shape Qwen, GLM, xAI, Mistral, Groq, Cerebras and Gemini all return. */
export const cacheSplit = standardCacheSplit;

/** Everything the shared wire layer needs to talk to MiniMax. */
export const minimaxProvider: CompatProvider = {
  label: "MiniMax",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("minimax");
  },
  apiKeyEnv: "MINIMAX_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(minimaxProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(minimaxProvider, req, options.onEvent, options.signal);
}
