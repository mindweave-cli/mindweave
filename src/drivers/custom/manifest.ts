/**
 * manifest.ts — a server of the person's own choosing that speaks the OpenAI chat wire.
 *
 * The lineup is whatever the server lists (see `catalog.ts`), plus any model ids typed by hand, and each model carries the
 * facts the server reported. The functions below are the fallbacks for a model not described yet. What this driver cannot
 * know is what the server charges, unless it lists a price, and where the prompts go: the notice says so.
 *
 * Ids are NAMESPACED: Mindweave stores `custom:<the server's own id>`, and the client strips the prefix on the wire.
 */
import type { DriverManifest, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";
import { FREE, normalizeServer, stripPrefix, thinkLevels as serverThinkLevels, toChoice } from "../openaiCompat/server.js";
import { DEFAULT_WINDOW, assumedWindow, baseUrl, parseAddress, READY_ENV, KEY_ENV, MODELS_ENV, typedModels, URL_ENV, WINDOW_ENV } from "./endpoint.js";

/** The namespace every custom-endpoint model id carries inside Mindweave. */
export const PREFIX = "custom:";

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

export function contextWindow(_model: ModelId): number {
  return assumedWindow();
}

/** A buffered call's ceiling. Modest, because the server's own limits are unknown. */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

export function normalize(config: ModelConfig): ModelConfig {
  return normalizeServer(config);
}

export function ownsModel(model: ModelId): boolean {
  return model.startsWith(PREFIX);
}

/** The ids typed by hand, offered whether or not the server lists them, and before anything it lists. */
export function typedChoices(): ModelChoice[] {
  return typedModels().map((id) => toChoice(PREFIX, { id, window: assumedWindow(), note: "price not tracked" }, "typed in"));
}

export const customManifest: DriverManifest = {
  id: "custom",
  label: "Custom endpoint",
  apiKeyEnv: READY_ENV,
  keysUrl: "https://platform.openai.com/docs/api-reference/chat",
  // The server's own list replaces this once it answers.
  models: [],
  extraModels: typedChoices,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
  ownsModel,
  notice:
    "Your prompts go to the address you entered, and Mindweave cannot know what that server stores or charges. " +
    "Only point it at a server you trust.",
  setup: {
    addressEnv: URL_ENV,
    keyEnv: KEY_ENV,
    modelsEnv: MODELS_ENV,
    windowEnv: WINDOW_ENV,
    defaultWindow: DEFAULT_WINDOW,
    placeholder: "https://api.together.xyz/v1",
    parse: parseAddress,
    current: baseUrl,
  },
  discoverModels: async () => (await import("./catalog.js")).discoverModels(),
};
