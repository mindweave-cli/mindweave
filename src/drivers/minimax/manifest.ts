/**
 * manifest.ts — what MiniMax offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, a thin binding over
 * the shared OpenAI-compatible layer at `https://api.minimax.io/v1`.
 *
 * MiniMax carries TWO reasoning surfaces, and the two models offered here use one each:
 *
 *   - M3.1 Flash ALWAYS reasons and has one dial, `reasoning_effort`, with five rungs
 *     (low, medium, high, xhigh, max). Turning reasoning off is rejected, so it is never
 *     sent, the same shape as Kimi K3.
 *   - M3 takes `thinking: {type}` both ways — `"adaptive"` or `"disabled"` — and genuinely
 *     can turn reasoning off. It has no effort dial.
 *
 * The M2.x line (M2, M2.1, M2.5, M2.7 and the `-highspeed` variants) is retired on
 * MiniMax's own model list: closed to new users on 19 October 2026, and stops working for
 * pay-as-you-go on 18 November 2026. It is deliberately not offered. A conversation saved
 * on one of those models lands on the default (see `normalize`).
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const M31F = "MiniMax-M3.1-Flash";
export const M3 = "MiniMax-M3";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = M31F;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to MiniMax.
 *
 * M3.1 Flash leads: it is the newest, the cheapest by a factor of two, and carries the
 * same 1M context. M3 is the choice for harder work, and the one with a real
 * reasoning on/off switch.
 */
export const MODELS: ModelChoice[] = [
  { id: M31F, label: "MiniMax M3.1 Flash", description: "the newest and cheapest — always reasons, with a depth dial" },
  { id: M3, label: "MiniMax M3", description: "the flagship, with a real reasoning on/off switch" },
];

/** How one model expresses reasoning on the wire. */
export interface ModelSurface {
  /** False when the model rejects (or simply ignores) an explicit no-thinking request. */
  canDisableThinking: boolean;
  /** True when the model takes a top-level `reasoning_effort` rung (M3.1 Flash only). */
  takesEffort: boolean;
  /** Usable context window — see `contextWindow`. */
  window: number;
}

const SURFACES: Record<string, ModelSurface> = {
  [M31F]: { canDisableThinking: false, takesEffort: true, window: 200_000 },
  [M3]: { canDisableThinking: true, takesEffort: false, window: 320_000 },
};

/** The surface a model runs on, falling back to the default model's. */
export function surfaceOf(model: ModelId): ModelSurface {
  return SURFACES[model] ?? SURFACES[DEFAULT_MODEL]!;
}

/** The rungs M3.1 Flash accepts, lightest first. */
const FLASH_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The reasoning levels offered by `/think`, which depend on the model's surface.
 *
 *   - M3.1 Flash: the five effort rungs. Every one reasons; the rung sets how hard.
 *   - M3: the plain on/off pair, no effort dial.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  if (surfaceOf(model).takesEffort) {
    return [
      { label: "Low", description: "always reasons — the lightest, cheapest depth", thinking: true, effort: "low" },
      { label: "Medium", description: "a little more reasoning", thinking: true, effort: "medium" },
      { label: "High", description: "think carefully, then answer", thinking: true, effort: "high" },
      { label: "Extra high", description: "more reasoning, more tool work", thinking: true, effort: "xhigh" },
      { label: "Max", description: "the deepest reasoning, at the highest cost", thinking: true, effort: "max" },
    ];
  }
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
  ];
}

/**
 * List prices (USD / 1M tokens), read from platform.minimax.io's own pricing page:
 * M3.1 Flash is $0.15 in / $0.60 out / $0.015 cache read with no context tiers; M3 is
 * $0.30 in / $1.20 out / $0.06 cache read up to 512K input tokens. Neither lists a
 * separate cache-write rate, so `cacheWrite` is left unset, which the
 * `ModelPrice.cacheWrite` doc says falls back to `cacheMiss` — the safe default.
 */
const PRICES: Record<string, ModelPrice> = {
  [M31F]: { cacheHit: 0.015, cacheMiss: 0.15, output: 0.6 },
  // M3's ≤512K-token tier; crossing 512K doubles the whole request, which is why
  // `contextWindow` keeps this model's usable window well clear of that line.
  [M3]: { cacheHit: 0.06, cacheMiss: 0.3, output: 1.2 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window, deliberately the sharp window rather than the 1M both
 * models store: on BYOK every token in the window is the user's money on every turn, so
 * anchoring compaction at the maximum would carry an enormous prompt long after it stopped
 * earning its cost — the same reasoning, and the same range, as the other drivers. M3 also
 * bills DOUBLE above 512K on the whole request, so its window stays well clear of that line.
 */
export function contextWindow(model: ModelId): number {
  return surfaceOf(model).window;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call. Core
 * reserves exactly this much room below the context window, and `client.ts` sends
 * the same constant, so the request and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Vision is deliberately NOT declared. Both models accept image parts on MiniMax's own
 * wire, but the shared OpenAI-compatible layer does not render image parts into the
 * request, so claiming it here would promise what the request cannot carry.
 */

/**
 * Coerce a stored or unknown config onto a model this provider actually serves,
 * and keep the reasoning intent legal for it.
 *
 * A model that cannot stop reasoning always gets `thinking: true`, which is what keeps
 * `"disabled"` from ever being sent to M3.1 Flash — MiniMax answers it with an error.
 * A model with no effort dial settles on `high`, inert for it.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = SURFACES[config.model] ? config.model : DEFAULT_MODEL;
  const surface = surfaceOf(model);
  const thinking = surface.canDisableThinking ? config.thinking === true : true;
  const effort: Effort = surface.takesEffort && FLASH_EFFORTS.includes(config.effort) ? config.effort : "high";
  return { model, thinking, effort };
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const minimaxManifest: DriverManifest = {
  id: "minimax",
  label: "MiniMax",
  apiKeyEnv: "MINIMAX_API_KEY",
  keysUrl: "https://platform.minimax.io/",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
