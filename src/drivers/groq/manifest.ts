/**
 * manifest.ts — what Groq offers, and the numbers that describe it.
 *
 * THE FIRST DISCOVERED PROVIDER. Everything before this declared a fixed lineup,
 * because a vendor serving its own models knows them when the driver is written.
 * Groq does not serve its own models: it serves other people's, very fast, and its
 * catalogue rotates as those models are published and retired. A list compiled in
 * here would be wrong within weeks, and wrong in the worst way — a model id that
 * 404s on the first request of a session.
 *
 * So `models` below is a small fallback and `discoverModels` is the real answer.
 * See `drivers/types.ts` for the contract and `registry.ts` for the cache.
 *
 * What Groq is FOR is worth stating, because it is not capability. These are open
 * models available elsewhere; what Groq sells is latency. Choose it when a fast loop
 * matters more than the strongest possible answer.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

/**
 * A minimal fallback list, shown only before discovery has run or when it fails.
 *
 * Deliberately short and boring: these are the ids least likely to have been
 * retired, because a fallback that names a withdrawn model is worse than a fallback
 * that names two working ones. The live list replaces this entirely.
 */
export const MODELS: ModelChoice[] = [
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", description: "general purpose, very fast" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", description: "open weights, with a reasoning dial" },
];

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = MODELS[0]!.id;

/**
 * Models known to accept `reasoning_effort`.
 *
 * Matched by SUBSTRING rather than exact id, and that is a concession to the
 * discovered lineup: ids arrive with vendor prefixes and size suffixes that vary
 * (`openai/gpt-oss-120b`, `qwen/qwen3-32b`), so an exact table would go stale for
 * the same reason the model list does. A false negative here costs a reasoning dial;
 * a false positive costs a rejected request, so the list stays narrow.
 */
const EFFORT_MODELS = ["gpt-oss", "qwen3"];

export function takesEffort(model: ModelId): boolean {
  const id = model.toLowerCase();
  return EFFORT_MODELS.some((fragment) => id.includes(fragment));
}

/**
 * The reasoning levels offered by `/think`.
 *
 * Groq accepts only `none` and `default` for `reasoning_effort` — not the graded
 * ladder other providers expose. So there are exactly two states, and offering a
 * "Deep" or "Maximum" rung would be a menu entry that sends a value the API rejects.
 * `default` is expressed here as thinking-on; `none` as thinking-off.
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
 * A discovered lineup cannot have a complete price table by definition — a model
 * that appears tomorrow has no row here. The fallback is deliberately the CHEAPEST
 * plausible rate rather than an average: this provider serves small open models at
 * low rates, so guessing high would make a cost figure look alarming for a session
 * that was in fact inexpensive. Matched by substring, for the same reason as
 * `takesEffort`.
 *
 * Cached input takes a flat 50% discount here — not the ~90% most providers give —
 * so `cacheHit` is half of `cacheMiss` throughout rather than a tenth.
 */
const PRICES: [fragment: string, price: ModelPrice][] = [
  // console.groq.com/docs/models, checked 2026-09-23.
  ["gpt-oss-120b", { cacheHit: 0.075, cacheMiss: 0.15, output: 0.6 }],
  ["gpt-oss-20b", { cacheHit: 0.0375, cacheMiss: 0.075, output: 0.3 }],
  // The two Llama models moved to Enterprise (contact sales) and no longer publish a
  // rate; these are their last public prices, kept as the estimate.
  ["llama-3.3-70b", { cacheHit: 0.295, cacheMiss: 0.59, output: 0.79 }],
  ["llama-3.1-8b", { cacheHit: 0.025, cacheMiss: 0.05, output: 0.08 }],
  ["qwen3-32b", { cacheHit: 0.145, cacheMiss: 0.29, output: 0.59 }],
];

const UNKNOWN_PRICE: ModelPrice = { cacheHit: 0.05, cacheMiss: 0.1, output: 0.5 };

export function price(model: ModelId): ModelPrice {
  const id = model.toLowerCase();
  return PRICES.find(([fragment]) => id.includes(fragment))?.[1] ?? UNKNOWN_PRICE;
}

/**
 * The model's USABLE context window.
 *
 * Groq's `/models` listing reports a real `context_window` per model, and
 * `client.ts` folds it into the discovered entry. This is the floor used when that
 * is unavailable — a conservative 128K, since the open models served here range from
 * 8K to over 250K and over-stating it would let a transcript grow past what the
 * model can actually attend to.
 */
export function contextWindow(_model: ModelId): number {
  return 128_000;
}

/** The ceiling this driver puts on a single BUFFERED call. */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/** The effort rungs this driver uses; Groq's real vocabulary is two states. */
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Coerce a stored or unknown config onto something serveable.
 *
 * The one thing that CANNOT be done here, and is the difference from every static
 * driver: reject an unknown model id. A discovered provider's list may be empty
 * (discovery has not run, or the key is missing), and coercing the user's saved
 * model onto a fallback in that window would silently change their choice on every
 * launch. So an unrecognised id is kept as-is and left for the provider to judge.
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
 * Recognise a Groq model id without a list.
 *
 * Needed because the provider is derived from the model id and a discovered list is
 * empty until asked: without this, a saved Groq model would be attributed to the
 * fallback provider on launch and the session would open on the wrong one. These
 * fragments are the vendor prefixes Groq's catalogue uses.
 *
 * Consulted only AFTER every provider's real list is searched, so it can never take
 * a model another provider actually serves.
 */
export function ownsModel(model: ModelId): boolean {
  const id = model.toLowerCase();
  return ["llama-", "openai/gpt-oss", "qwen/", "moonshotai/", "groq/", "meta-llama/"].some((p) => id.startsWith(p));
}

/** The cheap metadata half of this driver — see `index.ts` for the wire half. */
export const groqManifest: DriverManifest = {
  id: "groq",
  label: "Groq",
  apiKeyEnv: "GROQ_API_KEY",
  keysUrl: "https://console.groq.com/keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
  ownsModel,
  /**
   * Discovery lives here rather than on the driver, because the `/model` picker
   * needs the list before any wire code has been loaded — that is the whole reason
   * manifests are separate from drivers.
   *
   * The import is INSIDE the function, so this module still touches no network and
   * loads no wire code at import time. A manifest that imported its client at the
   * top would undo the lazy split for every user of every other provider.
   */
  discoverModels: async () => (await import("./client.js")).discoverModels(),
};
