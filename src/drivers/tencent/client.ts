/**
 * client.ts — the Tencent Hy (TokenHub) wire layer.
 *
 * TokenHub serves an OpenAI-compatible `/chat/completions` surface, so the request
 * shape, SSE framing, fragmented tool-call arguments and the `reasoning_content`
 * channel are all handled by the shared layer in `../openaiCompat/wire.ts`. This file
 * supplies only the facts that differ.
 *
 * One of those facts is worth reading before changing anything here: thinking is ON by
 * default and must be switched off explicitly. This is the fourth provider in this
 * project with that default; it is a family pattern rather than a coincidence.
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
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL } from "./manifest.js";

/**
 * TokenHub's international endpoint. The mainland console serves the same weights
 * under different model ids on a different host, so it is an override rather than a
 * guess: a user on that account sets `MINDWEAVE_TENCENT_URL` and selects the id their
 * own console lists.
 */

/**
 * Tencent's reasoning fields.
 *
 * `thinking` is ALWAYS sent, both ways. The provider's default is enabled with an
 * effort of `high`, so omitting the field does not mean "no thinking" — it means the
 * model reasons and bills for it. Every internal call that never sets `req.model`
 * (the session summarizer, the page distiller) would quietly pay for reasoning the UI
 * discards.
 *
 * `reasoning_effort` rides along only when thinking is on, and only ever as `low` or
 * `high`: those are the two values documented, and the manifest's ladder holds
 * nothing else, so a config from another provider is already snapped to one of them
 * before it reaches here.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  const thinking = config?.thinking === true;
  const fields: Record<string, unknown> = { thinking: { type: thinking ? "enabled" : "disabled" } };
  if (thinking) fields.reasoning_effort = config?.effort === "low" ? "low" : "high";
  return fields;
}

export const tencentProvider: CompatProvider = {
  label: "Tencent",
  // Read on every request, so an address changed in the app counts at once (see endpoints.ts).
  get baseUrl() {
    return endpointUrl("tencent");
  },
  apiKeyEnv: "TOKENHUB_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  // The OpenAI-standard `prompt_tokens_details.cached_tokens`, which this endpoint
  // reports; no provider-specific reader is needed.
  cacheSplit: standardCacheSplit,
  // Must match the manifest's `bufferedOutputTokens`, which is what core reserves
  // room for below the context window.
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(tencentProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(tencentProvider, req, options.onEvent, options.signal);
}
