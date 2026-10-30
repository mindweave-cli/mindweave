/**
 * manifest.ts — what Mistral offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain data
 * and pure functions. The wire code lives in `client.ts`, a thin binding over the
 * shared OpenAI-compatible layer.
 *
 * Mistral's model ids carry a DATE SUFFIX rather than a bare version
 * (`mistral-medium-3-5-26-04`), which is unusual enough to note: the ids here are
 * the dated snapshots from Mistral's own model list, not the `-latest` aliases. A
 * snapshot cannot silently change behaviour underneath a saved config, which is the
 * property worth having when the config is sticky per project.
 *
 * The `magistral-*` reasoning models are deliberately absent: they were deprecated,
 * and `magistral-small-latest` now resolves to Mistral Small 4, whose reasoning is
 * reached through `reasoning_effort` instead.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const MEDIUM = "mistral-medium-3-5-26-04";
export const LARGE_4 = "mistral-large-4-0";
export const LARGE = "mistral-large-3-25-12";
export const SMALL = "mistral-small-4-0-26-03";
export const MINISTRAL_8B = "ministral-3-8b-25-12";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = MEDIUM;

/** The models offered by `/model`. First entry is this provider's default. */
export const MODELS: ModelChoice[] = [
  { id: MEDIUM, label: "Mistral Medium 3.5", description: "the flagship, tuned for agents and code — the default" },
  { id: LARGE_4, label: "Mistral Large 4", description: "the newest open-weight model, with a 1M window — in public preview" },
  { id: LARGE, label: "Mistral Large 3", description: "open weights, and much cheaper than the flagship" },
  { id: SMALL, label: "Mistral Small 4", description: "small and capable, with a reasoning dial" },
  { id: MINISTRAL_8B, label: "Ministral 8B", description: "cheapest tier, for simple work" },
];

/**
 * Whether a model takes the `reasoning_effort` dial. Mistral serves it on the
 * flagship, on Large 4 and on Small 4, and not on the rest of the lineup.
 */
export function takesEffort(model: ModelId): boolean {
  return model === MEDIUM || model === LARGE_4 || model === SMALL;
}

/**
 * The reasoning levels offered by `/think`.
 *
 * `reasoning_effort` is a ROOT-LEVEL field here, and `none` is its off switch: at
 * `none` the model thinks minimally and the thinking chunk is omitted, at `high` a
 * full thinking chunk precedes the answer. Those two are the documented ends, so
 * those two are what is offered — inventing intermediate rungs whose behaviour is
 * undocumented would be a menu making promises the API has not made.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  if (takesEffort(model)) {
    return [
      { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "low" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
    ];
  }
  return [{ label: "Standard", description: "this model has no reasoning dial", thinking: false, effort: "low" }];
}

/**
 * List prices (USD / 1M tokens).
 *
 * Note the lineup is not priced in name order: Medium 3.5 is the newer flagship and
 * costs several times Large 3, which is the older open-weight workhorse. That reads
 * as a mistake and is not one.
 *
 * Cached input bills at a TENTH of the standard input rate, which is why `cacheHit`
 * is a real discount here rather than a mirror of `cacheMiss`. An earlier version of
 * this file asserted Mistral published no cached rate; it does.
 */
const PRICES: Record<string, ModelPrice> = {
  [MEDIUM]: { cacheHit: 0.15, cacheMiss: 1.5, output: 7.5 },
  // Large 4: $1.36 in / $0.14 cached / $4.18 out (docs.mistral.ai model page, checked 2026-10-28). Its id is
  // the one Mistral's reasoning page lists, `mistral-large-4-0`; no dated snapshot id is published yet.
  [LARGE_4]: { cacheHit: 0.14, cacheMiss: 1.36, output: 4.18 },
  [LARGE]: { cacheHit: 0.05, cacheMiss: 0.5, output: 1.5 },
  [SMALL]: { cacheHit: 0.015, cacheMiss: 0.15, output: 0.6 },
  [MINISTRAL_8B]: { cacheHit: 0.015, cacheMiss: 0.15, output: 0.15 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/** The model's USABLE context window — the sharp span rather than the storage cap,
 *  for the same BYOK reason as every other driver here. */
export function contextWindow(_model: ModelId): number {
  return 128_000;
}

/** The ceiling this driver puts on a single BUFFERED call. Core reserves exactly
 *  this much room below the window, and `client.ts` sends the same constant. */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Vision is deliberately NOT declared. Medium 3.5 and Large 3 are described as
 * multimodal and Ministral 8B carries vision, but Small 4's image support is not
 * something this driver has confirmed. A capability true for some of a list and
 * unverified for the rest cannot be reported as a flat yes: core would attach bytes
 * a session might silently be unable to read. Add it per model once confirmed.
 */

/** The effort rungs this driver uses. `none` is expressed as thinking-off. */
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Coerce a stored or unknown config onto a model this provider actually serves,
 *  then snap onto a rung `/think` lists so no unlisted setting can persist. */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  const thinking = takesEffort(model) ? config.thinking === true : false;
  const effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "low";
  return { model, thinking, effort: snapToOfferedRung(model, thinking, effort) };
}

/** Move an effort onto the nearest rung this model's ladder offers, ties downward. */
function snapToOfferedRung(model: ModelId, thinking: boolean, effort: Effort): Effort {
  const offered = thinkLevels(model).filter((l) => l.thinking === thinking);
  if (offered.length === 0) return thinkLevels(model)[0]!.effort;
  if (offered.some((l) => l.effort === effort)) return effort;

  const want = EFFORTS.indexOf(effort);
  let best = offered[0]!;
  for (const level of offered) {
    const d = Math.abs(EFFORTS.indexOf(level.effort) - want);
    const bestD = Math.abs(EFFORTS.indexOf(best.effort) - want);
    if (d < bestD || (d === bestD && EFFORTS.indexOf(level.effort) < EFFORTS.indexOf(best.effort))) best = level;
  }
  return best.effort;
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const mistralManifest: DriverManifest = {
  id: "mistral",
  label: "Mistral",
  apiKeyEnv: "MISTRAL_API_KEY",
  keysUrl: "https://console.mistral.ai/api-keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
