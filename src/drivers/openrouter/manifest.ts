/**
 * manifest.ts — what OpenRouter offers, and the numbers that describe it.
 *
 * A ROUTER: one key, hundreds of models from every vendor, served by whichever host
 * OpenRouter picks. The lineup changes weekly, so it is discovered (see `catalog.ts`),
 * and the per-model facts that a vendor driver would state by hand (price, window,
 * vision, reasoning ladder) come from OpenRouter's own catalogue and travel on each
 * `ModelChoice`. The functions below are only the fallbacks for a model the catalogue
 * has not described yet.
 *
 * Ids are NAMESPACED: Mindweave stores `openrouter:deepseek/deepseek-v4.1-flash`, and
 * the client strips the prefix on the wire. Without it, a router id that another
 * provider also serves (`openai/gpt-oss-120b` is an exact id on Groq too) would be
 * attributed to that provider, and choosing it here would silently run it there.
 */
import type { DriverManifest, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

/** The namespace every OpenRouter model id carries inside Mindweave. */
export const PREFIX = "openrouter:";

/** OpenRouter's own id for a namespaced one. */
export function wireId(model: ModelId): string {
  return model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model;
}

/**
 * Shown before discovery has run. The same model Mindweave defaults to elsewhere, so a
 * fresh OpenRouter user starts somewhere familiar and cheap. A fallback, never a
 * placement: the full catalogue replaces this list as soon as it arrives.
 */
export const MODELS: ModelChoice[] = [
  { id: `${PREFIX}deepseek/deepseek-v4.1-flash`, label: "DeepSeek V4.1 Flash", description: "DeepSeek" },
];

export const DEFAULT_MODEL = MODELS[0]!.id;

/**
 * Before the catalogue describes a model, offer the two states every reasoning model
 * on OpenRouter accepts. The catalogue's real ladder replaces this per model.
 */
export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "low" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
  ];
}

/** DeepSeek V4.1 Flash's catalogue price: the only model a fallback can name. */
const FALLBACK_PRICE: ModelPrice = { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 };

export function price(_model: ModelId): ModelPrice {
  return FALLBACK_PRICE;
}

/**
 * The most context Mindweave lets a transcript grow into on this provider.
 *
 * The catalogue reports each model's ADVERTISED maximum, often 1M. The window core
 * wants is the USABLE one, where retrieval stays reliable, and every vendor driver
 * sets that well below the advertised figure (DeepSeek 192K-256K, Gemini 200K) on
 * evidence that recall falls off past it. A router cannot measure hundreds of models,
 * so it applies the same ceiling, and a smaller advertised window still wins.
 */
export const USABLE_WINDOW_CAP = 200_000;

export function contextWindow(_model: ModelId): number {
  return 128_000;
}

/** The ceiling on a buffered call. Generous, because most models here reason first and
 *  a reasoning budget comes out of the same allowance as the answer. */
export const BUFFERED_OUTPUT_TOKENS = 16_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Keep the saved model even when it is not listed yet: the catalogue may not have
 * arrived, and coercing a valid choice onto the fallback would change it on every
 * launch. The registry snaps the reasoning selection onto the model's real ladder once
 * the catalogue describes it.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model = config.model || DEFAULT_MODEL;
  const thinking = config.thinking === true;
  // Onto the fallback ladder above: one effort per state.
  return { model, thinking, effort: thinking ? "high" : "low" };
}

export function ownsModel(model: ModelId): boolean {
  return model.startsWith(PREFIX);
}

export const openrouterManifest: DriverManifest = {
  id: "openrouter",
  label: "OpenRouter",
  apiKeyEnv: "OPENROUTER_API_KEY",
  keysUrl: "https://openrouter.ai/keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
  ownsModel,
  notice:
    "OpenRouter may send prompts to hosts that store or train on them. " +
    "Set MINDWEAVE_OPENROUTER_DATA=deny to use only hosts that do not.",
  // Lazy for the same reason as every discovered provider: the manifest loads for every
  // user, and the catalogue code should only load for someone who uses it.
  discoverModels: async () => (await import("./catalog.js")).discoverModels(),
};
