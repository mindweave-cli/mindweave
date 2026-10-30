/**
 * client.ts — the Groq wire layer.
 *
 * Groq serves an OpenAI-compatible `/chat/completions` surface, so the request
 * shape, SSE framing, fragmented tool-call arguments and the `reasoning_content`
 * channel are handled by the shared layer in `../openaiCompat/wire.js`.
 *
 * What is unusual here is `discoverModels`: this is the first driver whose model
 * list comes off the wire rather than out of the manifest.
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
 * Groq's reasoning fields.
 *
 * `reasoning_effort` here accepts only `none` or `default` — not the graded ladder
 * every other provider on this layer exposes. Sending `high` is a 400, not a
 * downgrade, so the shared effort rung is deliberately NOT forwarded: it is
 * collapsed to the two states this API actually has.
 *
 * Sent only for the models that accept the parameter at all; the rest reject it.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  if (!takesEffort(modelOf(config))) return {};
  return { reasoning_effort: config?.thinking ? "default" : "none" };
}

/**
 * Turn Groq's live catalogue into picker entries.
 *
 * The listing reports a real `context_window` per model, which is the one piece of
 * per-model truth a discovered provider would otherwise have to guess. It is folded
 * into the description so the choice is informed, rather than dropped because the
 * shared `ModelChoice` has nowhere structured to put it.
 *
 * Non-chat models are filtered out. The endpoint lists speech and guard models
 * alongside chat ones, and offering a transcription model in `/model` would be an
 * entry that fails on first use.
 */
export function toChoices(listed: { id: string; context_window?: number }[]): ModelChoice[] {
  return listed
    .filter((m) => !/whisper|tts|guard|prompt-?guard/i.test(m.id))
    .map((m) => ({
      id: m.id,
      label: m.id,
      description: m.context_window ? `${Math.round(m.context_window / 1000)}K context` : "served on Groq",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Fetch the models Groq is serving right now.
 *
 * Throws when the key is missing or the request fails, which is the contract the
 * registry relies on: a throw keeps the previous list, an empty array replaces it.
 */
export async function discoverModels(): Promise<ModelChoice[]> {
  return toChoices(await listModels(groqProvider));
}

/**
 * Groq caches automatically on every request, with no code change and no opt-in, and
 * reports the hit as `prompt_tokens_details.cached_tokens`. An earlier version of
 * this driver claimed it reported nothing, which made a multi-step turn count every
 * step's whole prompt as fresh and report several times the tokens it used.
 *
 * No `extraStop`: the finish reasons are the plain OpenAI set, so there is nothing
 * extra to map. That absence is deliberate.
 */
export const groqProvider: CompatProvider = {
  label: "Groq",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("groq");
  },
  apiKeyEnv: "GROQ_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit: standardCacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(groqProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(groqProvider, req, options.onEvent, options.signal);
}
