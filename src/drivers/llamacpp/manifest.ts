/**
 * manifest.ts — a model running on this machine through llama.cpp's `llama-server`.
 *
 * LOCAL: no account, nothing leaves the machine, nothing is billed. A llama-server runs ONE model, the one it was started
 * with, so the lineup is that single entry, discovered (see `catalog.ts`) along with the context it was started with.
 *
 * Ids are NAMESPACED: Mindweave stores `llamacpp:<the server's own name for it>`, and the client strips the prefix on the
 * wire. The agent needs the server to run with its chat template enabled so tool calls work (`--jinja`, on by default in
 * current builds).
 */
import type { DriverManifest, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";
import { FREE, SERVER_WINDOW_DEFAULT, normalizeServer, stripPrefix, thinkLevels as serverThinkLevels } from "../openaiCompat/server.js";
import { RUNNING_ENV, URL_ENV, ownUrl, parseAddress } from "./endpoint.js";

/** The namespace every llama.cpp model id carries inside Mindweave. */
export const PREFIX = "llamacpp:";

/** The server's own name for a namespaced id. */
export function wireId(model: ModelId): string {
  return stripPrefix(PREFIX, model);
}

export function price(_model: ModelId): ModelPrice {
  return FREE;
}

export function thinkLevels(model: ModelId): ThinkLevel[] {
  return serverThinkLevels(model);
}

/** Until the server says what it was started with. */
export function contextWindow(_model: ModelId): number {
  return SERVER_WINDOW_DEFAULT;
}

/** A buffered call's ceiling, well inside the window it shares. */
export const BUFFERED_OUTPUT_TOKENS = 4_096;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

export function normalize(config: ModelConfig): ModelConfig {
  return normalizeServer(config);
}

export function ownsModel(model: ModelId): boolean {
  return model.startsWith(PREFIX);
}

export const llamacppManifest: DriverManifest = {
  id: "llamacpp",
  label: "llama.cpp",
  apiKeyEnv: RUNNING_ENV,
  keysUrl: "https://github.com/ggml-org/llama.cpp",
  local: true,
  // Empty until discovery: only the model the server was started with is offered.
  models: [],
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
  ownsModel,
  setup: { addressEnv: URL_ENV, placeholder: "192.168.1.20:8080", parse: parseAddress, current: () => ownUrl() },
  discoverModels: async () => (await import("./catalog.js")).discoverModels(),
};
