/**
 * manifest.ts — what Anthropic offers, and the numbers that describe it.
 *
 * Loaded even when the user is running a different provider, so it stays plain
 * data and pure functions. The wire code (and the SDK) live in `client.ts`, which
 * only loads once a Claude model is actually selected.
 *
 * The models span two request surfaces, and the difference is the reason this
 * file carries a table instead of a pair of constants:
 *
 *   - The CURRENT surface (Fable, Opus, Sonnet 5) takes adaptive thinking plus an
 *     `effort` rung, and rejects the older fixed thinking budget and the sampling
 *     parameters outright.
 *   - The LEGACY surface (Haiku 4.5) predates both: it takes a thinking budget in
 *     tokens and rejects `effort`. Haiku 5.5 is on the current surface.
 *
 * Some models add a rule of their own on top of that. Both Fables and Opus 5.5
 * cannot be asked NOT to think — an explicit no-thinking request is rejected at any
 * effort — and Opus 5 accepts one only at effort `high` or below. Sonnet 5.5 rejects
 * `disabled` too, but has its own off switch, `between_tools`, which skips the up-front
 * thinking, is accepted at effort `high` or below, and keeps the progress updates.
 * Those are wire facts, not preferences, so `SURFACES` below is the single place they
 * are written down: `normalize` reads it to keep a saved config legal, and `client.ts`
 * reads the same rows to decide what to put on the wire. One table, so the two cannot
 * drift apart.
 */
import type { DriverManifest, Effort, ModelChoice, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";

export const FABLE_51 = "claude-fable-5-1";
export const FABLE = "claude-fable-5";
export const OPUS_55 = "claude-opus-5-5";
export const OPUS = "claude-opus-5";
export const OPUS_48 = "claude-opus-4-8";
export const SONNET_55 = "claude-sonnet-5-5";
export const SONNET = "claude-sonnet-5";
export const HAIKU_55 = "claude-haiku-5-5";
export const HAIKU = "claude-haiku-4-5";

/** The model used when nothing is saved and no env override is set. */
export const DEFAULT_MODEL = SONNET_55;

/**
 * The models offered by `/model`. First entry is this provider's default, which is
 * also where `/provider` lands when someone switches to Anthropic.
 *
 * Descriptions say what the model is FOR, not what it scores. Someone reading the
 * picker is choosing between things they are about to pay for, and the useful
 * distinction is the kind of work each one earns its rate on.
 */
export const MODELS: ModelChoice[] = [
  { id: SONNET_55, label: "Claude Sonnet 5.5", description: "fast, strong at code — the default" },
  { id: SONNET, label: "Claude Sonnet 5", description: "the previous Sonnet, at the same rate" },
  { id: OPUS_55, label: "Claude Opus 5.5", description: "long-running agentic work, and cheaper than Opus 5" },
  { id: OPUS, label: "Claude Opus 5", description: "the previous Opus — deep reasoning for complex work" },
  { id: OPUS_48, label: "Claude Opus 4.8", description: "an older Opus — proven and steady" },
  { id: FABLE_51, label: "Claude Fable 5.1", description: "the toughest challenges, at the highest rate" },
  { id: FABLE, label: "Claude Fable 5", description: "the previous Fable, at the same rate" },
  { id: HAIKU_55, label: "Claude Haiku 5.5", description: "the fastest and cheapest, for quick, simple work" },
  { id: HAIKU, label: "Claude Haiku 4.5", description: "the previous Haiku, cheap and quick for simple work" },
];

/**
 * The wire facts that differ between these models.
 *
 * Everything here is something the API enforces. Nothing here is a judgment call
 * except `window`, which is called out where it is set.
 */
export interface ModelSurface {
  /** False when the model rejects an explicit no-thinking request (the Fables, Opus 5.5). */
  canDisableThinking: boolean;
  /** False when the model predates `output_config.effort` and rejects it (Haiku 4.5). */
  takesEffort: boolean;
  /** Highest effort at which thinking may be turned OFF; null when there is no cap. */
  maxDisabledEffort: Effort | null;
  /** Usable context window — see `contextWindow` for why this is not the storage cap. */
  window: number;
  /**
   * The server-side search tool version this model accepts. The newer one filters
   * results before they reach the context window, which the older models cannot do;
   * sending it to one of them is an error, not a graceful downgrade.
   */
  searchTool: "web_search_20260209" | "web_search_20250305";
  /**
   * True when the model writes its between-tool-call notes ("found X, now checking Y")
   * as PROGRESS-UPDATE thinking blocks instead of text. Those are empty unless the
   * request asks for them, so without this the reply goes silent between tool calls.
   * See `applyReasoning` in client.ts.
   */
  progressUpdates: boolean;
  /**
   * How "thinking off" is written on the wire for a model that CAN skip up-front thinking.
   * `disabled` for everything that accepts it; `between_tools` for Sonnet 5.5, where
   * `disabled` is a 400 and `between_tools` is the lowest setting. Absent means `disabled`.
   */
  thinkingOff?: "disabled" | "between_tools";
}

const CURRENT = {
  canDisableThinking: true,
  takesEffort: true,
  maxDisabledEffort: null,
  // Every model on this surface STORES 1M tokens, but this is deliberately the
  // sharp window rather than the storage cap: on BYOK every token in the window is
  // the user's money on every turn, so anchoring compaction at 1M would mean
  // carrying an enormous prompt long after it stopped earning its cost.
  window: 200_000,
  searchTool: "web_search_20260209",
  progressUpdates: false,
} as const satisfies ModelSurface;

const SURFACES: Record<string, ModelSurface> = {
  // Thinking is always on: `disabled` and a token budget are both rejected, so the
  // only `thinking` value ever sent is `adaptive` — see `applyReasoning` in client.ts.
  // These models (and Opus 5.5) write their between-tool notes as progress updates
  // (platform.claude.com/docs/en/build-with-claude/thinking, checked 2026-09-23).
  [FABLE_51]: { ...CURRENT, canDisableThinking: false, progressUpdates: true },
  [FABLE]: { ...CURRENT, canDisableThinking: false, progressUpdates: true },
  // Always thinking, like the Fables: `{type:"disabled"}` is a 400 on this model
  // (platform.claude.com, "What's new in Claude Opus 5.5", checked 2026-09-23).
  [OPUS_55]: { ...CURRENT, canDisableThinking: false, progressUpdates: true },
  // Thinking is on by default and `{type:"disabled"}` is a 400. The off switch is
  // `{type:"between_tools"}`: no up-front thinking, accepted at effort `high` or below
  // (at `xhigh`/`max` it is a 400), and it takes no other field. The progress updates
  // between tool calls still come back with their text under it, with no beta header.
  // Forced tool use is a 400 here too, and so is any non-default temperature/top_p/top_k;
  // this driver sends neither (platform.claude.com, "What's new in Claude Sonnet 5.5",
  // checked 2026-10-01).
  [SONNET_55]: { ...CURRENT, maxDisabledEffort: "high", progressUpdates: true, thinkingOff: "between_tools" },
  // Thinking may be turned off, but only at effort `high` or below.
  [OPUS]: { ...CURRENT, maxDisabledEffort: "high" },
  // Adaptive thinking is on by default and `{type:"disabled"}` is accepted at effort `high` or
  // below (a 400 at `xhigh`/`max`, exactly as on Opus 5); `between_tools` and a token budget
  // are both 400s. It takes `effort` (default `medium`), has no progress updates between tool
  // calls, and rejects any non-default temperature/top_p/top_k and an assistant prefill, none of
  // which this driver sends (platform.claude.com, "Claude Haiku 5.5 migration guide" and
  // "Thinking", checked 2026-10-10).
  //
  // The window is the one judgment call here. The model stores 1M tokens, but a prompt over
  // 100,000 tokens is billed at FIVE times every rate for the whole request, output and cache
  // included. This is the cheap model, picked to be cheap, so compaction is anchored at the
  // 100K line instead of letting a long session fall off a price cliff. The search tool is the
  // basic version: the filtering one runs through code execution, and whether this model
  // supports that is not something the docs state.
  [HAIKU_55]: { ...CURRENT, maxDisabledEffort: "high", window: 100_000, searchTool: "web_search_20250305" },
  [OPUS_48]: { ...CURRENT },
  [SONNET]: { ...CURRENT },
  // The legacy surface. No `effort` rungs, thinking is a token budget, and the
  // window here is the model's real maximum rather than a judgment call — Haiku
  // stores 200K, it does not store 1M.
  [HAIKU]: {
    canDisableThinking: true,
    takesEffort: false,
    maxDisabledEffort: null,
    window: 200_000,
    searchTool: "web_search_20250305",
    progressUpdates: false,
  },
};

/** The surface a model runs on, falling back to the default model's for unknown ids. */
export function surfaceOf(model: ModelId): ModelSurface {
  return SURFACES[model] ?? SURFACES[DEFAULT_MODEL]!;
}

/**
 * The reasoning levels offered by `/think`, which depend on the model's surface.
 *
 * Three shapes, one per surface rule:
 *
 *   - Fable 5 has no "answer directly" rung at all, because there is no such
 *     request to make. Offering one would be a switch that silently did nothing —
 *     or, worse, a 400. The choice on this model is only how much it thinks.
 *   - Haiku 4.5 has no effort ladder, so it gets the plain on/off pair. The stored
 *     `effort` is inert for it and `normalize` pins it so nothing odd persists.
 *   - The rest get the full four rungs.
 *
 * The current-surface "Standard" deliberately pairs no-thinking with `high` rather
 * than a lower rung: on Opus 5 thinking may only be turned off at effort `high` or
 * below, so this is the one setting that keeps a no-thinking request legal on every
 * model that offers it.
 */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  const surface = surfaceOf(model);

  if (!surface.canDisableThinking) {
    return [
      { label: "Standard", description: "always thinks — lighter budget", thinking: true, effort: "medium" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
      { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "xhigh" },
      { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
    ];
  }

  if (!surface.takesEffort) {
    return [
      { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
      { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
    ];
  }

  return [
    { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "high" },
    { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" },
    { label: "Deep", description: "more reasoning, more tool work", thinking: true, effort: "xhigh" },
    { label: "Maximum", description: "maximum reasoning budget", thinking: true, effort: "max" },
  ];
}

/**
 * List prices (USD / 1M tokens). Cache reads are ~1/10 of fresh input, which is
 * what keeps a re-sent conversation cheap.
 *
 * Sonnet 5 launched at an introductory $2/$10 through 2026-08-31, with a planned
 * rise to $3/$15 after — this file used to anchor on that durable price so the
 * estimate wouldn't under-report the moment the promo ended. It never ended:
 * Anthropic made $2/$10 the permanent price and cancelled the September 1 increase
 * (platform.claude.com/docs/en/about-claude/pricing, "Claude Sonnet 5 introductory
 * pricing" note, checked 2026-09-20). $3/$15 is Sonnet 4.6's price, not Sonnet 5's.
 */
/** Anthropic bills a 5-minute cache WRITE at 1.25x base input — the tokens are both
 *  processed and stored. (The 1h TTL is 2x; Mindweave does not buy it.) Folding writes
 *  into the plain input rate under-reported every turn of an agentic loop, which writes
 *  a new prefix segment constantly. */
const CACHE_WRITE_MULTIPLIER = 1.25;

const PRICES: Record<string, ModelPrice> = {
  // A quarter of Fable 5's cache read at the same input and output rate: 2.5% of base
  // input, where every other model on this surface reads back at 10%.
  [FABLE_51]: { cacheHit: 0.25, cacheMiss: 10, output: 50, cacheWrite: 10 * CACHE_WRITE_MULTIPLIER },
  [FABLE]: { cacheHit: 1, cacheMiss: 10, output: 50, cacheWrite: 10 * CACHE_WRITE_MULTIPLIER },
  // Cheaper than Opus 5 on every line, and its cache read is 5% of base input rather
  // than the usual 10% (platform.claude.com/docs/en/about-claude/pricing, 2026-09-23).
  [OPUS_55]: { cacheHit: 0.2, cacheMiss: 4, output: 20, cacheWrite: 4 * CACHE_WRITE_MULTIPLIER },
  [OPUS]: { cacheHit: 0.5, cacheMiss: 5, output: 25, cacheWrite: 5 * CACHE_WRITE_MULTIPLIER },
  [OPUS_48]: { cacheHit: 0.5, cacheMiss: 5, output: 25, cacheWrite: 5 * CACHE_WRITE_MULTIPLIER },
  [SONNET]: { cacheHit: 0.2, cacheMiss: 2, output: 10, cacheWrite: 2 * CACHE_WRITE_MULTIPLIER },
  // Same prices as Sonnet 5, cache read included (platform.claude.com/docs/en/about-claude/pricing,
  // checked 2026-10-01).
  [SONNET_55]: { cacheHit: 0.2, cacheMiss: 2, output: 10, cacheWrite: 2 * CACHE_WRITE_MULTIPLIER },
  [HAIKU]: { cacheHit: 0.1, cacheMiss: 1, output: 5, cacheWrite: 1 * CACHE_WRITE_MULTIPLIER },
  // The rate for a prompt up to 100,000 tokens. Over that, every line is five times higher
  // ($0.50 input, $2.50 output, $0.05 cache read, $0.625 cache write), applied to the whole
  // request. The window above keeps this driver under the line, so one row is enough
  // (platform.claude.com, "Claude Haiku 5.5" overview, checked 2026-10-10). Cache read is 10%
  // of input, and a 5-minute write is the usual 1.25x.
  [HAIKU_55]: { cacheHit: 0.01, cacheMiss: 0.1, output: 0.5, cacheWrite: 0.1 * CACHE_WRITE_MULTIPLIER },
};

/** Cache-aware list price for a model, falling back to the default model's. */
export function price(model: ModelId): ModelPrice {
  return PRICES[model] ?? PRICES[DEFAULT_MODEL]!;
}

/** The model's USABLE context window — see `ModelSurface.window`. */
export function contextWindow(model: ModelId): number {
  return surfaceOf(model).window;
}

/**
 * The ceiling this driver puts on a single buffered (non-streaming) call.
 *
 * Every model here accepts far more, but a non-streaming request that runs long
 * risks an HTTP timeout, so the buffered path — core's small internal calls, like
 * a compaction summary — is deliberately capped low. `client.ts` sends this value
 * and `dynamo/contextWindow.ts` reserves it; keeping one exported constant means
 * the request and the reservation cannot drift apart.
 *
 * The streaming ceiling is a separate, much larger number and lives in `client.ts`,
 * because nothing in core needs to reserve room for it.
 */
export const BUFFERED_OUTPUT_TOKENS = 16_000;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/** Effort rungs the current surface accepts, weakest first. */
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Every model offered here reads images. Anthropic accepts JPEG, PNG, GIF and WebP,
 * and downscales anything oversized itself, so this driver takes what core sends and
 * adds no resizing of its own.
 */
export function acceptsImages(_model: ModelId): boolean {
  return true;
}

/**
 * Coerce a stored or unknown config onto a model this provider actually serves, and
 * keep the reasoning intent legal for it.
 *
 * Four corrections. The first three enforce rules the API would otherwise reject:
 *   - Fable 5 always thinks, so a no-thinking config becomes a thinking one.
 *   - Haiku 4.5 takes no effort rung, so the stored value is pinned to `high`
 *     (inert for it, and the rung every other model treats as the safe default).
 *   - Opus 5 rejects no-thinking above `high`, so such a config steps its effort
 *     down rather than reaching the wire.
 *
 * The fourth is about the UI rather than the wire: the result is snapped onto a
 * rung the target model's `/think` ladder actually OFFERS. A legal-but-unlisted
 * setting is the failure this catches — Fable's lightest rung is `medium`, which
 * every current-surface model accepts happily, so carrying it to Sonnet produced a
 * config that worked but that `/think` could not show as selected, leaving the user
 * in a state with no tick beside it and no way to name what they were running.
 *
 * All four matter most on a MODEL SWITCH: `/model` carries the current reasoning
 * intent across, so every level of every model has to land somewhere real on every
 * other model.
 */
export function normalize(config: ModelConfig): ModelConfig {
  const model: ModelId = SURFACES[config.model] ? config.model : DEFAULT_MODEL;
  const surface = surfaceOf(model);

  const thinking = surface.canDisableThinking ? config.thinking === true : true;

  let effort: Effort = EFFORTS.includes(config.effort) ? config.effort : "high";
  if (!surface.takesEffort) effort = "high";
  const cap = surface.maxDisabledEffort;
  if (!thinking && cap && EFFORTS.indexOf(effort) > EFFORTS.indexOf(cap)) effort = cap;

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
export const anthropicManifest: DriverManifest = {
  id: "anthropic",
  label: "Anthropic",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  keysUrl: "https://console.anthropic.com/settings/keys",
  models: MODELS,
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  acceptsImages,
  normalize,
};
