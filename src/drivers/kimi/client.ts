/**
 * client.ts — the Kimi wire layer.
 *
 * Kimi serves an OpenAI-compatible `/chat/completions` surface, so the request
 * shape, SSE framing, fragmented tool-call arguments and the `reasoning_content`
 * channel are all handled by the shared layer in `../openaiCompat/wire.ts`. This
 * file supplies only the facts that differ.
 *
 * The one genuinely Kimi-specific part is `reasoningFields`, because this lineup
 * does not agree with ITSELF about how reasoning is expressed — see below.
 */
import { endpointUrl } from "../endpoints.js";
import type {
  ModelConfig,
  ModelRequest,
  StreamOptions,
  StreamResult,
  Turn,
  TurnOptions,
} from "../types.js";
import { compatStreamTurn, compatToolTurn, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, isCodeModel, surfaceOf } from "./manifest.js";

/** Moonshot's international endpoint, which is where these model ids are served. */

/** The model a request runs on, matching the shared layer's own fallback so the
 *  reasoning fields can never be built for a different model than is being called. */
function modelOf(config: ModelConfig | undefined): string {
  return config?.model ?? process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;
}

/**
 * Kimi's reasoning fields — three shapes across one lineup.
 *
 *   - K3 has NO `thinking` parameter. It takes a top-level `reasoning_effort`, and
 *     it reasons on every response whether asked to or not. Sending `thinking` here
 *     would be a parameter the model does not know.
 *   - K2.7 Code takes `thinking: {type}` but accepts only `"enabled"`; `"disabled"`
 *     is a rejected request rather than a soft no-op.
 *   - K2.6 and K2.5 take `thinking: {type}` both ways, and default to ENABLED — so
 *     the off switch is sent explicitly, exactly as on Qwen and DeepSeek. Omitting
 *     it would mean every internal call (the summarizer, the page distiller) quietly
 *     paying for reasoning the UI then discards.
 *
 * `normalize` has already made the config legal for the model, so this only renders
 * it. The model is resolved the same way the shared layer resolves it, so the two
 * can never disagree about which model's rules apply.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  // A Kimi Code membership id takes whatever the service decides: nothing is sent.
  if (isCodeModel(modelOf(config))) return {};
  const surface = surfaceOf(modelOf(config));

  if (surface.takesEffort) {
    // K3: always reasons; the rung is the only choice. `normalize` has already
    // clamped it to a value this model accepts.
    return { reasoning_effort: config?.effort ?? "high" };
  }

  if (!surface.canDisableThinking) return { thinking: { type: "enabled" } };

  return { thinking: { type: config?.thinking ? "enabled" : "disabled" } };
}

/**
 * Kimi reports its cache hit as `cached_tokens` on the usage object, where
 * `prompt_tokens` is the FULL prompt including the cached part — so the miss side
 * is the remainder rather than a separate figure to add. The nested
 * `prompt_tokens_details` shape is read too, since the platform reports it both
 * ways depending on the model.
 */
export function cacheSplit(usage: Record<string, unknown>): { hit: number; miss: number } | undefined {
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const nested = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
  const flat = typeof usage.cached_tokens === "number" ? (usage.cached_tokens as number) : 0;
  const hit = nested || flat;
  if (hit === 0) return undefined;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  return { hit, miss: Math.max(0, prompt - hit) };
}

/**
 * Everything the shared wire layer needs to talk to Kimi.
 *
 * No `extraStop`: this platform documents exactly the OpenAI vocabulary
 * (`stop` / `length` / `tool_calls`), so there is nothing extra to map. Stated
 * rather than left blank, because an absent mapper is otherwise indistinguishable
 * from a forgotten one.
 */
export const kimiProvider: CompatProvider = {
  label: "Kimi",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("kimi");
  },
  apiKeyEnv: "MOONSHOT_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  cacheSplit,
  // Must match the manifest's `bufferedOutputTokens`, which is what core reserves
  // room for below the context window.
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(kimiProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(kimiProvider, req, options.onEvent, options.signal);
}
