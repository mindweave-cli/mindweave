/**
 * manifest.ts — what Qwen offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, which is a thin
 * binding over the shared OpenAI-compatible layer.
 *
 * WHICH QWEN THIS IS. Qwen is served from two places that are easy to confuse:
 * Alibaba Cloud Model Studio, and QwenCloud, Qwen's own first-party API. They
 * share the DashScope key and the `compatible-mode` path, but not their model
 * lineups — the newest Max lands on QwenCloud first. This driver targets the
 * international DashScope endpoint, which is where the current generation lives.
 *
 * v1 ships the current generation only. Qwen also serves a long tail of older
 * snapshots, coder-specific variants and open-weight builds; those are deliberately
 * not offered, on the same reasoning as the other drivers — a shorter list of
 * models that are all current beats a long one the user has to date-check.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const MAX_38 = "qwen3.8-max";
export const MAX_37 = "qwen3.7-max";
export const PLUS = "qwen3.7-plus";
export const FLASH_38 = "qwen3.8-flash";
export const FLASH = "qwen3.5-flash";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = PLUS;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to Qwen.
 *
 * Plus leads rather than Max: it is roughly a sixth of Max's rate and carries the
 * same 1M window, so it is the one that is rarely the wrong answer for ordinary
 * work. The older Max stays listed because it has not been withdrawn, but it now
 * costs MORE than 3.8 Max, and its description says so rather than implying a saving.
 */
export const MODELS: ModelChoice[] = [
  { id: PLUS, label: "Qwen3.7 Plus", description: "balanced and cheap to run — the default" },
  { id: MAX_38, label: "Qwen3.8 Max", description: "the flagship, for the hardest work" },
  { id: MAX_37, label: "Qwen3.7 Max", description: "the previous flagship — pricier than 3.8 Max" },
  { id: FLASH_38, label: "Qwen3.8 Flash", description: "the newest Flash — fast and cheap" },
  { id: FLASH, label: "Qwen3.5 Flash", description: "the previous Flash, cheaper still" },
];

/**
 * The reasoning levels offered by `/think`.
 *
 * Qwen expresses reasoning as a toggle plus a TOKEN BUDGET rather than an effort
 * rung, so the shared rungs are mapped onto budgets in `client.ts`. Every model
 * here can have thinking turned off, and every one of them has it ON by default —
 * which is exactly why the off switch is always sent explicitly rather than left
 * to the provider's default. See `reasoningFields` in the client.
 */
export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
    { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "xhigh" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
  ];
}

/**
 * List prices (USD / 1M tokens), international endpoint.
 *
 * Two caveats worth knowing before trusting a figure here:
 *
 *   - Several Qwen models are TIERED BY INPUT LENGTH: crossing 32K, 128K or 256K
 *     input tokens re-rates the WHOLE request, not just the excess. The shared
 *     `ModelPrice` shape holds one rate, so these are the base tier — an estimate
 *     that is right for short requests and low for long ones. Encoding the ladder
 *     would mean changing a shared type for one provider.
 *   - The Chinese Mainland endpoint is substantially cheaper than the international
 *     one these figures come from. This driver targets international, so these are
 *     the rates that apply to it.
 */
/*
 * Checked against Alibaba's International price table 2026-09-23 (alibabacloud.com,
 * model-studio/model-pricing). Implicit cache hits bill at 20% of input EXCEPT on the
 * Qwen3.8 models, which Alibaba lists as exceptions priced in its console; their cache
 * figures are the rates OpenRouter's live listing carries for the same models.
 *
 * 3.7 Max and 3.5 Flash used to sit at half and about two thirds of their real price
 * here, so every session on them reported well under what it cost.
 */
const PRICES: Record<string, ModelPrice> = {
  [MAX_38]: { cacheHit: 0.25, cacheMiss: 2, output: 6 },
  [MAX_37]: { cacheHit: 0.5, cacheMiss: 2.5, output: 7.5 },
  // Limited-time 20% off the $0.40 / $1.60 list price.
  [PLUS]: { cacheHit: 0.064, cacheMiss: 0.32, output: 1.28 },
  [FLASH_38]: { cacheHit: 0.016, cacheMiss: 0.15, output: 0.47 },
  [FLASH]: { cacheHit: 0.02, cacheMiss: 0.1, output: 0.4 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. Every model here STORES 1M tokens, but this
 * is deliberately the sharp window rather than the storage cap: on BYOK every token
 * in the window is the user's money on every turn, so anchoring compaction at 1M
 * would mean carrying an enormous prompt long after it stopped earning its cost.
 *
 * The number is lower than the other drivers' 200K for a reason specific to this
 * provider: input length RE-RATES the whole request at 32K, 128K and 256K, so
 * letting a transcript drift past a threshold silently multiplies the cost of every
 * later turn. 128K keeps ordinary sessions under the second threshold.
 */
export function contextWindow(_model: ModelId): number {
  return 128_000;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call. Core
 * reserves exactly this much room below the window, so keeping it as one exported
 * constant means the request and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/** The effort rungs used to size a thinking budget, weakest first. */
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Vision is deliberately NOT declared, and that is the current fact rather than an
 * omission. The Max and Plus tiers do accept images, but through the multimodal
 * variants of these ids rather than the ids offered here, and Flash does not. A
 * capability that holds for some of a list and not the rest cannot be reported as a
 * flat yes — core would attach bytes that a Flash session silently cannot read.
 * Add `acceptsImages` when this driver offers a model it is true for; nothing in
 * core needs to move.
 */

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * No per-model rule to enforce: the whole lineup shares one ladder and all of it
 * can have thinking disabled. The result is snapped onto a rung `/think` actually
 * lists, so a config carried in from another provider by `/model` cannot leave the
 * user on a setting the menu has no tick beside.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const thinking = config.thinking === true;
  const effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "high";
  return { model, thinking, effort: snapToOfferedRung(model, thinking, effort) };
}

/**
 * Move an effort onto the nearest rung this model's `/think` ladder offers. Ties
 * break DOWNWARD: an unlisted setting resolves to the cheaper neighbour, because
 * silently spending more of the user's money is the worse way to be wrong.
 */
function snapToOfferedRung(model: ModelId, thinking: boolean, effort: Effort): Effort {
  const offered = thinkLevels(model).filter((l) => l.thinking === thinking);
  if (offered.length === 0) return effort;
  if (offered.some((l) => l.effort === effort)) return effort;

  const want = EFFORTS.indexOf(effort);
  let best = offered[0]!;
  for (const level of offered) {
    const d = Math.abs(EFFORTS.indexOf(level.effort) - want);
    const bestD = Math.abs(EFFORTS.indexOf(best.effort) - want);
    if (d < bestD || (d === bestD && EFFORTS.indexOf(level.effort) < EFFORTS.indexOf(best.effort))) {
      best = level;
    }
  }
  return best.effort;
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const qwenManifest: DriverManifest = {
  id: "qwen",
  label: "Qwen",
  apiKeyEnv: "DASHSCOPE_API_KEY",
  keysUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
