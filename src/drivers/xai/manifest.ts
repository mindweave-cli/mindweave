/**
 * manifest.ts — what xAI offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain data
 * and pure functions. The wire code lives in `client.ts`, a thin binding over the
 * shared OpenAI-compatible layer.
 *
 * The rule to keep in view: every model here reasons, but they take `reasoning_effort`
 * in two different shapes. Grok 4.3 can be switched OFF (`none`). Grok 4.5, 4.6 and
 * 4.7 cannot: reasoning is always on, and the dial only sets how deep, defaulting to
 * `high` (docs.x.ai model-capabilities/text/reasoning and each model page, checked
 * 2026-09-23). Sending `none` to one of those is a value it does not accept.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const GROK_47 = "grok-4.7";
export const GROK_46 = "grok-4.6";
export const GROK_45 = "grok-4.5";
export const GROK_43 = "grok-4.3";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = GROK_46;

/** The models offered by `/model`. First entry is this provider's default. */
export const MODELS: ModelChoice[] = [
  { id: GROK_46, label: "Grok 4.6", description: "strong at code — the default" },
  { id: GROK_47, label: "Grok 4.7", description: "the newest model, at the same rate as 4.6" },
  { id: GROK_45, label: "Grok 4.5", description: "the previous generation" },
  { id: GROK_43, label: "Grok 4.3", description: "the reasoning tier, with a 1M window" },
];

/** Whether a model takes the `reasoning_effort` dial. Every model here does. */
export function takesEffort(model: ModelId): boolean {
  return model === GROK_43 || model === GROK_45 || model === GROK_46 || model === GROK_47;
}

/** Whether reasoning can be switched off (`none`). Only Grok 4.3's can. */
export function canDisableReasoning(model: ModelId): boolean {
  return model === GROK_43;
}

/** The depth xAI uses when none is sent, on the always-reasoning models. A saved config
 *  that never chose a depth lands here, so it keeps running exactly as it always has. */
export const ALWAYS_ON_DEFAULT: Effort = "high";

/**
 * The reasoning levels offered by `/think`.
 *
 * Grok 4.3: `none` is the off switch rather than a separate flag, the same shape
 * OpenAI uses, and the ladder above it stops at `high` here.
 *
 * Grok 4.5-4.7 always reason, so there is no "answer directly" level to offer — the
 * choice is only how deep. Standard is xAI's own default depth, so picking nothing
 * changes nothing. `xhigh` is offered on 4.6 and later only: 4.5 quietly treats it as
 * `high`, and a level that does the same as another is not a choice.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  if (canDisableReasoning(model)) {
    return [
      { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "low" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "low" },
      { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "medium" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "high" },
    ];
  }
  const levels: ThinkLevel[] = [
    { label: "Minimal", description: "always reasons — least, and quickest", thinking: true, effort: "low" },
    { label: "Light", description: "always reasons — lighter than the default", thinking: true, effort: "medium" },
    { label: "Standard", description: "always reasons — xAI's default depth", thinking: true, effort: ALWAYS_ON_DEFAULT },
  ];
  if (model !== GROK_45) {
    levels.push({ label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "xhigh" });
  }
  return levels;
}

/**
 * List prices (USD / 1M tokens).
 *
 * Two caveats. xAI TIERS by prompt size: a request over 200K input tokens bills at
 * DOUBLE these rates, across the whole request rather than the excess. The shared
 * `ModelPrice` shape holds one rate, so these are the base tier — right for ordinary
 * sessions, low for very long ones, which is also why `contextWindow` below sits
 * where it does.
 *
 * Grok 4.6, 4.5 and 4.3 are confirmed against xAI's own pricing table (docs.x.ai/developers/pricing,
 * checked 2026-09-20). Grok 4.5 and 4.3 had been carrying estimated figures that were
 * both too high — 4.3's especially so, at roughly 2.4x its real input rate and 6x its
 * real output rate.
 */
const PRICES: Record<string, ModelPrice> = {
  // Same rates as Grok 4.6 (docs.x.ai/developers/models, checked 2026-09-23).
  [GROK_47]: { cacheHit: 0.5, cacheMiss: 2, output: 6 },
  [GROK_46]: { cacheHit: 0.5, cacheMiss: 2, output: 6 },
  [GROK_45]: { cacheHit: 0.3, cacheMiss: 2, output: 6 },
  [GROK_43]: { cacheHit: 0.2, cacheMiss: 1.25, output: 2.5 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. These models store 500K (Grok 4.3, 1M), but
 * this is deliberately far below that, and here the reason is billing as much as
 * attention: crossing 200K input DOUBLES the rate on the entire request, so letting
 * a transcript drift past that line silently doubles the cost of every later turn.
 * 128K keeps ordinary sessions well clear of it.
 */
export function contextWindow(_model: ModelId): number {
  return 128_000;
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
 * Every Grok here reads images, on the Chat Completions endpoint this driver uses, as
 * an `image_url` with a base64 data URL — the shape the shared wire already sends
 * (docs.x.ai model pages and legacy/chat-completions, checked 2026-09-23).
 */
export function acceptsImages(_model: ModelId): boolean {
  return true;
}

/** JPG and PNG only (max 20 MiB) — narrower than the GIF and WebP core can also attach,
 *  so those are held back with a note the agent can pass on, not sent to fail. */
export function imageTypes(_model: ModelId): string[] {
  return ["image/png", "image/jpeg"];
}

/** The effort rungs this provider accepts, weakest first. There is no `max`. */
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"];

/**
 * Coerce a stored or unknown config onto a model this provider actually serves.
 *
 * The result is snapped onto a rung `/think` lists, which is what keeps the request
 * legal: no model here takes `max`, and only 4.6 and later take `xhigh`, so a config
 * carried in from another provider must not reach the wire as it came.
 *
 * On an always-reasoning model, a config with thinking OFF never chose a depth: it is
 * either a pre-2.5.1 config from when these models had no dial, or one carried in from
 * a provider's "answer directly" level. It maps to xAI's own default, so those sessions
 * keep the depth they have always had, rather than quietly dropping to the lowest.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = PRICES[config.model] ? config.model : DEFAULT_MODEL;
  if (!canDisableReasoning(model)) {
    const effort: Effort =
      config.thinking === true && EFFORTS.includes(config.effort) ? config.effort : ALWAYS_ON_DEFAULT;
    return { model, thinking: true, effort: snapToOfferedRung(model, true, effort) };
  }
  const thinking = config.thinking === true;
  const effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "low";
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
  if (offered.length === 0) return thinkLevels(model)[0]!.effort;
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
export const xaiManifest: DriverManifest = {
  id: "xai",
  label: "xAI",
  apiKeyEnv: "XAI_API_KEY",
  keysUrl: "https://console.x.ai/",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  acceptsImages,
  imageTypes,
  normalize,
};
