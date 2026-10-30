/**
 * client.ts — the Gemini wire layer.
 *
 * Google serves Gemini through an OpenAI-compatible `/chat/completions` surface
 * (`https://ai.google.dev/gemini-api/docs/openai`), so the request shape, SSE
 * framing, fragmented tool-call arguments and cache-token reporting are all
 * handled by the shared layer in `../openaiCompat/wire.js`. This file supplies
 * only the facts that differ.
 */
import { endpointUrl } from "../endpoints.js";
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL } from "./manifest.js";


/**
 * Gemini's reasoning field.
 *
 * Google documents its OpenAI-compatible endpoint translating the standard
 * `reasoning_effort` parameter onto its own `thinking_level` internally, so this
 * is a bare pass-through rather than a renamed field like Qwen's or xAI's. Every
 * model in this lineup always reasons (see the manifest header), so unlike xAI or
 * DeepSeek there is no "send nothing, thinking is off" branch to guard here — an
 * effort is always sent.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  return { reasoning_effort: config?.effort ?? "low" };
}

/** Gemini reports its cache hit the standard OpenAI-compatible way, the same
 *  shape Qwen, GLM, xAI, Mistral, Groq and Cerebras all return. */
export const cacheSplit = standardCacheSplit;

/** Everything the shared wire layer needs to talk to Gemini. */
export const geminiProvider: CompatProvider = {
  label: "Gemini",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("gemini");
  },
  apiKeyEnv: "GEMINI_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(geminiProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(geminiProvider, req, options.onEvent, options.signal);
}
