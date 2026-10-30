/**
 * client.ts — the custom-endpoint wire layer.
 *
 * Any server that speaks OpenAI's `/chat/completions` is served by the shared layer: the request, the streaming, the
 * tool-call assembly and the `reasoning_content` channel. What is this driver's own is small:
 *   - the model id loses Mindweave's `custom:` namespace on the way out;
 *   - the address is read on every request, because it can be changed while the app is open;
 *   - a key is sent when one was saved, and none when not, since a server on the company's own network may want none.
 *
 * Reasoning is left to the model: nothing in the request asks for it, because what a given server accepts is unknown.
 */
import type { ModelConfig, ModelRequest, StreamOptions, StreamResult, Turn, TurnOptions } from "../types.js";
import { compatStreamTurn, compatToolTurn, standardCacheSplit, type CompatProvider } from "../openaiCompat/wire.js";
import { BUFFERED_OUTPUT_TOKENS, wireId } from "./manifest.js";
import { KEY_ENV, READY_ENV, baseUrl } from "./endpoint.js";

export function reasoningFields(_config: ModelConfig | undefined): Record<string, unknown> {
  return {};
}

export function finishBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, model: wireId(String(body.model ?? "")) };
}

export const customProvider: CompatProvider = {
  label: "Custom endpoint",
  get baseUrl() {
    return baseUrl();
  },
  apiKeyEnv: READY_ENV,
  optionalKeyEnv: KEY_ENV,
  defaultModel: "",
  reasoningFields,
  cacheSplit: standardCacheSplit,
  bufferedMaxTokens: BUFFERED_OUTPUT_TOKENS,
  finishBody,
};

export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  return compatToolTurn(customProvider, req, options.signal);
}

export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  return compatStreamTurn(customProvider, req, options.onEvent, options.signal);
}
