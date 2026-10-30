/**
 * client.ts — the llama.cpp wire layer.
 *
 * `llama-server` serves an OpenAI-compatible `/v1/chat/completions` surface, so the shared layer does the request, the
 * streaming, the tool-call assembly and the `reasoning_content` channel. What is llama.cpp's own is small:
 *   - the model id loses Mindweave's `llamacpp:` namespace on the way out;
 *   - the address is read on every request (it can be changed, or found by discovery);
 *   - a key is sent only when the server was started with one required, and is never asked for.
 *
 * Reasoning is left to the model: no field asks for it.
 */
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, wireId } from "./manifest.js";
import { KEY_ENV, RUNNING_ENV, baseUrl } from "./endpoint.js";

export function reasoningFields(_config: ModelConfig | undefined): Record<string, unknown> {
  return {};
}

export function finishBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, model: wireId(String(body.model ?? "")) };
}

export const llamacppProvider: CompatProvider = {
  label: "llama.cpp",
  get baseUrl() {
    return `${baseUrl()}/v1`;
  },
  apiKeyEnv: RUNNING_ENV,
  optionalKeyEnv: KEY_ENV,
  defaultModel: "",
  reasoningFields,
  cacheSplit: standardCacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
  finishBody,
};

export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(llamacppProvider, req, options.signal);
}

export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(llamacppProvider, req, options.onEvent, options.signal);
}
