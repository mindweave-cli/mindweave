/**
 * manifest.ts — what Meta offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, a thin binding over
 * the shared OpenAI-compatible layer — Meta's Model API serves an explicitly
 * "OpenAI-compatible" `/chat/completions` surface at `https://api.meta.ai/v1`.
 *
 * Meta retired its hosted Llama API in July 2026; Llama itself is not served here
 * at all any more. Muse Spark, a closed model from the newly formed Meta
 * Superintelligence Labs, is the only thing on this endpoint now. 1.1 is
 * deliberately not offered: 1.3 and 1.2 both supersede it at the same price, the
 * same superseded-tier rule every other driver here follows. 1.2 stays because a
 * saved config naming it must keep working and because its rates are unchanged.
 *
 * MUSE SPARK ALWAYS REASONS. `reasoning_effort` takes `minimal` through `xhigh`, and
 * `none` is refused with a 400. Omitting the field does not buy a direct answer — it
 * buys reasoning at whatever depth Meta picks. This driver once declared the dial did
 * not exist at all, which left every call reasoning at that default with nothing for
 * the user to turn.
 *
 * THE CONTRIBUTOR TIER. This is the one fact in this file worth reading twice. A
 * `-contributor` id is not a cheaper flag on the same model — it is a SEPARATE
 * model id whose price is roughly 12x lower than Standard in exchange for
 * Meta training on your prompts and completions. Both directions are real: the
 * discount is real, and so is the data use. Neither is the default. See `MODELS`
 * below for how that trade-off is worded to the person choosing it.
 *
 * `"max"` — reasoning beyond `xhigh` — exists on the wire too, but Meta's own docs
 * scope it to Standard-tier `muse-spark-1.3` only ("not available on Contributor-tier
 * models"); 1.2 is not mentioned either way, so it is not assumed there. `thinkLevels`
 * is the one function in this file that reads `model` rather than treating every id
 * the same, purely to gate this one rung.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const MUSE_SPARK_13 = "muse-spark-1.3";
export const MUSE_SPARK_13_CONTRIBUTOR = "muse-spark-1.3-contributor";
export const MUSE_SPARK_12 = "muse-spark-1.2";
export const MUSE_SPARK_12_CONTRIBUTOR = "muse-spark-1.2-contributor";

/** The model used when nothing is saved and no env override is set. Standard
 *  tier, so no one is opted into sharing their data with anything but a choice. */
export const DEFAULT_MODEL = MUSE_SPARK_13;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to Meta.
 *
 * The contributor entry's description states the trade-off in the picker itself,
 * not just in a comment nobody choosing it will read: what it costs, and what you
 * give up for that price. A model this consequential does not get a euphemism.
 */
export const MODELS: ModelChoice[] = [
  { id: MUSE_SPARK_13, label: "Muse Spark 1.3", description: "the default — your prompts stay yours" },
  {
    id: MUSE_SPARK_13_CONTRIBUTOR,
    label: "Muse Spark 1.3 (Contributor)",
    description: "~12x cheaper input — in exchange, Meta trains on your prompts and completions",
  },
  { id: MUSE_SPARK_12, label: "Muse Spark 1.2", description: "the previous Spark, at the same rate" },
  {
    id: MUSE_SPARK_12_CONTRIBUTOR,
    label: "Muse Spark 1.2 (Contributor)",
    description: "the previous Spark, on the same data-for-price trade",
  },
];

/**
 * The reasoning levels offered by `/think`.
 *
 * Muse Spark reasons whether or not a request says so, and `reasoning_effort: "none"`
 * is the one value Meta refuses with a 400 — so there is no rung that skips thinking,
 * and none is offered. What the dial does control is depth: `minimal`, `low`,
 * `medium`, `high`, `xhigh` and (Standard-tier 1.3 only) `max` are all accepted.
 *
 * Four of the six are listed. `minimal` and `low` differ by less than the choice
 * costs a person reading a menu, and a ladder is only useful if each rung is a
 * decision someone can act on. `max` is real but scoped — see the file header —
 * so it is only added for the one id it is documented to exist on.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  const levels: ThinkLevel[] = [
    { label: "Light", description: "reasons briefly — fastest", thinking: true, effort: "low" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
    { label: "Deep", description: "deeper reasoning budget", thinking: true, effort: "xhigh" },
  ];
  if (model === MUSE_SPARK_13) {
    levels.push({ label: "Maximum", description: "Meta's deepest reasoning tier (Standard 1.3 only)", thinking: true, effort: "max" });
  }
  return levels;
}

/**
 * List prices (USD / 1M tokens). The contributor discount is not a rounding
 * difference — cached input alone is 75x cheaper, because the trade is data, not a
 * volume deal.
 */
const PRICES: Record<string, ModelPrice> = {
  // 1.3 ships at 1.2's rates, on both tiers.
  [MUSE_SPARK_13]: { cacheHit: 0.15, cacheMiss: 1.25, output: 4.25 },
  [MUSE_SPARK_13_CONTRIBUTOR]: { cacheHit: 0.002, cacheMiss: 0.1, output: 0.2 },
  [MUSE_SPARK_12]: { cacheHit: 0.15, cacheMiss: 1.25, output: 4.25 },
  [MUSE_SPARK_12_CONTRIBUTOR]: { cacheHit: 0.002, cacheMiss: 0.1, output: 0.2 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. Every model here stores 1,048,576 tokens with no
 * documented billing cliff inside it, unlike xAI's or Gemini's Pro tier — but on
 * BYOK every token in the window is still the user's money on every turn, so this
 * is the same 200K ceiling used elsewhere once a window is chosen for cost rather
 * than for what the provider will hold.
 */
export function contextWindow(_model: ModelId): number {
  return 200_000;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call. Core
 * reserves exactly this much room below the window, and `client.ts` sends the same
 * constant, so the request and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Vision is deliberately NOT declared. Meta's own docs describe Muse Spark as
 * multimodal (text, image, video, audio, PDF input), but the shared
 * OpenAI-compatible wire layer (`../openaiCompat/wire.ts`) never renders
 * `ChatMessage.images` into the request body — only the two SDK-backed drivers
 * (Anthropic, OpenAI) do that today. Declaring it here would mean core attaching
 * bytes this path silently never sends.
 */

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * Thinking is forced ON, because it cannot be otherwise: a config carried over from a
 * provider that can answer directly would ask this one for the one thing it refuses.
 * The effort is snapped onto a rung THIS MODEL's ladder actually lists — resolved
 * after the model, not before, because `max` exists on only one of the four ids and
 * snapping against a fixed model's ladder would let it leak onto the other three.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  return { model, thinking: true, effort: snapToOfferedRung(model, config.effort) };
}

/**
 * Move an effort onto the nearest rung this model's ladder offers. Ties break
 * DOWNWARD: an unlisted setting resolves to the cheaper neighbour, because silently
 * spending more of the user's money is the worse way to be wrong.
 */
function snapToOfferedRung(model: ModelId, effort: Effort): Effort {
  const ladder: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const offered = thinkLevels(model);
  if (offered.some((l) => l.effort === effort)) return effort;

  const want = ladder.indexOf(effort);
  let best = offered[0]!;
  for (const level of offered) {
    const d = Math.abs(ladder.indexOf(level.effort) - want);
    const bestD = Math.abs(ladder.indexOf(best.effort) - want);
    if (d < bestD || (d === bestD && ladder.indexOf(level.effort) < ladder.indexOf(best.effort))) {
      best = level;
    }
  }
  return best.effort;
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const metaManifest: DriverManifest = {
  id: "meta",
  label: "Meta",
  apiKeyEnv: "MODEL_API_KEY",
  keysUrl: "https://developer.meta.com/ai/products/meta-model-api/",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
