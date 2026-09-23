/**
 * manifest.ts — what Kimi offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code lives in `client.ts`, a thin binding over
 * the shared OpenAI-compatible layer.
 *
 * Kimi's lineup carries THREE different reasoning surfaces, which is why this file
 * has a table rather than a pair of constants — the same shape the Anthropic
 * manifest needed, and for the same reason:
 *
 *   - K3 has no `thinking` parameter at all. It takes a top-level
 *     `reasoning_effort` of `low`/`high`/`max`, and it ALWAYS reasons; there is no
 *     off switch, and the reasoning is billed as output tokens.
 *   - K2.7 Code and its HighSpeed serving tier take `thinking: {type}` but only
 *     accept `"enabled"` — passing `"disabled"` is an error. So both always reason,
 *     with no effort dial.
 *   - K2.6 takes `thinking: {type}` both ways, with no effort dial.
 *
 * Note that `medium` and `xhigh` are not in K3's vocabulary even though they are in
 * the shared one, so `normalize` clamps to the three rungs it actually accepts.
 *
 * The older `moonshot-v1-*` ids, `kimi-k2` (the pre-2.5 series) and `kimi-latest`
 * are all officially discontinued now and 404 — deliberately not offered. `kimi-k2.5`
 * joined them on 2026-08-31: it is not in a future sunset window like DeepSeek's Pro
 * (see that manifest's PRO_SUNSET_MS), it is already gone, so it is removed outright
 * rather than carrying a dead `until` date. A saved config pointing at it falls back
 * to the default via `normalize`'s `SURFACES` lookup below, same as any unknown id.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const K3 = "kimi-k3";
export const K27_CODE = "kimi-k2.7-code";
export const K27_CODE_HIGHSPEED = "kimi-k2.7-code-highspeed";
export const K26 = "kimi-k2.6";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = K26;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to Kimi.
 *
 * K2.6 leads rather than K3: it is roughly a third of K3's input rate and under a
 * third of its output rate, and K3 bills its reasoning trace as output on every
 * single response — so K3 is the deliberate choice for hard work, not the default
 * to drift into.
 */
export const MODELS: ModelChoice[] = [
  { id: K26, label: "Kimi K2.6", description: "the general workhorse — the default" },
  { id: K3, label: "Kimi K3", description: "the flagship, always reasoning, for the hardest work" },
  { id: K27_CODE, label: "Kimi K2.7 Code", description: "tuned for coding and long tool chains" },
  { id: K27_CODE_HIGHSPEED, label: "Kimi K2.7 Code HighSpeed", description: "K2.7 Code at up to 6x the output speed, at double the price" },
];

/** How one model expresses reasoning on the wire. */
export interface ModelSurface {
  /** False when the model rejects an explicit no-thinking request. */
  canDisableThinking: boolean;
  /** True when the model takes a top-level `reasoning_effort` rung (K3 only). */
  takesEffort: boolean;
  /** Usable context window — see `contextWindow`. */
  window: number;
}

const SURFACES: Record<string, ModelSurface> = {
  // Always reasons, and the only dial is the effort rung.
  [K3]: { canDisableThinking: false, takesEffort: true, window: 200_000 },
  // Always reasons, no dial at all. HighSpeed is the same system on faster serving,
  // so it shares K2.7 Code's surface exactly.
  [K27_CODE]: { canDisableThinking: false, takesEffort: false, window: 200_000 },
  [K27_CODE_HIGHSPEED]: { canDisableThinking: false, takesEffort: false, window: 200_000 },
  [K26]: { canDisableThinking: true, takesEffort: false, window: 200_000 },
};

/** The surface a model runs on, falling back to the default model's. */
export function surfaceOf(model: ModelId): ModelSurface {
  return SURFACES[model] ?? SURFACES[DEFAULT_MODEL]!;
}

/**
 * The reasoning levels offered by `/think`, which depend on the model's surface.
 *
 * Three shapes, one per surface:
 *   - K3: no "answer directly" rung, because there is no such request to make.
 *     The three rungs are its three real effort values.
 *   - K2.7 Code and its HighSpeed tier: ONE level each. Both always reason and have
 *     no effort dial, so there is genuinely one setting. A single-entry menu is
 *     honest; inventing a second that did nothing would not be.
 *   - K2.6: the plain on/off pair, no effort dial.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  const surface = surfaceOf(model);

  if (surface.takesEffort) {
    return [
      { label: "Standard", description: "always reasons — lightest budget", thinking: true, effort: "low" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
    ];
  }

  if (!surface.canDisableThinking) {
    return [{ label: "Thinking", description: "this model always reasons", thinking: true, effort: "high" }];
  }

  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
  ];
}

/**
 * List prices (USD / 1M tokens). Cache reads are far cheaper than fresh input,
 * which is what keeps a re-sent conversation affordable.
 *
 * Worth knowing about K3 specifically: thinking and non-thinking do NOT carry
 * separate rates, but K3's reasoning trace is billed as OUTPUT on every response.
 * On a hard task that trace can exceed the visible answer, so its effective cost
 * runs above what the output figure alone suggests.
 */
const PRICES: Record<string, ModelPrice> = {
  [K3]: { cacheHit: 0.3, cacheMiss: 3, output: 15 },
  [K27_CODE]: { cacheHit: 0.19, cacheMiss: 0.95, output: 4 },
  [K27_CODE_HIGHSPEED]: { cacheHit: 0.38, cacheMiss: 1.9, output: 8 },
  // Corrected from 0.19: K2.6's published cached rate is lower than K2.7 Code's,
  // not the same figure — they were priced identically here by mistake.
  [K26]: { cacheHit: 0.16, cacheMiss: 0.95, output: 4 },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/**
 * The model's USABLE context window. K3 stores 1M and the K2 tiers store 256K, but
 * this is deliberately the sharp window rather than the storage cap: on BYOK every
 * token in the window is the user's money on every turn, so anchoring compaction at
 * the maximum would mean carrying an enormous prompt long after it stopped earning
 * its cost. Same reasoning, and the same figure, as the other drivers.
 */
export function contextWindow(model: ModelId): number {
  return surfaceOf(model).window;
}

/**
 * The ceiling this driver puts on a single BUFFERED (non-streaming) call. The
 * provider's own default is 32K; this is lower because a non-streaming request that
 * runs long risks an HTTP timeout, and core reserves exactly this much room below
 * the context window. `client.ts` sends the same constant — one number, so the
 * request and the reservation cannot drift apart.
 */
export const BUFFERED_OUTPUT_TOKENS = 8_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/**
 * Vision is deliberately NOT declared. Kimi does serve vision, but through the
 * separate `moonshot-v1-*-vision-preview` ids rather than any model offered here.
 * Declaring it would mean core attaching bytes these ids cannot read.
 */

/**
 * Coerce a stored or unknown config onto a model this provider actually serves, and
 * keep the reasoning intent legal for it.
 *
 * One correction enforces a rule the API would otherwise reject: a model that
 * cannot stop reasoning always gets `thinking: true`.
 *
 * The effort is then handled entirely by snapping onto a rung `/think` lists, which
 * is also what keeps K3 legal. That is worth stating plainly, because it makes the
 * ladder LOAD-BEARING rather than cosmetic: `thinkLevels(K3)` lists exactly the
 * three values K3 accepts (`low`/`high`/`max`), so snapping to it is what prevents
 * the shared type's `medium` and `xhigh` — which K3 has never heard of — from
 * reaching the wire. An earlier draft also clamped against a separate list of K3's
 * rungs; that was redundant, and a red-check proved it by failing to fail.
 * If a rung is ever added to a ladder that the model does not accept, this breaks.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = SURFACES[config.model] ? config.model : DEFAULT_MODEL;
  const surface = surfaceOf(model);

  const thinking = surface.canDisableThinking ? config.thinking === true : true;
  // Models with no effort dial settle on `high` — inert for them, and the rung a
  // model that DOES have a dial treats as the safe middle.
  const effort: Effort = surface.takesEffort ? config.effort : "high";

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
export const kimiManifest: DriverManifest = {
  id: "kimi",
  label: "Kimi",
  apiKeyEnv: "MOONSHOT_API_KEY",
  keysUrl: "https://platform.kimi.ai/console/api-keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
};
