/**
 * manifest.ts — what MiniMax offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, a thin binding over
 * the shared OpenAI-compatible layer at `https://api.minimax.io/v1`.
 *
 * MiniMax carries TWO reasoning surfaces, the same shape Kimi's manifest needed
 * and for the same reason:
 *
 *   - M3 takes `thinking: {type}` both ways — `"adaptive"` or `"disabled"` — and
 *     genuinely can turn reasoning off.
 *   - M2.7 and M2 also take `thinking: {type}`, but MiniMax's own docs are
 *     explicit that the M2.x family "cannot disable thinking regardless of
 *     settings" — so `"disabled"` is sent to neither; both always reason.
 *
 * None of the three exposes a graded effort rung (no low/medium/high — just the
 * type field), so `/think` on this provider is genuinely a two-state or one-state
 * menu, not a shortened ladder.
 *
 * Older tiers (MiniMax-01, M1, M2.1, M2.5, and the `-highspeed` variants) are
 * still served and deliberately not offered: this lineup already covers cheap,
 * mid, and flagship, and the older tiers bring no capability these three lack.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const M2 = "MiniMax-M2";
export const M27 = "MiniMax-M2.7";
export const M3 = "MiniMax-M3";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = M27;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to MiniMax.
 *
 * M2.7 leads rather than M3: their ≤512K-token rates are actually equal (see
 * `PRICES`), but M3 doubles past that line (see `contextWindow`) while M2.7 never
 * does, so M2.7 is the deliberate default — never worse, sometimes cheaper — and
 * M3 the choice for harder work specifically, not something to drift into.
 */
export const MODELS: ModelChoice[] = [
  { id: M27, label: "MiniMax M2.7", description: "the current general-purpose model — the default" },
  { id: M3, label: "MiniMax M3", description: "the flagship, with a real reasoning on/off switch" },
  { id: M2, label: "MiniMax M2", description: "the older, cheaper tier, for simple work" },
];

/** How one model expresses reasoning on the wire. */
export interface ModelSurface {
  /** False when the model rejects (or simply ignores) an explicit no-thinking request. */
  canDisableThinking: boolean;
  /** Usable context window — see `contextWindow`. */
  window: number;
}

const SURFACES: Record<string, ModelSurface> = {
  [M3]: { canDisableThinking: true, window: 320_000 },
  [M27]: { canDisableThinking: false, window: 180_000 },
  [M2]: { canDisableThinking: false, window: 180_000 },
};

/** The surface a model runs on, falling back to the default model's. */
export function surfaceOf(model: ModelId): ModelSurface {
  return SURFACES[model] ?? SURFACES[DEFAULT_MODEL]!;
}

/**
 * The reasoning levels offered by `/think`, which depend on the model's surface.
 *
 *   - M3: the plain on/off pair, no effort dial.
 *   - M2.7 / M2: ONE level. Both always reason and neither has an effort dial, so
 *     there is genuinely one setting. A single-entry menu is honest; inventing a
 *     second that did nothing would not be.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  const surface = surfaceOf(model);
  if (!surface.canDisableThinking) {
    return [{ label: "Thinking", description: "this model always reasons", thinking: true, effort: "high" }];
  }
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
  ];
}

/**
 * List prices (USD / 1M tokens), confirmed against platform.minimax.io's own
 * pay-as-you-go page (docs/guides/pricing-paygo) rather than carried forward or
 * estimated: M2 and M2.7 share the same input/output rate and differ only in their
 * cache-read rate (M2's cache is cheaper, at half M2.7's), and M3's own cache rate
 * IS separately published now — it matches M2.7's, not a guessed ratio.
 * `cacheWrite` is confirmed for M2 and M2.7 (both publish a distinct write rate);
 * M3's write rate is not separately published, so it is left unset, which the
 * `ModelPrice.cacheWrite` doc says falls back to `cacheMiss` — the safe default.
 */
const PRICES: Record<string, ModelPrice> = {
  [M27]: { cacheHit: 0.06, cacheMiss: 0.3, output: 1.2, cacheWrite: 0.375 },
  // M3's ≤512K-token tier; crossing 512K doubles the whole request, which is why
  // `contextWindow` keeps this model's usable window well clear of that line.
  [M3]: { cacheHit: 0.06, cacheMiss: 0.3, output: 1.2 },
  [M2]: { cacheHit: 0.03, cacheMiss: 0.3, output: 1.2, cacheWrite: 0.375 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. M2.7 and M2 store roughly 205K; M3 stores
 * 1M but bills DOUBLE above 512K on the whole request, the same shape as xAI's
 * Grok 4.3 and Gemini's 3.1 Pro. Same reasoning as both: stay clear of the cliff
 * rather than anchor compaction at the edge of it.
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
 * Vision is deliberately NOT declared. MiniMax's -01 line reads images, but the
 * three models offered here are text-only, and the shared OpenAI-compatible wire
 * layer does not render image parts into the request regardless.
 */

/** The one effort rung this provider's ladders use — there is no graded scale to
 *  snap onto, only the on/off pair `thinkLevels` already lists. */
const EFFORTS: Effort[] = ["high"];

/**
 * Coerce a stored or unknown config onto a model this provider actually serves,
 * and keep the reasoning intent legal for it.
 *
 * A model that cannot stop reasoning always gets `thinking: true`, which is what
 * keeps `"disabled"` from ever being sent to M2.7 or M2 — MiniMax's own docs say
 * the family ignores it, but a request should not depend on a provider ignoring
 * something incorrectly asked for.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = SURFACES[config.model] ? config.model : DEFAULT_MODEL;
  const surface = surfaceOf(model);
  const thinking = surface.canDisableThinking ? config.thinking === true : true;
  const effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "high";
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
