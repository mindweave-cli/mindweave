/**
 * client.ts — the LM Studio wire layer.
 *
 * LM Studio serves an OpenAI-compatible `/v1/chat/completions` surface on this machine, so the shared layer does the request,
 * the streaming, the tool-call assembly and the `reasoning_content` channel. What is LM Studio's own is small:
 *   - the model id loses Mindweave's `lmstudio:` namespace on the way out;
 *   - the address is read on every request, because it can be changed while the app is open;
 *   - a key is sent only when the server was started with a token required, and is never asked for.
 *
 * Reasoning is left to the model: a loaded model thinks or does not, and no field asks it to.
 */
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, wireId } from "./manifest.js";
import { RUNNING_ENV, TOKEN_ENV, baseUrl } from "./endpoint.js";

export function reasoningFields(_config: ModelConfig | undefined): Record<string, unknown> {
  return {};
}

export function finishBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, model: wireId(String(body.model ?? "")) };
}

export const lmstudioProvider: CompatProvider = {
  label: "LM Studio",
  get baseUrl() {
    return `${baseUrl()}/v1`;
  },
  apiKeyEnv: RUNNING_ENV,
  optionalKeyEnv: TOKEN_ENV,
  defaultModel: "",
  reasoningFields,
  cacheSplit: standardCacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
  finishBody,
};

export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(lmstudioProvider, req, options.signal);
}

export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(lmstudioProvider, req, options.onEvent, options.signal);
}
