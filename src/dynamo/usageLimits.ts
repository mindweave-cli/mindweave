/**
 * usageLimits.ts — a cap you set on your own use, in windows that open and close.
 *
 * Shaped like the plans people already know: a short window (5 hours) that closes when its
 * amount is used and reopens when it ends; a longer one (a week) that does the same; and the
 * month's own budget above both. You set the month, "Analyze" works out the other two from how
 * you actually use the tool, and the numbers stay editable.
 *
 * THE UNIT IS YOURS: tokens (fresh input plus output, the same "billed" figure the Spend tab
 * shows) or money (those tokens at each model's own rates). Both come from the per-call log
 * every session already keeps, so nothing new is recorded and nothing leaves the machine.
 *
 * WINDOWS ARE DERIVED, NOT STORED. A window opens at the first use after the previous one
 * ended and lasts its span, so where one starts is a fact about the usage history and can be
 * recomputed from it. That keeps the app and the terminal agreeing without sharing any state
 * beyond the history they both already write.
 *
 * A LIMIT IS CHECKED BETWEEN STEPS, never inside one. A step that begins under the limit
 * finishes, so a window can be passed by what that one step cost (a few thousand tokens) and
 * never by more. The next step is what stops, and it stops cleanly: nothing is lost, and the
 * work can carry on once the window reopens.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { callRecords, everyMeta } from "../memory/allMetas.js";
import { stateRoot } from "../memory/store.js";
import type { Usage } from "../drivers/types.js";
import { priceFor } from "./pricing.js";

export type LimitUnit = "tokens" | "usd";

export interface LimitsConfig {
  /** Limits are being tracked (and, if `enforce`, held to). */
  enabled: boolean;
  unit: LimitUnit;
  /** The month's budget, in `unit`. The one number you set; the windows come from it. */
  monthly: number;
  /** The day of the month the budget starts over (1-28), for a plan that bills mid-month. */
  monthStartDay: number;
  /** The 5-hour window's amount. Filled by Analyze; edit it freely. 0 = no window. */
  fiveHour: number;
  /** The week's amount. Filled by Analyze; edit it freely. 0 = no window. */
  weekly: number;
  /** True: stop at a limit. False: only warn. */
  enforce: boolean;
  /** When Analyze last filled the windows (epoch ms), for the panel's note. */
  analyzedAt?: number;
  /**
   * The moment the week resets, once; every later reset is a whole number of weeks from it. Like
   * a plan's weekly limit, it resets at the SAME day and time each week, whenever you happen to
   * use the tool. Set when limits are first turned on.
   */
  weeklyResetAt?: number;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  enabled: false,
  unit: "tokens",
  monthly: 0,
  monthStartDay: 1,
  fiveHour: 0,
  weekly: 0,
  enforce: true,
};

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** How much history the windows are worked out from. Long enough for a week's chain to settle. */
const HORIZON_MS = 62 * 24 * 60 * 60 * 1000;
/** Warnings, lowest first. Each fires once per window. */
const WARN_AT = [0.8, 0.95] as const;
/** The disk is re-read at most this often; live use is added in between. */
const REFRESH_MS = 60_000;

// ── config ───────────────────────────────────────────────────────────────────

export function limitsPath(): string {
  return join(stateRoot(), "limits.json");
}

function num(v: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/** Whatever was written, made safe: a hand-edited or half-written file never breaks the app. */
export function sanitizeLimits(raw: unknown): LimitsConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const unit: LimitUnit = r["unit"] === "usd" ? "usd" : "tokens";
  const money = unit === "usd";
  const round = (n: number) => (money ? Math.round(n * 100) / 100 : Math.round(n));
  const cfg: LimitsConfig = {
    enabled: r["enabled"] === true,
    unit,
    monthly: round(num(r["monthly"], 0)),
    monthStartDay: Math.min(28, Math.max(1, Math.round(num(r["monthStartDay"], 1)))),
    fiveHour: round(num(r["fiveHour"], 0)),
    weekly: round(num(r["weekly"], 0)),
    enforce: r["enforce"] !== false,
  };
  const at = num(r["analyzedAt"], 0);
  if (at > 0) cfg.analyzedAt = at;
  const reset = num(r["weeklyResetAt"], 0);
  if (reset > 0) cfg.weeklyResetAt = reset;
  return cfg;
}

export async function readLimitsConfig(): Promise<LimitsConfig> {
  try {
    return sanitizeLimits(JSON.parse(await fs.readFile(limitsPath(), "utf8")));
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

async function writeLimitsFile(cfg: LimitsConfig): Promise<void> {
  const file = limitsPath();
  await fs.mkdir(stateRoot(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await fs.rename(tmp, file); // whole file or nothing: a crash mid-write cannot leave half of one
}

// ── the ledger: what has been used, and when ─────────────────────────────────

interface Rec {
  at: number;
  tokens: number;
  usd: number;
}

let config: LimitsConfig = { ...DEFAULT_LIMITS };
let ledger: Rec[] = [];
let loadedAt = 0;
const told = new Set<string>();

/** Fresh input plus output, and what those cost at the model's own rates. */
export function callAmount(model: string, hit: number, miss: number, out: number): { tokens: number; usd: number } {
  const price = priceFor(model);
  return { tokens: miss + out, usd: (hit * price.cacheHit + miss * price.cacheMiss + out * price.output) / 1_000_000 };
}

async function loadLedger(now: number): Promise<Rec[]> {
  const since = now - HORIZON_MS;
  const recs: Rec[] = [];
  for (const meta of await everyMeta()) {
    for (const c of callRecords(meta)) {
      if (c.at >= since) recs.push({ at: c.at, ...callAmount(c.model, c.hit, c.miss, c.out) });
    }
  }
  return recs.sort((a, b) => a.at - b.at);
}

// ── the 5-hour session's start, remembered ──────────────────────────────────

function statePath(): string {
  return join(stateRoot(), "limits-state.json");
}

/**
 * Where the current 5-hour session began. A session opens at the first use after the last one
 * ended, so its start is a fact of the history; it is kept so that it stays put, rather than
 * being worked out again from however much history happens to be in view (nonstop use would
 * otherwise slide its boundaries as old records age out).
 */
let fiveSeed: number | null = null;

async function readFiveSeed(): Promise<number | null> {
  try {
    const v = (JSON.parse(await fs.readFile(statePath(), "utf8")) as { fiveHourStart?: unknown }).fiveHourStart;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

async function writeFiveSeed(): Promise<void> {
  try {
    await fs.mkdir(stateRoot(), { recursive: true });
    const tmp = `${statePath()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ fiveHourStart: fiveSeed }), "utf8");
    await fs.rename(tmp, statePath());
  } catch {
    /* the start is re-derived from the history next time: losing this only costs exactness */
  }
}

/** Where a session that began at `seed` stands once a use at `at` happens. */
function advanceSeed(seed: number | null, at: number): number {
  return seed === null || at >= seed + FIVE_HOURS_MS ? at : seed;
}

/**
 * Bring the settings and the history up to date. Cheap when limits are off (one small file
 * read), and when on the disk is scanned at most once a minute, with live use added between.
 * `force` reads the history even while limits are off: Analyze needs it before they are on.
 */
export async function refreshUsageLimits(opts: { force?: boolean; now?: number } = {}): Promise<LimitsConfig> {
  const now = opts.now ?? Date.now();
  config = await readLimitsConfig();
  if (!config.enabled && !opts.force) return config;
  if (opts.force || loadedAt === 0 || now - loadedAt >= REFRESH_MS) await adoptLedger(await loadLedger(now), now);
  // A limit set before the week had a fixed reset: keep the week it was already in.
  if (config.enabled && config.weekly > 0 && !config.weeklyResetAt) {
    config = { ...config, weeklyResetAt: latestWindow(ledger, WEEK_MS, "tokens")?.start ?? now };
    await writeLimitsFile(config);
  }
  return config;
}

/**
 * Take a freshly read history as the truth, together with where the 5-hour session began: the
 * remembered start carried forward through whatever has happened since. The two always move
 * together, because a history without its session start would let the next call open a new
 * session and ignore the hours already used.
 */
async function adoptLedger(recs: Rec[], now: number): Promise<void> {
  ledger = recs;
  loadedAt = now;
  const before = await readFiveSeed();
  fiveSeed = latestWindow(ledger, FIVE_HOURS_MS, "tokens", before)?.start ?? null;
  if (fiveSeed !== before) await writeFiveSeed();
}

/** A model call finished: count it. Ignored while limits are off. */
export function noteUsage(model: string, u: Usage, at = Date.now()): void {
  if (!config.enabled) return;
  // Exactly what the per-call log records for this call (fresh input plus output), so the figure
  // does not change when the history is read back from disk, and matches the Spend tab.
  ledger.push({ at, ...callAmount(model, u.cacheHitTokens, u.cacheMissTokens, u.completionTokens) });
  const next = advanceSeed(fiveSeed, at);
  if (next !== fiveSeed) {
    fiveSeed = next;
    void writeFiveSeed();
  }
}

// ── windows ──────────────────────────────────────────────────────────────────

export type WindowId = "fiveHour" | "weekly" | "monthly";
export type WindowState = "idle" | "ok" | "warn" | "blocked";

export interface WindowStatus {
  id: WindowId;
  label: string;
  limit: number;
  used: number;
  /** used / limit, uncapped (1.02 means passed by two percent). */
  fraction: number;
  /** When this window opened, or null when none is open. */
  start: number | null;
  /** When it closes and the amount starts over, or null when none is open. */
  end: number | null;
  state: WindowState;
}

export interface LimitsStatus {
  unit: LimitUnit;
  enabled: boolean;
  enforce: boolean;
  windows: WindowStatus[];
  /** The window holding work back right now (the one that reopens last), if any. */
  blocked: WindowStatus | null;
  now: number;
}

interface Chain {
  start: number;
  end: number;
  used: number;
}

/**
 * The latest window in a history: opens at the first use after the last one ended. With a
 * `seed` (where a window is known to have begun) it carries on from there and ignores anything
 * older, so the answer does not depend on how far back the history happens to reach.
 */
function latestWindow(recs: Rec[], span: number, field: "tokens" | "usd", seed: number | null = null): Chain | null {
  let cur: Chain | null = seed !== null ? { start: seed, end: seed + span, used: 0 } : null;
  for (const r of recs) {
    if (seed !== null && r.at < seed) continue;
    if (!cur || r.at >= cur.end) cur = { start: r.at, end: r.at + span, used: 0 };
    cur.used += r[field];
  }
  return cur;
}

function daysIn(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}
function billingStart(year: number, month: number, day: number): number {
  return new Date(year, month, Math.min(day, daysIn(year, month)), 0, 0, 0, 0).getTime();
}
/** The billing month containing `now`: [start, end) in local time. */
export function billingMonth(now: number, day: number): { start: number; end: number } {
  const d = new Date(now);
  let y = d.getFullYear();
  let m = d.getMonth();
  if (billingStart(y, m, day) > now) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  const start = billingStart(y, m, day);
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  return { start, end: billingStart(ny, nm, day) };
}

function stateOf(fraction: number, now: number, end: number | null): WindowState {
  if (end === null) return "idle";
  if (now >= end) return "idle";
  if (fraction >= 1) return "blocked";
  if (fraction >= WARN_AT[0]) return "warn";
  return "ok";
}

function windowStatus(id: WindowId, label: string, limit: number, chain: Chain | null, now: number): WindowStatus {
  const open = chain !== null && now < chain.end;
  const used = open ? chain.used : 0;
  const fraction = limit > 0 ? used / limit : 0;
  return {
    id,
    label,
    limit,
    used,
    fraction,
    start: open ? chain.start : null,
    end: open ? chain.end : null,
    state: stateOf(fraction, now, open ? chain.end : null),
  };
}

/** Where every window stands. Pure: hand it a config and a history. */
export function computeStatus(cfg: LimitsConfig, recs: readonly Rec[], now: number, fiveStart: number | null = null): LimitsStatus {
  const field = cfg.unit === "usd" ? "usd" : "tokens";
  const inHorizon = recs.filter((r) => r.at <= now).sort((a, b) => a.at - b.at); // windows chain in time order
  const windows: WindowStatus[] = [];
  if (cfg.fiveHour > 0) windows.push(windowStatus("fiveHour", "5-hour", cfg.fiveHour, latestWindow(inHorizon, FIVE_HOURS_MS, field, fiveStart), now));
  if (cfg.weekly > 0) {
    // A fixed weekly reset: the same day and time every week, whenever you use the tool. Weeks
    // are counted from the reset moment, so they never depend on the history at all.
    const anchor = cfg.weeklyResetAt ?? now;
    const start = anchor + Math.floor((now - anchor) / WEEK_MS) * WEEK_MS;
    const used = inHorizon.filter((r) => r.at >= start && r.at < start + WEEK_MS).reduce((s, r) => s + r[field], 0);
    windows.push(windowStatus("weekly", "weekly", cfg.weekly, { start, end: start + WEEK_MS, used }, now));
  }
  if (cfg.monthly > 0) {
    const m = billingMonth(now, cfg.monthStartDay);
    const used = inHorizon.filter((r) => r.at >= m.start && r.at < m.end).reduce((s, r) => s + r[field], 0);
    windows.push(windowStatus("monthly", "monthly", cfg.monthly, { start: m.start, end: m.end, used }, now));
  }
  const blocking = windows.filter((w) => w.state === "blocked");
  const blocked = blocking.length > 0 ? blocking.reduce((a, b) => ((b.end ?? 0) > (a.end ?? 0) ? b : a)) : null;
  return { unit: cfg.unit, enabled: cfg.enabled, enforce: cfg.enforce, windows, blocked, now };
}

/** Where the windows stand right now, from the live history. */
export function limitStatus(now = Date.now()): LimitsStatus {
  return computeStatus(config, ledger, now, fiveSeed);
}

/** The settings as last read. */
export function currentLimits(): LimitsConfig {
  return config;
}

// ── wording ──────────────────────────────────────────────────────────────────

export function formatAmount(unit: LimitUnit, n: number): string {
  if (unit === "usd") return n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M tokens`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K tokens`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K tokens`;
  return `${Math.round(n)} tokens`;
}

/** "40m", "2h 10m", "3d 4h": how long until something happens. */
export function formatWait(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 ? ` ${min % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/** "7:40 PM" today, "Thu 9:15 AM" within the week, "Oct 1" beyond. */
export function formatWhen(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return time;
  if (at - now < WEEK_MS) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function windowName(w: WindowStatus): string {
  return w.id === "fiveHour" ? "5-hour" : w.id === "weekly" ? "weekly" : "monthly";
}

/** Why work is being held, in one sentence, or null when nothing is. */
export function blockReason(status: LimitsStatus): string | null {
  const w = status.blocked;
  if (!w || w.end === null) return null;
  return (
    `your ${windowName(w)} limit is used up (${formatAmount(status.unit, w.used)} of ${formatAmount(status.unit, w.limit)}). ` +
    `It opens again ${formatWhen(w.end, status.now)} (in ${formatWait(w.end - status.now)})`
  );
}

/** What the engine asks before each step: a reason to stop, or null to carry on. */
export function limitGateReason(now = Date.now()): string | null {
  if (!config.enabled || !config.enforce) return null;
  return blockReason(limitStatus(now));
}

/**
 * Heads-up lines for windows that just crossed 80% or 95%. Each threshold speaks once per window,
 * and if several were crossed at once only the highest is said.
 */
export function takeLimitWarnings(now = Date.now()): string[] {
  if (!config.enabled) return [];
  const status = limitStatus(now);
  const out: string[] = [];
  for (const w of status.windows) {
    if (w.state === "idle" || w.end === null || w.start === null) continue;
    let hit: number | null = null;
    for (const t of WARN_AT) if (w.fraction >= t) hit = t;
    if (hit === null || w.fraction >= 1) continue; // at 100% the gate speaks instead
    if (told.has(`${w.id}:${w.start}:${hit}`)) continue;
    // Anything lower counts as told too, so an 80% heads-up never follows a 95% one.
    for (const t of WARN_AT) if (t <= hit) told.add(`${w.id}:${w.start}:${t}`);
    out.push(
      `${Math.round(hit * 100)}% of your ${windowName(w)} limit is used (${formatAmount(status.unit, w.used)} of ${formatAmount(status.unit, w.limit)}). ` +
        `It resets ${formatWhen(w.end, now)} (in ${formatWait(w.end - now)}).`,
    );
  }
  return out;
}

// ── analyze ──────────────────────────────────────────────────────────────────

export interface Analysis {
  fiveHour: number;
  weekly: number;
  /** How many separate 5-hour windows a week you typically use. */
  windowsPerWeek: number;
  /** Days of history that informed it; 0 means none, and a default was assumed. */
  basedOnDays: number;
  note: string;
}

const DEFAULT_WINDOWS_PER_WEEK = 8;

/**
 * Turn a month's budget into the windows that fit it.
 *
 * The week gets its share of the month (7 days out of however many this month has), so weeks
 * spent in full add up to the month and nothing more. The 5-hour window comes from how you
 * work: if you typically open about eight windows a week, one window's fair share is an eighth
 * of the week; it is given half again as much so a long session is not cut short, but never
 * more than half the week, so one heavy afternoon cannot spend the whole of it.
 */
export function analyzeLimits(cfg: Pick<LimitsConfig, "unit" | "monthly" | "monthStartDay">, recs: readonly Rec[], now: number): Analysis {
  const money = cfg.unit === "usd";
  const month = billingMonth(now, cfg.monthStartDay);
  const days = Math.round((month.end - month.start) / 86_400_000);
  const weekly = (cfg.monthly * 7) / days;

  const since = now - 28 * 86_400_000;
  const recent = recs.filter((r) => r.at >= since && r.at <= now).sort((a, b) => a.at - b.at);
  let perWeek = DEFAULT_WINDOWS_PER_WEEK;
  let basedOnDays = 0;
  if (recent.length > 0) {
    let windows = 0;
    let end = 0;
    for (const r of recent) {
      if (r.at >= end) { windows++; end = r.at + FIVE_HOURS_MS; }
    }
    basedOnDays = Math.max(1, Math.min(28, Math.ceil((now - recent[0]!.at) / 86_400_000)));
    const weeks = Math.max(1, basedOnDays / 7);
    perWeek = Math.min(14, Math.max(4, Math.round(windows / weeks)));
  }
  const fiveHourRaw = Math.min(weekly * 0.5, (weekly / perWeek) * 1.5);
  const tidy = (n: number) => (money ? Math.max(0.01, Math.round(n * 100) / 100) : Math.max(1000, Math.round(n / 1000) * 1000));
  const note =
    (basedOnDays > 0
      ? `Based on your last ${basedOnDays} day${basedOnDays === 1 ? "" : "s"}: about ${perWeek} separate 5-hour windows a week. `
      : `No history yet, so it assumes about ${perWeek} separate 5-hour windows a week. `) +
    `The week gets 7 of this month's ${days} days of the budget, and a 5-hour window up to 1.5 times its fair share so a long session is not cut short.`;
  return { fiveHour: tidy(fiveHourRaw), weekly: tidy(weekly), windowsPerWeek: perWeek, basedOnDays, note };
}

/** Analyze against the live history. */
export function analyzeCurrent(cfg: Pick<LimitsConfig, "unit" | "monthly" | "monthStartDay">, now = Date.now()): Analysis {
  return analyzeLimits(cfg, ledger, now);
}

// ── writing ──────────────────────────────────────────────────────────────────

/** Save new settings (merged over the current ones), and start using them at once. */
export async function saveLimits(patch: Partial<LimitsConfig>): Promise<LimitsConfig> {
  const next = sanitizeLimits({ ...(await readLimitsConfig()), ...patch });
  // The week's fixed reset is the moment limits with a weekly amount are first turned on.
  if (next.enabled && next.weekly > 0 && !next.weeklyResetAt) next.weeklyResetAt = Date.now();
  // Tracking with nothing to track is just "off", so the panel and the engine agree.
  if (next.monthly <= 0 && next.fiveHour <= 0 && next.weekly <= 0) next.enabled = false;
  await writeLimitsFile(next);
  const wasEnabled = config.enabled;
  config = next;
  if (next.enabled && (!wasEnabled || ledger.length === 0)) await adoptLedger(await loadLedger(Date.now()), Date.now());
  told.clear(); // new numbers: earlier heads-ups no longer describe them
  return next;
}

/** For tests: forget everything held in memory. */
export function resetUsageLimitsForTests(): void {
  config = { ...DEFAULT_LIMITS };
  ledger = [];
  loadedAt = 0;
  fiveSeed = null;
  told.clear();
}

/** For tests: put a history in place. */
export function setLedgerForTests(recs: Rec[], cfg: LimitsConfig): void {
  ledger = [...recs].sort((a, b) => a.at - b.at);
  config = cfg;
  loadedAt = Date.now();
  fiveSeed = latestWindow(ledger, FIVE_HOURS_MS, "tokens")?.start ?? null;
}
