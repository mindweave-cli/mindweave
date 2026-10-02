/**
 * manifest.ts — what Cerebras offers, and the numbers that describe it.
 *
 * A DISCOVERED provider, for the same reason as Groq: Cerebras serves other
 * people's open models at very high speed, and the catalogue rotates as those
 * models are published and retired. A list compiled in here would be wrong within
 * weeks, and wrong in the way that 404s on the first request of a session.
 *
 * One difference from Groq worth knowing: Cerebras's `/models` listing reports only
 * an id, with no context window. So `contextWindow` below is a single conservative
 * figure rather than a per-model fact, and the picker entries carry no size hint.
 * That is a limitation of the endpoint, not an omission here.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

/**
 * A minimal fallback list, shown only before discovery has run or when it fails.
 * Short on purpose: a fallback naming a withdrawn model is worse than one naming
 * two that work. The live list replaces this entirely.
 *
 * GLM 4.7 (`zai-glm-4.7`) is gone from this list as of 2026-09-20: Cerebras's own
 * public-endpoints model overview (inference-docs.cerebras.ai/models/overview) no
 * longer names it, listing only GPT-OSS 120B and Qwen 3.8 27B. It may still be
 * reachable through a Dedicated Endpoint, which this fallback does not cover either
 * way — swapped for the model the public tier actually confirms today.
 */
export const MODELS: ModelChoice[] = [
  { id: "gpt-oss-120b", label: "GPT-OSS 120B", description: "open weights, with a reasoning dial" },
  { id: "qwen-3.8-27b", label: "Qwen3.8 27B", description: "served on Cerebras, very fast" },
];

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = MODELS[0]!.id;

/**
 * Models known to accept `reasoning_effort`, matched by SUBSTRING rather than exact
 * id — the discovered ids carry vendor prefixes and size suffixes that vary, so an
 * exact table would go stale for the same reason the model list does. A false
 * negative costs a reasoning dial; a false positive costs a rejected request, so the
 * list stays narrow.
 */
const EFFORT_MODELS = ["gpt-oss", "qwen3", "glm"];

export function takesEffort(model: ModelId): boolean {
  const id = model.toLowerCase();
  return EFFORT_MODELS.some((fragment) => id.includes(fragment));
}

/**
 * The reasoning levels offered by `/think`.
 *
 * Two states rather than a graded ladder. The models served here come from several
 * vendors with different effort vocabularies, and this driver does not know which
 * one a discovered id belongs to — so it offers the states every one of them
 * accepts, instead of a rung that works on some and 400s on others.
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
 * List prices (USD / 1M tokens), for the models whose rates are published.
 *
 * A discovered lineup cannot have a complete table by definition. The fallback is
 * the cheapest plausible rate rather than an average, for the same reason as Groq's:
 * this provider serves open models cheaply, so guessing high would make an
 * inexpensive session look alarming.
 *
 * `cacheHit` deliberately EQUALS `cacheMiss` throughout, and that is a fact rather
 * than an unfinished table: Cerebras bills cached input at the standard rate, so its
 * prompt caching buys latency and no money. It is the one provider here where a
 * cache discount would be invented.
 */
const PRICES: [fragment: string, price: ModelPrice][] = [
  // cerebras.ai/pricing rate card, checked 2026-09-23.
  ["gpt-oss-120b", { cacheHit: 0.35, cacheMiss: 0.35, output: 0.75 }],
  // The served id is `qwen-3.8-27b`, with a hyphen. The old fragment was "qwen3", which
  // never matched it, so this model was quietly billed at the fallback rate.
  ["qwen-3.8-27b", { cacheHit: 0.99, cacheMiss: 0.99, output: 1.49 }],
  ["glm-4.7", { cacheHit: 0.6, cacheMiss: 0.6, output: 2.2 }],
  ["qwen3", { cacheHit: 0.29, cacheMiss: 0.29, output: 0.59 }],
];

const UNKNOWN_PRICE: ModelPrice = { cacheHit: 0.35, cacheMiss: 0.35, output: 0.75 };

export function price(model: ModelId): ModelPrice {
  const id = model.toLowerCase();
  return PRICES.find(([fragment]) => id.includes(fragment))?.[1] ?? UNKNOWN_PRICE;
}

/**
 * The model's USABLE context window. A single conservative figure, because the
 * listing reports no per-model size and the open models served here vary widely.
 * Under-stating costs some usable context; over-stating lets a transcript grow past
 * what the model can attend to, which is the worse failure.
 */
export function contextWindow(_model: ModelId): number {
  return 128_000;
}

/** The ceiling this driver puts on a single BUFFERED call. */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Coerce a stored config onto something serveable.
 *
 * As with Groq, an unknown model id is KEPT rather than coerced. A discovered
 * provider's list is empty until it is asked, and rewriting the user's saved model
 * in that window would silently change their choice on every launch.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = config.model || DEFAULT_MODEL;
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

/**
 * Recognise a Cerebras model id without a list.
 *
 * Narrower than Groq's on purpose. Both providers serve overlapping open models, so
 * a broad claim here would let Cerebras capture ids Groq also serves, and whichever
 * provider happened to be earlier in the registry would win — a coin toss deciding
 * which endpoint a saved model runs against. Only the `zai-` prefix is distinctive
 * to this catalogue; everything else is left to the real lists.
 *
 * The consequence, stated rather than hidden: a saved Cerebras model with a shared
 * id resolves correctly only once discovery has run, which it does at session start.
 */
export function ownsModel(model: ModelId): boolean {
  return model.toLowerCase().startsWith("zai-");
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const cerebrasManifest: DriverManifest = {
  id: "cerebras",
  label: "Cerebras",
  apiKeyEnv: "CEREBRAS_API_KEY",
  keysUrl: "https://cloud.cerebras.ai/",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
  ownsModel,
  /** Imported inside the function so this module loads no wire code — see Groq's. */
  discoverModels: async () => (await import("./client.js")).discoverModels(),
};
