/**
 * manifest.ts — what DeepSeek offers, and the numbers that describe it.
 *
 * Everything here is DeepSeek-specific by design: the model list `/model` shows,
 * the reasoning levels `/think` shows, list prices, and the usable context window.
 * A new provider supplies its own version of this file and nothing in core changes.
 *
 * This file is loaded even when the user is running a different provider, so it
 * stays plain data and pure functions. The wire code lives in `client.ts`, which
 * only loads once DeepSeek is actually selected.
 *
 * `deepseek-v4-flash` is V4.1 Flash: an OpenAI-compatible model that stores 1M
 * tokens, reads images natively, and supports Thinking / Non-Thinking modes. The id
 * is a route DeepSeek keeps serving; `deepseek-flash` is its canonical name for the
 * same model, so a maintainer can switch to that the day the route is retired.
 *
 * `deepseek-v4-pro` is the stronger model. It was expected to fold into V4.1 Flash on
 * 2026-09-14 (see git history for the retired PRO_SUNSET_MS), but DeepSeek's own docs
 * confirm it did not: Pro continues as its own model with its own pricing, unchanged,
 * past that date (api-docs.deepseek.com/quick_start/pricing/, checked 2026-09-20). The
 * separate `deepseek-v4-flash-vision-exp` model is gone: its images are now native to
 * Flash, and normalize migrates the old id across.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const FLASH = "deepseek-v4-flash";
export const PRO = "deepseek-v4-pro";
/** The pre-4.1 vision model's id. It no longer names a model of its own — Flash reads
 *  images now — so it survives only as an alias normalize maps onto Flash. */
export const VISION_LEGACY = "deepseek-v4-flash-vision-exp";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = FLASH;

/** The models offered by `/model`. First entry is the default. */
export const MODELS: ModelChoice[] = [
  { id: FLASH, label: "DeepSeek V4.1 Flash", description: "fast, cheap, reads images — the default" },
  { id: PRO, label: "DeepSeek V4 Pro", description: "stronger, for harder work" },
];

/**
 * The effort values DeepSeek's API actually accepts for `reasoning_effort`.
 *
 * The shared `Effort` type is the union of every provider's ladder and includes
 * rungs DeepSeek has never had (`medium`, `xhigh` — those are Anthropic's). Sending
 * one is not a soft failure: it's a value the API does not recognize. So this set
 * is the authority, `normalize` clamps to it, and a test asserts every level we
 * advertise survives that clamp.
 */
const ACCEPTED_EFFORTS = new Set<Effort>(["low", "high", "max"]);

/**
 * The reasoning levels offered by `/think`. DeepSeek V4 exposes thinking as a toggle
 * on the same model id plus a `reasoning_effort` budget, so the whole space is:
 *
 *   Standard (no thinking) · High (thinking, high) · Maximum (thinking, max)
 *
 * Pro's Maximum sends `max`. It previously sent `xhigh`, which DeepSeek does not
 * accept, so that level had never done anything — the rung had leaked in from the
 * shared type when a second provider was added.
 *
 * FLASH HAS A MAXIMUM TIER TOO, and used to be denied one here. The fix that removed
 * `xhigh` also scoped Maximum to Pro, on the assumption that the cheaper model had a
 * shorter ladder. It does not: DeepSeek documents `reasoning_effort` as low/high/max
 * for V4 Flash as well, unscoped by model. Withholding it meant the DEFAULT model —
 * the one most sessions run — silently could not reach its top reasoning setting.
 *
 * The ladder is identical for both, so it is built once. What differs between Flash
 * and Pro is the size of the model underneath, not the settings it accepts.
 */
export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "High", description: "think first, then answer", thinking: true, effort: "high" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
  ];
}

// DeepSeek list prices (USD / 1M), verified against api-docs.deepseek.com/quick_start/pricing/
// (checked 2026-09-20). Cache hits are far cheaper than misses — the whole reason
// re-sent context stays cheap. Both models are billed on two clocks: peak hours
// (01:00–04:00 and 06:00–10:00 UTC, Monday–Friday) cost twice the off-peak rate. The
// off-peak rate is recorded here, because it is the one a session pays for most of the
// week — Flash peak is 0.006 / 0.30 / 1.20, Pro peak is 0.044 / 1.32 / 3.96. A user who
// runs mostly in peak windows can override.
const PRICES: Record<string, ModelPrice> = {
  [FLASH]: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  [PRO]: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
};
const DEFAULT_PRICE: ModelPrice = PRICES[FLASH]!;

/** Cache-aware list price for a model, falling back to Flash's for unknown ids. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? DEFAULT_PRICE;
}

/**
 * The model's USABLE context window — where retrieval and attention stay reliable,
 * not the raw storage cap. Both models store 1M tokens (native pretraining, not a
 * RoPE-extended stretch), but V4 runs hybrid sparse attention (CSA at 4x KV
 * compression alternating with HCA at 128x), and compression is where accuracy
 * leaks at range.
 *
 * The number that matters for an agent is MULTI-needle retrieval, not single: a
 * coding session recalls many scattered facts (files read, decisions made, which
 * command failed), which is the multi-needle shape. That is also V4's weakest
 * axis — its single-to-multi drop at 1M is the largest in the field.
 *
 * Published V4-Pro figures (NIAH-2 / MRCR):
 *   200K  single 96%   multi-8 84%
 *   256K              multi-8 ~0.82   ← still flat
 *   1M    single 78%   multi-8 41%    ← cliff
 *
 * So Pro anchors at 256K: the top of the demonstrated flat region. Past it the
 * evidence thins to a single bad endpoint, and on BYOK the user pays for every
 * token we let the transcript grow into.
 */
const PRO_WINDOW = 256_000;

/**
 * Flash gets its own, lower value rather than inheriting Pro's curve.
 *
 * There is NO published multi-needle data for V4.1 Flash at any length, and its
 * causal encoder–decoder architecture is not the one Pro's curve was measured on, so
 * Pro's numbers cannot be borrowed. 192K is a deliberate judgment call under absent
 * data: clearly above the old shared 128K, clearly inside Pro's proven-flat region,
 * and revisable the moment someone publishes a Flash multi-needle curve.
 */
const FLASH_WINDOW = 192_000;

export function contextWindow(model: ModelId): number {
  return model === PRO ? PRO_WINDOW : FLASH_WINDOW;
}

/**
 * V4.1 Flash reads images natively; V4 Pro does not.
 *
 * The check is by id, not by provider, because the two models differ: an image
 * pointed at Pro degrades before anything is sent, which is what core does with a
 * false answer here. Vision used to live in a separate model; it is folded into Flash
 * now, and the old vision id reaches this as Flash after normalize migrates it.
 */
export function acceptsImages(model: ModelId): boolean {
  return model === FLASH;
}

/**
 * Coerce a stored or unknown config onto a model this driver actually serves, and
 * keep the reasoning intent valid. DeepSeek accepts three of the five shared effort
 * rungs (`low`, `high`, `max`), so anything else clamps to `high`.
 *
 * Both models take the same three rungs, so switching between them preserves the
 * user's reasoning choice instead of quietly demoting it.
 */
export function normalize(config: ModelConfig): ModelConfig {
  // Anything that is not an explicit Pro selection resolves to Flash. That folds in
  // both the pre-4.1 vision id and the plain `deepseek-v4-flash` id, and it means a
  // config saved by a build that named some other DeepSeek model opens on the default
  // rather than on a model this build cannot serve.
  const model: ModelId = config.model === PRO ? PRO : FLASH;
  const thinking = config.thinking === true;
  // Anything outside DeepSeek's accepted set becomes `high`. That covers a config
  // saved by an older build (which stored `xhigh`) and a rung belonging to another
  // provider. `max` is accepted on both models and is not stepped down.
  const effort: Effort = ACCEPTED_EFFORTS.has(config.effort) ? config.effort : "high";
  return { model, thinking, effort };
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const deepseekManifest: DriverManifest = {
  id: "deepseek",
  label: "DeepSeek",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  keysUrl: "https://platform.deepseek.com/api_keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  acceptsImages,
  normalize,
};
