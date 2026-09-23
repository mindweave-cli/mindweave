/**
 * manifest.ts — what GLM offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, a thin binding over
 * the shared OpenAI-compatible layer.
 *
 * WHICH GLM THIS IS. Z.ai serves the same models from several endpoints: the
 * international OpenAI-compatible one used here, a China endpoint on a different
 * host, an Anthropic-protocol endpoint, and a separate Coding Plan path. They do
 * not share prices, and the Coding Plan carries models with no published per-token
 * rate at all. This driver targets the international pay-per-token endpoint.
 *
 * The lineup spans the price ladder and deliberately not the long
 * tail: Z.ai still serves the whole 4.5 series, several `-air`/`-x` variants and a
 * vision line, all superseded for this purpose by what is listed below.
 *
 * GLM-5.3 and GLM-5.3-Flash were once absent from here because they existed only
 * through the Coding Plan, with no per-token rate to quote. They are on the
 * pay-per-token endpoint now, so they are listed with real prices.
 *
 * GLM-5.3-FLASHX, added 2026-09-18, is not a different model — Z.ai's own
 * announcement describes it as the same GLM-5.3-Flash system (320B total / 18B
 * active, 1M context, native image/video input) served through a faster inference
 * configuration (up to 200 tok/s vs Flash's baseline). It costs more per token for
 * that speed, so it is offered as its own choice rather than folded into Flash.
 *
 * BOTH 5.3 MODELS THINK UNCONDITIONALLY. Z.ai documents `thinking.type` as accepting
 * only `enabled`, and 5.3's `reasoning_effort` has no off value. Every other model
 * here can have thinking turned off, so the ladder below branches on it rather than
 * offering a rung that would be refused. FlashX inherits this from being the same
 * system as Flash.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const GLM_53 = "glm-5.3";
export const GLM_53_FLASH = "glm-5.3-flash";
export const GLM_53_FLASHX = "glm-5.3-flashx";
export const GLM_52 = "glm-5.2";
export const GLM_5 = "glm-5";
export const GLM_47 = "glm-4.7";
export const GLM_47_FLASHX = "glm-4.7-flashx";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = GLM_53;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to GLM.
 *
 * The flagship leads here, unlike the other drivers, because on this provider it is
 * not the expensive choice: GLM-5.2 runs well under half of Claude Sonnet's rate,
 * and it is the only model in the lineup with a reasoning dial. The cheaper rungs
 * are a real ladder below it rather than the sensible middle.
 */
export const MODELS: ModelChoice[] = [
  { id: GLM_53, label: "GLM-5.3", description: "the flagship, three reasoning depths — the default" },
  { id: GLM_53_FLASH, label: "GLM-5.3 Flash", description: "most of the flagship, a fraction of the price" },
  { id: GLM_53_FLASHX, label: "GLM-5.3 FlashX", description: "GLM-5.3 Flash on faster serving, for latency-sensitive work" },
  { id: GLM_52, label: "GLM-5.2", description: "the previous flagship, with a reasoning dial" },
  { id: GLM_5, label: "GLM-5", description: "older, a little cheaper again" },
  { id: GLM_47, label: "GLM-4.7", description: "strong value for everyday work" },
  { id: GLM_47_FLASHX, label: "GLM-4.7 FlashX", description: "very cheap and quick, for simple work" },
];

/**
 * Whether a model takes the `reasoning_effort` dial. GLM-5.2 and both 5.3 models do; the rest
 * have thinking as a plain on/off toggle, and sending them an effort would be a
 * parameter they do not know.
 */
export function takesEffort(model: ModelId): boolean {
  return model === GLM_52 || alwaysThinks(model);
}
/**
 * Models whose thinking cannot be switched off.
 *
 * Offering them an "answer directly" rung would build a menu entry that produces a
 * request the provider refuses. The ladder and `normalize` both read this. FlashX is
 * the same served system as Flash, so it carries the same restriction.
 */
export function alwaysThinks(model: ModelId): boolean {
  return model === GLM_53 || model === GLM_53_FLASH || model === GLM_53_FLASHX;
}

/**
 * The reasoning levels offered by `/think`.
 *
 * GLM-5.2's `reasoning_effort` accepts seven values, but they COLLAPSE: `none` and
 * `minimal` skip thinking, `low` and `medium` both map up to `high`, and `xhigh`
 * maps up to `max`. So there are two real thinking levels behind seven names.
 *
 * Only the two are offered. Listing `low` and `medium` as separate rungs would put
 * choices in front of the user that provably do nothing — the same reason Fable 5
 * has no "answer directly" rung on the Anthropic driver. A menu should not contain
 * a switch that is wired to the same place as the one above it.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  // Both 5.3 models: three documented depths — `low`, `high` and `max` — and no way to
  // answer without reasoning. The lightest rung is still thinking, so it is not labelled
  // as though it skips it.
  //
  // Flash was offered the top rung alone, on the reading that it documented a single
  // effort value. It documents the same three, and `max` is only what it falls back to
  // when nothing is passed. A model with no way down reasons at its deepest setting for
  // every step of every turn, including the ones that are a file read, and the user has
  // nothing to turn.
  if (alwaysThinks(model)) {
    return [
      { label: "Light", description: "reasons briefly — fastest", thinking: true, effort: "low" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
    ];
  }
  if (takesEffort(model)) {
    return [
      { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
    ];
  }
  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
  ];
}

/**
 * List prices (USD / 1M tokens), international endpoint. Cached input is billed
 * separately and far lower, which is what keeps a re-sent conversation cheap.
 *
 * The China endpoint charges different rates for the same model ids. This driver
 * targets international, so these are the figures that apply to it.
 */
const PRICES: Record<string, ModelPrice> = {
  // Standard rates, NOT the launch promotion that halves Flash until 2026-09-09: a
  // meter that quotes a discount is wrong the day it ends, and wrong quietly.
  [GLM_53]: { cacheHit: 0.26, cacheMiss: 1.4, output: 4.4 },
  [GLM_53_FLASH]: { cacheHit: 0.03, cacheMiss: 0.15, output: 0.5 },
  [GLM_53_FLASHX]: { cacheHit: 0.075, cacheMiss: 0.37, output: 1.25 },
  [GLM_52]: { cacheHit: 0.26, cacheMiss: 1.4, output: 4.4 },
  [GLM_5]: { cacheHit: 0.2, cacheMiss: 1, output: 3.2 },
  [GLM_47]: { cacheHit: 0.11, cacheMiss: 0.6, output: 2.2 },
  [GLM_47_FLASHX]: { cacheHit: 0.014, cacheMiss: 0.07, output: 0.4 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. GLM-5.2 stores 1M, but this is deliberately
 * the sharp window rather than the storage cap: on BYOK every token in the window is
 * the user's money on every turn, so anchoring compaction at 1M would mean carrying
 * an enormous prompt long after it stopped earning its cost. Same reasoning, and the
 * same figure, as the other drivers.
 */
export function contextWindow(_model: ModelId): number {
  return 200_000;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call. These
 * models accept up to 128K output, but a non-streaming request that runs long risks
 * an HTTP timeout, so the buffered path — core's small internal calls — is capped
 * far lower. `client.ts` sends the same constant, and core reserves exactly this
 * much room below the window, so the request and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Which models can SEE an image.
 *
 * GLM-5.3-Flash is natively multimodal — Z.ai documents image (and video) input on its
 * own id, sent the ordinary OpenAI-compat way (`image_url` content parts), which the
 * shared transport already produces. So core may attach the bytes and the model reads
 * them. FlashX is the same served system, so the same is true of it. Every other GLM
 * model here is text-only: pointing an image at one still degrades before anything is
 * sent, which is what core does with a false answer here. (The older `glm-*v*` vision
 * line is separate and not offered by this driver.)
 */
export function acceptsImages(model: ModelId): boolean {
  return model === GLM_53_FLASH || model === GLM_53_FLASHX;
}

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * No per-model rule to enforce beyond the effort dial: every model here can have
 * thinking turned off. The result is snapped onto a rung `/think` actually lists,
 * which is also what keeps the request legal — the ladder holds only values the
 * model accepts, so snapping to it is what stops the shared type's other rungs from
 * reaching a model that has no dial at all.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  // Forced on where the provider allows nothing else, so a config carried over from
  // another model cannot produce a request this one refuses.
  const thinking = alwaysThinks(model) ? true : config.thinking === true;
  const effort: Effort = takesEffort(model) ? config.effort : "high";
  return { model, thinking, effort: snapToOfferedRung(model, thinking, effort) };
}

/**
 * Move an effort onto the nearest rung this model's `/think` ladder offers. Ties
 * break DOWNWARD: an unlisted setting resolves to the cheaper neighbour, because
 * silently spending more of the user's money is the worse way to be wrong.
 */
function snapToOfferedRung(model: ModelId, thinking: boolean, effort: Effort): Effort {
  const ladder: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const offered = thinkLevels(model).filter((l) => l.thinking === thinking);
  if (offered.length === 0) return effort;
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
export const glmManifest: DriverManifest = {
  id: "glm",
  label: "GLM",
  apiKeyEnv: "ZAI_API_KEY",
  keysUrl: "https://z.ai/manage-apikey/apikey-list",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  acceptsImages,
  normalize,
};
