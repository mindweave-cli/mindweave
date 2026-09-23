/**
 * client.ts — the xAI wire layer.
 *
 * xAI serves an OpenAI-compatible `/chat/completions` surface, so the request shape,
 * SSE framing, fragmented tool-call arguments and the `reasoning_content` channel
 * are all handled by the shared layer in `../openaiCompat/wire.js`. This file
 * supplies only the facts that differ.
 */
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
import { ALWAYS_ON_DEFAULT, BUFFERED_OUTPUT_TOKENS, DEFAULT_MODEL, canDisableReasoning, takesEffort } from "./manifest.js";

const BASE_URL = process.env.MINDWEAVE_XAI_URL ?? "https://api.x.ai/v1";

/** The model a request runs on, matching the shared layer's own fallback so the
 *  reasoning fields can never be built for a different model than is being called. */
function modelOf(config: ModelConfig | undefined): string {
  return config?.model ?? process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL;
}

/**
 * xAI's reasoning fields.
 *
 * Two shapes, one per kind of model (see the manifest). Grok 4.3 can be switched
 * off, so it is sent `none` when thinking is off. Grok 4.5-4.7 always reason and do
 * not accept `none`: they are sent the depth, and never an off switch. `normalize`
 * has already put a legal rung in the config; the fallback here is xAI's own default,
 * so an unnormalized config cannot send anything the model would not have run anyway.
 */
export function reasoningFields(config: ModelConfig | undefined): Record<string, unknown> {
  const model = modelOf(config);
  if (!takesEffort(model)) return {};
  if (canDisableReasoning(model)) {
    return { reasoning_effort: config?.thinking ? (config.effort ?? "low") : "none" };
  }
  return { reasoning_effort: config?.thinking ? (config.effort ?? ALWAYS_ON_DEFAULT) : ALWAYS_ON_DEFAULT };
}

/**
 * `end_turn` is xAI's own spelling of a normal finish, alongside the standard
 * `stop`. It already falls through to `"end"`, but it is mapped explicitly so the
 * value is recorded as KNOWN — an unrecognised reason reaching the default is
 * exactly how a real stop condition gets reported as a clean finish elsewhere.
 */
export function extraStop(reason: string): StopReason | undefined {
  return reason === "end_turn" ? "end" : undefined;
}

/** xAI reports its cache hit as `prompt_tokens_details.cached_tokens`, where
 *  `prompt_tokens` is the FULL prompt including the cached part. */
export function cacheSplit(usage: Record<string, unknown>): { hit: number; miss: number } | undefined {
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const hit = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
  if (hit === 0) return undefined;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  return { hit, miss: Math.max(0, prompt - hit) };
}

/** Everything the shared wire layer needs to talk to xAI. */
export const xaiProvider: CompatProvider = {
  label: "xAI",
  baseUrl: BASE_URL,
  apiKeyEnv: "XAI_API_KEY",
  defaultModel: process.env.MINDWEAVE_MODEL ?? DEFAULT_MODEL,
  reasoningFields,
  extraStop,
  cacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
};

/** Ask the model for one turn. */
export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(xaiProvider, req, options.signal);
}

/** Ask the model for one turn, streaming deltas to `options.onEvent`. */
export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(xaiProvider, req, options.onEvent, options.signal);
}
