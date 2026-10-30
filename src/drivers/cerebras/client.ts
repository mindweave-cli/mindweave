/**
 * client.ts — the Cerebras wire layer.
 *
 * Cerebras serves an OpenAI-compatible `/chat/completions` surface, so the request
 * shape, SSE framing, fragmented tool-call arguments and the `reasoning_content`
 * channel are handled by the shared layer in `../openaiCompat/wire.js`.
 */
import { endpointUrl } from "../endpoints.js";
import type {
  ModelChoice,
  ModelConfig,
  ModelRequest,
  StreamOptions,
  StreamResult,
  Turn,
  TurnOptions,
} from "../types.js";
import { compatStreamTurn, compatToolTurn, listModels, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, takesEffort } from "./manifest.js";


/** The model a request runs on, matching the shared layer's own fallback. */
function modelOf(config: ModelConfig | undefined): string {
  return config?.model ?? process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;
}

/**
 * Cerebras's reasoning fields.
 *
 * Collapsed to two states rather than forwarding the shared effort rung. The models
 * here come from several vendors whose effort vocabularies differ, and this driver
 * cannot tell from a discovered id which one applies — so it sends the values every
 * one of them accepts instead of a rung that works on some and is rejected by others.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  if (!takesEffort(modelOf(config))) return {};
  return { reasoning_effort: config?.thinking ? "default" : "none" };
}

/**
 * Turn Cerebras's live catalogue into picker entries.
 *
 * No context window is reported by this endpoint, so entries carry no size hint —
 * saying "128K context" here would be repeating this driver's own conservative
 * default back to the user as though the provider had stated it.
 */
export function toChoices(listed: { id: string }[]): ModelChoice[] {
  return listed
    .filter((m) => !/whisper|tts|guard|embed/i.test(m.id))
    .map((m) => ({ id: m.id, label: m.id, description: "served on Cerebras" }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Fetch the models Cerebras is serving right now.
 *
 * Throws when the key is missing or the request fails, which is the contract the
 * registry relies on: a throw keeps the previous list, an empty array replaces it.
 */
export async function discoverModels(): Promise<ModelChoice[]> {
  return toChoices(await listModels(cerebrasProvider));
}

/**
 * Cerebras caches automatically, and the split is read for the TOKEN COUNT rather
 * than for the price: unlike every other provider here, it bills cached input at the
 * full standard rate, so the caching buys latency and nothing else. The manifest's
 * prices reflect that (no discount); this hook exists so a multi-step turn does not
 * report every step's whole prompt as fresh, which is a count, not a bill.
 *
 * No `extraStop`: the finish reasons are the plain OpenAI set.
 */
export const cerebrasProvider: CompatProvider = {
  label: "Cerebras",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("cerebras");
  },
  apiKeyEnv: "CEREBRAS_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit: standardCacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(cerebrasProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(cerebrasProvider, req, options.onEvent, options.signal);
}
