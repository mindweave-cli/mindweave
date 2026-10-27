/**
 * contextWindow.ts — model-anchored compaction thresholds (pure).
 *
 * Compaction is anchored to the model's REAL context window rather than a fixed
 * number: reserve room for the summary output plus a safety buffer, then compact
 * when usage crosses what's left. That keeps the thresholds correct per model, and
 * automatically right when a stronger or longer model is wired in, instead of a
 * single hard-coded ceiling.
 *
 * The window itself is the driver's answer, and it is each model's SHARP window —
 * the span where attention stays reliable — not its storage maximum. A model that
 * stores 1M tokens can still degrade from tool-noise dilution long before that, and
 * on BYOK every token is the user's money, so compacting to the sharp window is
 * both more accurate and cheaper.
 *
 * THE DIVISION OF LABOUR. A driver reports facts it can measure — its window, and
 * the ceiling it puts on a buffered call. This module owns every decision made on
 * top of them: how much headroom to leave, where the bars land, and the invariant
 * that ties them together. A driver returning its own bars would be a decision in
 * the driver, which is the line this project doesn't cross; see BOUNDARY.md.
 */
import { manifestForModel } from "../drivers/registry.js";

/**
 * Reserve used when a driver declares no buffered ceiling of its own — it sends no
 * `max_tokens` and lets the provider's default apply, as the DeepSeek driver does.
 * With no number to reserve, core keeps the conservative one it has always used.
 */
const DEFAULT_SUMMARY_RESERVE = 20_000;

/** Headroom below the window so one turn's growth can't blow past it. */
const TURN_HEADROOM = 13_000;

/** Floor for the auto bar, so a tiny window still leaves a usable transcript. */
const MIN_AUTO_BAR = 20_000;

/** Share of the window micro-compaction aims at on an ordinary model. */
const MICRO_SHARE = 0.3;

/**
 * Absolute cap on the micro bar.
 *
 * A flat share of the window stops making sense once windows get large: at 30% a
 * 500K model would carry 150K of stale tool output on every turn, which is not a
 * lean working set on any model and is the user's money on BYOK. The purpose of
 * micro-compaction is a lean working set, and that purpose is absolute rather than
 * proportional, so the share gets a ceiling.
 *
 * 96K is a judgment call under absent data, chosen so it sits ABOVE the share for
 * every window we ship today (30% of 256K is 76.8K) and only engages past ~320K.
 * That is deliberate: no shipped model changes behaviour, and the cap exists for
 * the longer models it was written for. Revisit it if anyone measures where a
 * working set actually stops paying for itself.
 */
const MICRO_CEILING = 96_000;

/**
 * Hard guard: micro never rises above this share of the auto bar.
 *
 * The two bars are computed from different inputs, so a large enough reserve on a
 * small enough window could otherwise push micro past auto and invert them —
 * clearing tool bodies at the same moment we summarize. This keeps the ordering a
 * property of the arithmetic rather than something the numbers happen to satisfy.
 */
const MICRO_MAX_SHARE_OF_AUTO = 0.6;

/**
 * The part of the prompt that is NOT the transcript, measured rather than assumed:
 * what the provider said the whole prompt was, minus what we measured the transcript
 * to be on the way out. That remainder is the system prompt, every tool schema, the
 * working-set block, the relevance map, todos and the governor — none of which the
 * bars could see when they counted only the transcript.
 *
 * Clamped at zero. The transcript estimator is deliberately conservative and can read
 * HIGHER than the provider's real count; a negative overhead would then push the bars
 * later, which is precisely the failure this removes.
 */
export function measuredOverhead(promptTokens: number, transcriptTokens: number): number {
  return Math.max(0, promptTokens - transcriptTokens);
}

/** The model's usable context window, as its driver reports it. */
/**
 * What one compaction pass did, in tokens.
 *
 * Lives here rather than in the CLI because it is a fact about context accounting, not
 * about a terminal: the engine produces it and any client (a future server, a different
 * UI) renders it however it likes. The CLI's job is only to draw bars from it.
 */
export interface CompactionReport {
  /** Context in use before the pass. */
  before: number;
  /** Context in use after it. */
  after: number;
  /** The model's full context window. */
  window: number;
}

export function sharpContextWindow(model: string): number {
  return manifestForModel(model).contextWindow(model);
}

/**
 * How much room to keep free for a compaction summary, as the model's driver
 * reports it. A driver that declares no buffered ceiling falls back to core's
 * conservative default rather than reserving nothing.
 */
export function summaryReserveFor(model: string): number {
  const declared = manifestForModel(model).bufferedOutputTokens?.(model);
  return declared !== undefined && declared > 0 ? declared : DEFAULT_SUMMARY_RESERVE;
}

/**
 * Autocompact bar: summarize once the transcript crosses
 * (window − summary reserve − turn headroom). For a 256K window reserving 20K
 * that's 223K.
 */
export function autoBarFor(window: number, summaryReserve = DEFAULT_SUMMARY_RESERVE): number {
  return Math.max(MIN_AUTO_BAR, window - summaryReserve - TURN_HEADROOM);
}

/**
 * Microcompact bar: clear old tool-result bodies well before the autocompact bar,
 * so the working set stays lean continuously rather than only at the summary point.
 * A share of the window, capped in absolute terms, and always kept clear of the
 * auto bar.
 */
export function microBarFor(window: number, summaryReserve = DEFAULT_SUMMARY_RESERVE): number {
  return Math.min(
    Math.round(window * MICRO_SHARE),
    MICRO_CEILING,
    Math.round(autoBarFor(window, summaryReserve) * MICRO_MAX_SHARE_OF_AUTO),
  );
}

/**
 * How far below the auto bar to start telling the user context is filling up.
 *
 * A share rather than a fixed number, so it scales with the model the way every other
 * bar here does: 20K of warning is most of a small window's usable transcript and a
 * rounding error on a large one. The point is to give roughly a turn or two of notice,
 * and a turn is proportional to the window.
 */
const WARN_SHARE_OF_AUTO = 0.9;

/**
 * The point at which the user should be told, once, that a compaction is coming.
 *
 * Compaction rewrites the conversation. It is not a failure and it does not need
 * permission, but arriving with no notice is how a user ends up wondering why the
 * model forgot the middle of their session.
 */
export function warnBarFor(autoBar: number): number {
  return Math.round(autoBar * WARN_SHARE_OF_AUTO);
}

/** What to tell the user about how close a compaction is (pure). */
export interface ContextPressure {
  /** Show the notice at all — context has crossed the warn bar (90% of the auto bar). */
  warn: boolean;
  /**
   * How much of the way to auto-compaction is LEFT, 0–100. At the warn bar this is ~10;
   * it reaches 0 as the auto bar is hit and the summarizing pass runs. A percentage, not a
   * token count, on purpose: the notice is about ROOM remaining, not spend.
   */
  percentLeft: number;
}

/**
 * Turn a measured context size into the proactive "a compaction is coming" notice.
 *
 * Nothing shows until context crosses the warn bar (`warnBarFor`, 90% of the auto bar), so
 * an ordinary session never sees it — it appears only for the turn or two of notice before
 * the summarizing pass rewrites the conversation, which is the one thing a user should not
 * meet by surprise. The arithmetic is the SAME auto bar the compaction decision runs on, so
 * what the notice says and what actually happens cannot disagree.
 */
export function contextPressure(used: number, model: string): ContextPressure {
  const auto = autoCompactThreshold(model);
  const percentLeft = auto > 0 ? Math.max(0, Math.round(((auto - used) / auto) * 100)) : 0;
  return { warn: used >= warnBarFor(auto), percentLeft };
}

/** Autocompact bar for a model, anchored to its driver's numbers. */
export function autoCompactThreshold(model: string): number {
  return autoBarFor(sharpContextWindow(model), summaryReserveFor(model));
}

/** Microcompact bar for a model, anchored to its driver's numbers. */
export function microCompactThreshold(model: string): number {
  return microBarFor(sharpContextWindow(model), summaryReserveFor(model));
}

/**
 * How long a provider's prompt cache is assumed to survive between requests.
 *
 * 60 minutes, and the size matters more than it looks. This was 5 minutes — Anthropic's
 * default ephemeral TTL — on the reasoning that anything past it is certainly gone. That
 * is wrong in the DANGEROUS direction: the number decides when we clear tool bodies, and
 * clearing rewrites the cached prefix. Guess too SHORT and we destroy an entry that was
 * still alive, forcing a full-price rewrite that would never have happened. Guess too
 * long and we merely miss a saving.
 *
 * Five minutes is only Anthropic's default tier. Its 1h tier exists, DeepSeek's context
 * cache persists for hours, and several providers publish nothing at all — so a 5-minute
 * assumption would have been actively wrong on most of the lineup.
 *
 * 60 minutes is the smallest value that is safe everywhere: past an hour no provider in
 * the lineup is documented to still be holding the prefix, so clearing can only be
 * reclaiming something already lost. Being wrong is then free rather than expensive.
 *
 * This is the value for a provider that states no lifetime of its own. One that does (see
 * `cacheLifetimeFor`) is trusted instead, so a short-lived cache is recognised as gone sooner.
 */
export const CACHE_TTL_MS = (() => {
  const raw = Number(process.env.MINDWEAVE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();

/**
 * Below this share of the micro bar, a cold cache is not worth compacting for. A
 * session holding almost nothing has almost nothing to save, and clearing tool bodies
 * early costs real detail.
 */
const COLD_COMPACT_FLOOR = 0.5;

/**
 * How long this model's provider keeps a cached prefix after its last use: what the driver says,
 * else the long default above. `MINDWEAVE_CACHE_TTL_MS` overrides both.
 */
export function cacheLifetimeFor(model: string): number {
  const raw = Number(process.env.MINDWEAVE_CACHE_TTL_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return manifestForModel(model).cacheLifetimeMs?.(model) ?? CACHE_TTL_MS;
}

/**
 * Whether this model's provider discounts cached input at all. Where a cache hit costs what a miss
 * costs (or nothing is charged), timing a rewrite around the cache gains nothing.
 */
export function cacheIsDiscounted(model: string): boolean {
  const price = manifestForModel(model).price(model);
  return price.cacheMiss > 0 && price.cacheHit < price.cacheMiss;
}

/**
 * What the next request to a model will find in the provider's cache.
 *
 *  - `warm`: this model was called within its provider's cache lifetime.
 *  - `idle`: it was called, but longer ago than that.
 *  - `switched`: other models were called in this session and this one has not been. Providers
 *    cache per model, so the copy the previous model holds is of no use to this one, however
 *    recently it was written.
 *  - `none`: no call has been made, so there is nothing cached.
 *
 * A session reopened from a file starts with its last model stamped at the time the file was last
 * saved, so a long break reads as `idle` and a model change as `switched`.
 */
export type CacheStatus = "warm" | "idle" | "switched" | "none";

export function cacheStatus(o: {
  now: number;
  model: string;
  /** When each model was last called in this session, epoch ms. */
  lastByModel?: Readonly<Record<string, number>>;
  ttlMs: number;
}): CacheStatus {
  const last = o.lastByModel?.[o.model];
  if (last && last > 0) return o.now - last > o.ttlMs ? "idle" : "warm";
  return o.lastByModel && Object.keys(o.lastByModel).length > 0 ? "switched" : "none";
}

/** Whether the provider holds no usable copy of the conversation for the next request. */
export function isCold(status: CacheStatus): boolean {
  return status === "idle" || status === "switched";
}

/**
 * Whether to microcompact because the provider's cache is gone, rather than because context is
 * filling up.
 *
 * The normal gate exists for a specific reason: clearing an old tool body REWRITES the
 * transcript, and the transcript is the cached half of the request, so on a warm cache
 * it trades a cheap cached read for a full prefix rewrite at 1.25x. That is a loss, and
 * it is why microcompaction waits for real pressure.
 *
 * None of that argument survives the cache being gone. There is no entry left to invalidate —
 * the next request pays to write the whole prefix no matter what it contains. Clearing stale
 * tool bodies first is then strictly free, and the tokens never have to be paid for again.
 */
export function cacheLikelyCold(status: CacheStatus, used: number, microBar: number): boolean {
  return isCold(status) && used >= microBar * COLD_COMPACT_FLOOR;
}

/**
 * Whether to compact the conversation from the session notes now, because the whole history is
 * about to be sent at full price regardless.
 *
 * Only when there is a lot to shrink (at the micro bar), only where the provider discounts cached
 * input (otherwise the timing gains nothing), and not twice in quick succession: compacting loses
 * detail, and someone moving between models should not have it happen on every switch.
 */
export function shouldCompactForCold(o: {
  status: CacheStatus;
  used: number;
  microBar: number;
  discounted: boolean;
  /** When the last such compaction ran, epoch ms, if one did. */
  lastColdCompactAt?: number;
  /** How long this model has gone uncalled. */
  idleMs: number;
  now: number;
}): boolean {
  if (!isCold(o.status) || !o.discounted) return false;
  // A short break is not worth losing detail over, even on a provider whose cache is gone by then.
  if (o.status === "idle" && o.idleMs < COLD_COMPACT_MIN_IDLE_MS) return false;
  if (o.used < o.microBar) return false;
  return !(o.lastColdCompactAt && o.now - o.lastColdCompactAt < COLD_COMPACT_COOLDOWN_MS);
}

/** The line shown in the chat when the conversation is compacted because the provider's cache is gone. */
export function coldCompactionLine(status: CacheStatus, model: string, idleMs: number): string {
  const why =
    status === "switched"
      ? `${model} has no cached copy of this conversation`
      : `the provider's cache for this conversation expired after ${Math.max(1, Math.round(idleMs / 60_000))} minutes idle`;
  return `Compacted automatically: ${why}, so it was going to be re-sent at full price anyway. The session notes and the latest work were kept.`;
}

/** An idle break shorter than this never compacts the conversation, whatever the provider's cache lifetime. */
export const COLD_COMPACT_MIN_IDLE_MS = 15 * 60 * 1000;

/** After a compaction for a cold cache, wait this long before doing it again. */
export const COLD_COMPACT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * How many further calls a clear is assumed to keep paying off for.
 *
 * Clearing an old tool body or image is not free on a warm cache: the provider holds the
 * conversation as a prefix, a change inside it invalidates everything after the change, and
 * the next request writes that tail again at the full input price (plus a write premium, where
 * the provider charges one) where it would have read it at the cached price. Written out, with
 * T the tokens from the first changed message to the end, R the tokens the clear reclaims, h the
 * cached read price and w the write price:
 *
 *     paid once, on the next call   = T * (w - h)
 *     saved on every later call     = R * h
 *     worth it when                   R * h * horizon >= T * (w - h)
 *
 * The prices decide it, and they differ by an order of magnitude between providers: a cached read
 * costs 10% of input on one, 2% on another, 20% on a third. At 2% the saving per call is so
 * small that a clear which rewrites a 25K tail to reclaim 26K needs about 47 further calls to
 * break even; at 10% the same clear needs about 11. The same clear is right on one provider and
 * a loss on another, which a fixed fraction of the prefix could not tell apart.
 *
 * A long run is 30 to 80 calls after a clear, so 40 is where it is still a fair bet. Past it
 * the clear is declined and the context is allowed to fill: carrying the extra tokens is a
 * cached read, cheap, and the clear is made anyway when the cache goes cold or the autocompact
 * bar is close, both of which cost nothing extra.
 */
export const CLEAR_HORIZON_STEPS = 40;

/**
 * Whether a proposed microcompaction should actually be committed.
 *
 * Three ways to say yes, and they are different kinds of reason:
 *
 *  - `cold`: the provider's cache has expired, so there is no entry to invalidate and
 *    the rewrite is free. Any reclaim at all is profit.
 *  - `urgent`: context is close enough to the autocompact bar that FITTING matters more
 *    than cost. A request that does not fit cannot be sent at any price.
 *  - otherwise: only when what it saves over the next calls out-earns the cache rewrite
 *    it forces, at this provider's prices (see `CLEAR_HORIZON_STEPS`).
 *
 * Pure, because the alternative is discovering the economics were wrong from a bill.
 */
export function clearIsWorthIt(opts: {
  /** Tokens the request carries now. */
  before: number;
  /** Tokens it would carry after the proposed clear. */
  after: number;
  /** Whether the provider's cache has already expired. */
  cold: boolean;
  /** The autocompact bar — past it, a summarization pass happens anyway. */
  autoBar: number;
  /**
   * Tokens from the first message the clear changes to the end of the conversation, as they
   * would be after it: everything the provider has to write again. A clear of something old
   * rewrites nearly all of it; one near the end rewrites almost nothing.
   */
  rewritten: number;
  /** What the model's provider charges, per million tokens. */
  price: { cacheHit: number; cacheMiss: number; cacheWrite?: number | null };
  /** Calls the saving is assumed to last for. Defaults to `CLEAR_HORIZON_STEPS`. */
  horizon?: number;
}): boolean {
  const reclaimed = opts.before - opts.after;
  if (reclaimed <= 0) return false;
  if (opts.cold) return true;
  // Close to the bar, fitting beats saving: clearing here is what defers a far more
  // expensive summarization, and a prompt that overflows is not a cost question.
  if (opts.before >= opts.autoBar * 0.9) return true;
  const write = opts.price.cacheWrite ?? opts.price.cacheMiss;
  const paidOnce = opts.rewritten * Math.max(0, write - opts.price.cacheHit);
  // A provider that charges the same for a hit as for a miss has nothing to lose by a rewrite.
  if (paidOnce <= 0) return true;
  return reclaimed * opts.price.cacheHit * (opts.horizon ?? CLEAR_HORIZON_STEPS) >= paidOnce;
}
