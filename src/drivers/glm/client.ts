/**
 * client.ts — the GLM (Z.ai) wire layer.
 *
 * GLM serves an OpenAI-compatible `/chat/completions` surface, so the request
 * shape, SSE framing, fragmented tool-call arguments and the `reasoning_content`
 * channel are all handled by the shared layer in `../openaiCompat/wire.ts`. This
 * file supplies only the facts that differ.
 *
 * Two of those facts are worth reading before changing anything here: thinking is
 * ON by default and must be switched off explicitly, and this provider's
 * `finish_reason` vocabulary is the widest of any driver in the project — three
 * values outside the OpenAI set, two of which would otherwise be reported as a
 * clean finish.
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
import { compatStreamTurn, compatToolTurn, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, takesEffort } from "./manifest.js";

/**
 * Z.ai's international OpenAI-compatible endpoint. The China platform
 * (`open.bigmodel.cn`) serves the same model ids at different prices on a
 * different key, so it is an override rather than a guess: a user on that account
 * sets `MINDWEAVE_GLM_URL` and everything else works unchanged.
 */

/** The model a request runs on, matching the shared layer's own fallback so the
 *  reasoning fields can never be built for a different model than is being called. */
function modelOf(config: ModelConfig | undefined): string {
  return config?.model ?? process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;
}

/**
 * GLM's reasoning fields.
 *
 * `thinking` is ALWAYS sent, both ways. The provider's default is `enabled`, so
 * omitting the field does not mean "no thinking" — it means the model reasons and
 * bills for it. Every internal call that never sets `req.model` (the session
 * summarizer, the page distiller) would quietly pay for reasoning the UI discards.
 * This is the third provider in this project with that exact default; it is a
 * family pattern rather than a coincidence.
 *
 * `reasoning_effort` rides along only on the model that has the dial. Sending it to
 * one that does not is a parameter the model has never heard of, not a soft no-op.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  const thinking = config?.thinking === true;
  const fields: Record<string, unknown> = { thinking: { type: thinking ? "enabled" : "disabled" } };
  if (thinking && takesEffort(modelOf(config))) {
    fields.reasoning_effort = config?.effort ?? "high";
  }
  return fields;
}

/**
 * Map this provider's own `finish_reason` values onto the shared set.
 *
 * The widest extra vocabulary of any driver here, and two of the three matter a
 * great deal: without a case, `sensitive` and `model_context_window_exceeded` both
 * fall through to `"end"`, so a refused reply and an overflowed conversation are
 * each reported to the engine as a clean, complete finish.
 */
export function extraStop(reason: string): StopReason | undefined {
  switch (reason) {
    case "sensitive":
      return "refused";
    case "model_context_window_exceeded":
      return "overflow";
    case "network_error":
      return "overloaded";
    default:
      return undefined;
  }
}

/**
 * GLM reports its cache hit as `prompt_tokens_details.cached_tokens`, where
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

/** Everything the shared wire layer needs to talk to GLM. */
export const glmProvider: CompatProvider = {
  label: "GLM",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("glm");
  },
  apiKeyEnv: "ZAI_API_KEY",
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
  return compatToolTurn(glmProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(glmProvider, req, options.onEvent, options.signal);
}
