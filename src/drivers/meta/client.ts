/**
 * client.ts — the Meta wire layer.
 *
 * Meta's Model API serves an explicitly "OpenAI-compatible" `/chat/completions`
 * surface, so the request shape, SSE framing, fragmented tool-call arguments and
 * cache-token reporting are all handled by the shared layer in
 * `../openaiCompat/wire.js`. This file supplies only the facts that differ, and
 * for Meta that is the reasoning dial: Muse Spark always reasons, and how deeply is
 * the one thing a request gets to say (see the manifest header).
 */
import { endpointUrl } from "../endpoints.js";
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL } from "./manifest.js";


/**
 * Meta's reasoning field.
 *
 * `reasoning_effort` is ALWAYS sent. Muse Spark reasons whether or not the field is
 * present — Meta's own reference says so plainly, and `none` is the one value it
 * refuses with a 400 — so omitting it does not mean a direct answer, it means the
 * model reasons at a depth nobody chose. Every internal call that never sets a model
 * would otherwise pay for whatever that default happens to be.
 *
 * The manifest's ladder holds only values this API accepts, and `normalize` snaps a
 * config from another provider onto one of them before it reaches here, so the value
 * below is legal by construction rather than by a check.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  return { reasoning_effort: config?.effort ?? "high" };
}

/** Meta reports its cache hit the standard OpenAI-compatible way, the same shape
 *  Qwen, GLM, xAI, Mistral, Groq, Cerebras and Gemini all return. */
export const cacheSplit = standardCacheSplit;

/** Everything the shared wire layer needs to talk to Meta. */
export const metaProvider: CompatProvider = {
  label: "Meta",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("meta");
  },
  apiKeyEnv: "MODEL_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(metaProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(metaProvider, req, options.onEvent, options.signal);
}
