/**
 * manifest.ts — models running on this machine through LM Studio.
 *
 * LOCAL: no account, nothing leaves the machine, nothing is billed. The lineup is whatever is downloaded into LM Studio,
 * so it is discovered (see `catalog.ts`), and each model's facts come from the server on each `ModelChoice`. The functions
 * below are the fallbacks for a model not described yet.
 *
 * Ids are NAMESPACED: Mindweave stores `lmstudio:qwen3-8b`, and the client strips the prefix on the wire.
 */
import type { DriverManifest, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";
import { FREE, SERVER_WINDOW_DEFAULT, normalizeServer, stripPrefix, thinkLevels as serverThinkLevels } from "../openaiCompat/server.js";
import { RUNNING_ENV, URL_ENV, parseAddress } from "./endpoint.js";

/** The namespace every LM Studio model id carries inside Mindweave. */
export const PREFIX = "lmstudio:";

/** LM Studio's own name for a namespaced id. */
export function wireId(model: ModelId): string {
  return stripPrefix(PREFIX, model);
}

export function price(_model: ModelId): ModelPrice {
  return FREE;
}

export function thinkLevels(model: ModelId): ThinkLevel[] {
  return serverThinkLevels(model);
}

/** Until the server says what a model holds. LM Studio loads a model with its own default, often 4,096 tokens. */
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

export const lmstudioManifest: DriverManifest = {
  id: "lmstudio",
  label: "LM Studio",
  apiKeyEnv: RUNNING_ENV,
  keysUrl: "https://lmstudio.ai/download",
  local: true,
  // Empty until discovery: only what is downloaded into LM Studio is offered.
  models: [],
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
  ownsModel,
  setup: { addressEnv: URL_ENV, placeholder: "192.168.1.20:1234", parse: parseAddress, current: () => process.env[URL_ENV]?.trim() ?? "" },
  discoverModels: async () => (await import("./catalog.js")).discoverModels(),
};
