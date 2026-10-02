/**
 * manifest.ts — what OpenAI offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code (and the SDK) live in `client.ts`, which
 * only loads once a GPT model is actually selected.
 *
 * The GPT-5.6 family — Sol, Terra and Luna — plus the newer GPT-6 flagship, Astra. They
 * share one request surface: the same context window, output ceiling and reasoning
 * ladder, so unlike the Anthropic manifest, which has to carry a table of per-model wire
 * rules, this one needs a single set of facts and a price row per model. Astra sits above
 * the 5.6 tiers on capability and on price; it is offered, not the default, because the
 * default should be the tier that is rarely the wrong answer, not the dearest one.
 *
 * Older GPT tiers (5.5, 5.4, 4.1, the o-series) are deliberately not offered. They
 * are still served, but they bring older request surfaces with different reasoning
 * support, which is a second wire path to carry for models the current family
 * already covers more cheaply.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const ASTRA = "gpt-6-astra";
export const SOL_61 = "gpt-6.1-sol";
export const SOL_6 = "gpt-6-sol";
export const LUNA_6 = "gpt-6-luna";
export const SOL = "gpt-5.6-sol";
export const TERRA = "gpt-5.6-terra";
export const LUNA = "gpt-5.6-luna";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = TERRA;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to OpenAI.
 *
 * Terra leads because it is the balanced tier — Sol is roughly 2.5x its rate and
 * Luna a tenth of it, so Terra is the one that is rarely the wrong answer.
 */
export const MODELS: ModelChoice[] = [
  { id: TERRA, label: "GPT-5.6 Terra", description: "balanced intelligence and cost — the default" },
  { id: ASTRA, label: "GPT-6 Astra", description: "the GPT-6 flagship — the most capable, and the priciest" },
  { id: SOL_61, label: "GPT-6.1 Sol", description: "the newest Sol, at GPT-6 Sol's rate" },
  { id: SOL_6, label: "GPT-6 Sol", description: "GPT-6 at Terra's input rate, with cheaper output" },
  { id: LUNA_6, label: "GPT-6 Luna", description: "the cheapest GPT-6, for high-volume work" },
  { id: SOL, label: "GPT-5.6 Sol", description: "the GPT-5.6 frontier tier" },
  { id: LUNA, label: "GPT-5.6 Luna", description: "cheap and quick, for high-volume work" },
];

/**
 * The models that cannot be asked NOT to reason. OpenAI's pages list their `effort` as
 * low, medium, high, xhigh and max: `none` is not on the list, and the reasoning guide
 * says so for both ("GPT-6 Astra does not support `none`", "GPT-6.1 Sol does not support
 * `none` or `minimal`", developers.openai.com, checked 2026-10-01). Every other model
 * here lists `none` among its efforts. Sending `none` to one of these two is the
 * request the API refuses, so the "answer directly" rung does not exist for them.
 */
const ALWAYS_REASONS = new Set<ModelId>([ASTRA, SOL_61]);

/** Whether this model accepts `reasoning.effort: "none"`, the off switch. */
export function canSkipReasoning(model: ModelId): boolean {
  return !ALWAYS_REASONS.has(model);
}

/**
 * The reasoning levels offered by `/think`.
 *
 * OpenAI expresses reasoning as a single `effort` rung with `none` as its off
 * switch, rather than a separate on/off flag plus a budget. That maps onto the
 * shared shape cleanly: `thinking: false` becomes `none` on the wire, and the four
 * thinking rungs are sent as themselves.
 *
 * The two models in `ALWAYS_REASONS` have no `none`, so their ladder starts at `low`
 * and says so: a rung that sat there as "answer directly" would be a setting that
 * ends in a refused request.
 *
 * The provider also accepts `minimal` between `none` and `low` on some models. It is not
 * offered: it would be a fifth rung whose difference from `low` no user could predict,
 * and the ladder is more useful short.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  if (!canSkipReasoning(model)) {
    return [
      { label: "Standard", description: "always thinks — lighter budget", thinking: true, effort: "low" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "medium" },
      { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "high" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
    ];
  }
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "medium" },
    { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "high" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
  ];
}

/**
 * List prices (USD / 1M tokens), short-context tier (this manifest does not model
 * OpenAI's separate long-context pricing above ~200K input — see `contextWindow`,
 * which caps the usable window below that tier anyway). Cached input bills at a
 * tenth of fresh input, which is what keeps a re-sent conversation cheap.
 *
 * Sol is running promotional pricing — $4 / $20 rather than its $5 / $30 (2.5x
 * Terra) list price — "available at least through November 21, 2026"
 * (developers.openai.com/api/docs/pricing, checked 2026-09-20). Recorded as the
 * plain current price rather than branched on the date, same call the Gemini
 * manifest makes for its own promo: a fixed expiry with no announced successor
 * price belongs in a review before that date, not a guess baked in now.
 */
const PRICES: Record<string, ModelPrice> = {
  [ASTRA]: { cacheHit: 1, cacheMiss: 10, output: 50 },
  // GPT-6 Sol and Luna: list prices, no promotion (developers.openai.com/api/docs/pricing,
  // checked 2026-09-23).
  [SOL_6]: { cacheHit: 0.2, cacheMiss: 2, output: 10 },
  // GPT-6.1 Sol: the same input and output rate as GPT-6 Sol with HALF its cache-read price
  // (developers.openai.com/api/docs/pricing, checked 2026-10-01). Over 272K input tokens the
  // whole request bills at 2x input and cache and 1.5x output; the usable window here is far
  // below that, so it is not modelled.
  [SOL_61]: { cacheHit: 0.1, cacheMiss: 2, output: 10 },
  [LUNA_6]: { cacheHit: 0.01, cacheMiss: 0.1, output: 0.5 },
  [SOL]: { cacheHit: 0.4, cacheMiss: 4, output: 20 },
  [TERRA]: { cacheHit: 0.2, cacheMiss: 2, output: 12 },
  [LUNA]: { cacheHit: 0.02, cacheMiss: 0.2, output: 1.2 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. Every model here STORES 1.05M tokens (922K of it
 * input), but this is deliberately the sharp window rather than the storage cap:
 * on BYOK every token in the window is the user's money on every turn, so
 * anchoring compaction at 1M would mean carrying an enormous prompt long after it
 * stopped earning its cost. Same reasoning, and the same number, as Anthropic's.
 */
export function contextWindow(_model: ModelId): number {
  return 200_000;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call.
 *
 * Every model here accepts 128K output, but a non-streaming request that runs that
 * long risks an HTTP timeout, so the buffered path — core's small internal calls,
 * like a compaction summary — is capped far lower. `client.ts` sends this value and
 * `dynamo/contextWindow.ts` reserves it; one exported constant means the request
 * and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 16_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/** The effort rungs this provider accepts, weakest first. */
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Every model in this family takes image input alongside text. */
export function acceptsImages(_model: ModelId): boolean {
  return true;
}

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * Two corrections. A model that cannot skip reasoning is moved onto thinking, at the
 * LIGHTEST rung rather than whatever effort the old config carried: a "no thinking" config
 * arrives from another model with effort `high`, and landing on `high` would spend more of
 * the user's money than the setting they chose. Then the result is snapped onto a rung
 * `/think` actually lists, so a config carried in from another provider by `/model` cannot
 * leave the user on a setting the menu has no tick beside.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const forcedOn = !canSkipReasoning(model) && config.thinking !== true;
  const thinking = forcedOn || config.thinking === true;
  const effort: Effort = forcedOn ? "low" : EFFORTS.includes(config.effort) ? config.effort : "high";
  return { model, thinking, effort: snapToOfferedRung(model, thinking, effort) };
}

/**
 * Move an effort onto the nearest rung this model's `/think` ladder offers.
 *
 * Ties break DOWNWARD: an unlisted setting resolves to the cheaper neighbour, never
 * the dearer one, because silently spending more of the user's money than the level
 * they were on is the worse of the two ways to be wrong.
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
export const openaiManifest: DriverManifest = {
  id: "openai",
  label: "OpenAI",
  apiKeyEnv: "OPENAI_API_KEY",
  keysUrl: "https://platform.openai.com/api-keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  acceptsImages,
  normalize,
};
