/**
 * analytics.ts — the optional daily count behind the Data page on the website.
 *
 * ON unless the person turns it off (`/data`), and said so at every start. When it is on, at most once a day, after the
 * first real piece of work that day, Mindweave sends one small message: a random id, the version, the system, the day, and for each model used on the
 * last two complete days how many tokens went in fresh, came from the cache, and went out, how many calls and sessions
 * there were, and what that cost at the provider's list price. Nothing else leaves: no prompt, no reply, no file, no path,
 * no project name, no key. `/data` shows the exact message before anything is sent, built by the same function that builds
 * the one that is sent, so the two cannot differ.
 *
 * ## What is not counted, whatever the setting says
 *
 * A count that includes tests, dev builds and scripts is worse than none: an earlier version of this counted every launch
 * with a random id, and every throwaway state folder looked like a new person. So nothing is sent from a state folder
 * that was moved (tests, scratch runs), from CI, from a source checkout or a dependency copy, or from a run with no
 * person at the keyboard. Only an install a person actually uses counts: the npm install, a copy the launcher started, or
 * the one bundled in the app.
 *
 * ## What a model name may reveal
 *
 * A model's name is sent only when it is one of the names built into Mindweave. Anything else (a model someone pulled
 * locally, a name behind a custom address) is sent as `other`, with the provider only, since such a name can identify a
 * company or a project.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoot } from "../memory/store.js";
import { callRecords, everyMeta, type CallRecord } from "../memory/allMetas.js";
import type { SessionMeta } from "../memory/types.js";
import { allProviders } from "../drivers/registry.js";
import { priceFor } from "../dynamo/pricing.js";
import { appVersion } from "./version.js";

/** Where the numbers are shown, for everyone. Said in /data and at every start, so the place the count goes is never a mystery. */
export const DATA_PAGE_URL = "https://mindweavedev.netlify.app/data";
/** The code that builds and sends the message, for anyone who wants to read exactly what it does. */
export const SOURCE_URL = "https://github.com/mindweave-cli/Mindweave/blob/main/src/cli/analytics.ts";
const DEFAULT_ENDPOINT = "https://mindweavedev.netlify.app/.netlify/functions/ingest";
const DAY_MS = 86_400_000;
/** Installs of these kinds are real ones. A checkout, a dependency copy and anything unplaced are not. */
const COUNTED_INSTALLS = new Set(["global", "managed", "app"]);
const FETCH_TIMEOUT_MS = 6_000;
/** After a failed attempt, wait this long before the next, so a down server is not asked after every turn. */
const RETRY_AFTER_MS = 30 * 60_000;
/** How far back the one-time share of past usage reaches. */
export const HISTORY_DAYS = 60;

function endpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINDWEAVE_ANALYTICS_URL?.trim() || DEFAULT_ENDPOINT;
}

// ── the setting ──────────────────────────────────────────────────────────────

interface Config {
  /** The person turned it off with /data. Absent means on, the default. The `enabled` field an older version wrote is ignored: that was a different count, and this one is on for everyone until they turn it off here. */
  disabled?: boolean;
  /** Made the first time something is about to be sent, never before. */
  id?: string;
  /** The last day (UTC) a count was sent. */
  sentDay?: string;
  /** The person turned the past off: the last HISTORY_DAYS days are not shared. Absent means they go, once, with the first count. */
  noHistory?: boolean;
  /** That past usage has been sent. */
  historySent?: boolean;
}

function configPath(root = stateRoot()): string {
  return join(root, "analytics.json");
}

function readConfig(root = stateRoot()): Config {
  try {
    const raw = JSON.parse(readFileSync(configPath(root), "utf8")) as Record<string, unknown>;
    const cfg: Config = {};
    if (raw.disabled === true) cfg.disabled = true;
    if (typeof raw.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(raw.id)) cfg.id = raw.id;
    if (typeof raw.sentDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.sentDay)) cfg.sentDay = raw.sentDay;
    if (raw.noHistory === true) cfg.noHistory = true;
    if (raw.historySent === true) cfg.historySent = true;
    return cfg;
  } catch {
    return {};
  }
}

function writeConfig(cfg: Config, root = stateRoot()): void {
  mkdirSync(root, { recursive: true });
  const tmp = `${configPath(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, configPath(root));
}

/**
 * Why nothing is sent from here, or null when this is a place a count may come from (pure on its inputs). Checked on every
 * send and shown in `/data`, so someone can see that their own setting is not the reason.
 */
export function blockedReason(env: NodeJS.ProcessEnv, installKind: string | undefined, root = stateRoot()): string | null {
  if (env.MINDWEAVE_NO_ANALYTICS) return "MINDWEAVE_NO_ANALYTICS is set";
  if (env.MINDWEAVE_STATE_DIR?.trim()) return "the state folder was moved, which only tests and scratch runs do";
  if (env.CI || env.GITHUB_ACTIONS) return "this is a CI run";
  if (env.NODE_ENV === "test") return "this is a test run";
  if (!installKind || !COUNTED_INSTALLS.has(installKind)) return "this is a source checkout or a dependency copy, not an install someone uses";
  void root;
  return null;
}

/** Is sharing on? It is, unless the person turned it off. (Not whether this place may send; see `blockedReason`.) */
export function analyticsEnabled(root = stateRoot()): boolean {
  return readConfig(root).disabled !== true;
}

/** Turn sharing on or off. Returns whether it is on afterwards. */
export function setAnalyticsEnabled(on: boolean, root = stateRoot(), _now?: number): boolean {
  void _now;
  const cfg = readConfig(root);
  if (on) delete cfg.disabled;
  else cfg.disabled = true;
  writeConfig(cfg, root);
  return cfg.disabled !== true;
}

/** Share the past (the last HISTORY_DAYS days) once, with the first count, or not. It is shared unless the person turns it off. */
export function setShareHistory(on: boolean, root = stateRoot()): void {
  const cfg = readConfig(root);
  if (on) delete cfg.noHistory;
  else cfg.noHistory = true;
  writeConfig(cfg, root);
}

/** Will the past go with the next count? Sharing is on, the person has not turned the past off, and it has not gone yet. */
export function historyPending(root = stateRoot()): boolean {
  const cfg = readConfig(root);
  return cfg.disabled !== true && cfg.noHistory !== true && cfg.historySent !== true;
}

/** Has the person turned the past off, so it can be offered again? (sharing is on, the past was turned off and never sent) */
export function canOfferHistory(root = stateRoot()): boolean {
  const cfg = readConfig(root);
  return cfg.disabled !== true && cfg.noHistory === true && cfg.historySent !== true;
}

/** A new random id, and no memory of what was sent under the old one. */
export function resetAnalyticsId(root = stateRoot()): void {
  const cfg = readConfig(root);
  delete cfg.id;
  delete cfg.sentDay;
  delete cfg.historySent;
  writeConfig(cfg, root);
}

/** Kept for the desktop app, which still calls it at start. It counts nothing: the app does not send a count yet. */
export function sendAnalyticsPing(_version?: string): void {
  void _version;
}

// ── what is sent ─────────────────────────────────────────────────────────────

export interface ModelUse {
  /** provider id */
  p: string;
  /** model id, or "other" */
  m: string;
  /** the model's name as Mindweave lists it (built-in models only) */
  l?: string;
  /** the provider's name as Mindweave lists it */
  pn?: string;
  /** fresh input tokens */
  i: number;
  /** input tokens served from the provider's cache */
  c: number;
  /** output tokens */
  o: number;
  /** calls */
  n: number;
  /** sessions that used it */
  s: number;
  /** cost at the provider's list price, USD */
  $: number;
  /** list price per million: fresh input, output, cached input */
  pr?: [number, number, number];
}

export interface Payload {
  v: 1;
  id: string;
  version: string;
  os: "win32" | "darwin" | "linux" | "other";
  day: string;
  usage?: { day: string; models: ModelUse[] }[];
  /** Days (before today) with real work. Sent once, with the past, so the history of daily users fills in. */
  active?: string[];
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The name that may be sent for a model, and its provider (pure given the registry). A model no provider here declares is
 * `other` for both: the registry would call an unknown name by its fallback provider, which would put a private model
 * under someone else's name.
 */
export function publicModel(model: string): { p: string; m: string; l?: string; pn?: string } {
  const owner = allProviders().find((m) => m.models.some((c) => c.id === model));
  if (!owner || !/^[a-z0-9._-]{1,32}$/.test(owner.id) || !/^[A-Za-z0-9._:/ +-]{1,64}$/.test(model)) return { p: "other", m: "other" };
  const label = owner.models.find((c) => c.id === model)?.label;
  return {
    p: owner.id,
    m: model,
    ...(label && SAFE_NAME.test(label) ? { l: label } : {}),
    ...(SAFE_NAME.test(owner.label) ? { pn: owner.label } : {}),
  };
}

/** Names Mindweave itself ships are plain words; anything else about them is not sent. */
const SAFE_NAME = /^[A-Za-z0-9._:/ +()'-]{1,64}$/;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** One day's use per model, from every session's call log. */
export function usageForDay(metas: readonly SessionMeta[], day: string): ModelUse[] {
  const by = new Map<string, { use: ModelUse; sessions: Set<string> }>();
  for (const meta of metas) {
    for (const call of callRecords(meta) as CallRecord[]) {
      if (utcDay(call.at) !== day) continue;
      const name = publicModel(call.model);
      const key = name.p + "\u0000" + name.m;
      let slot = by.get(key);
      if (!slot) {
        slot = { use: { p: name.p, m: name.m, ...(name.l ? { l: name.l } : {}), ...(name.pn ? { pn: name.pn } : {}), i: 0, c: 0, o: 0, n: 0, s: 0, $: 0 }, sessions: new Set() };
        by.set(key, slot);
      }
      const price = priceFor(call.model);
      slot.use.i += call.miss;
      slot.use.c += call.hit;
      slot.use.o += call.out;
      slot.use.n += 1;
      slot.use.$ += (call.hit * price.cacheHit + call.miss * price.cacheMiss + call.out * price.output) / 1e6;
      if (name.m !== "other") slot.use.pr = [round4(price.cacheMiss), round4(price.output), round4(price.cacheHit)];
      slot.sessions.add(meta.id);
    }
  }
  return [...by.values()].map(({ use, sessions }) => ({ ...use, s: sessions.size, $: round4(use.$) }));
}

function systemOf(platform: NodeJS.Platform): Payload["os"] {
  return platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "other";
}

/** The message, exactly as it would be sent now. The id is made here if there is none yet; `preview` leaves it unsaved. */
export function buildPayload(opts: {
  metas: readonly SessionMeta[];
  now?: number;
  version?: string;
  platform?: NodeJS.Platform;
  id: string;
  /** Include the last HISTORY_DAYS days, not only yesterday and the day before. */
  history?: boolean;
}): Payload {
  const now = opts.now ?? Date.now();
  const today = utcDay(now);
  const usage: { day: string; models: ModelUse[] }[] = [];
  const active: string[] = [];
  const reach = opts.history ? HISTORY_DAYS : 2;
  for (let back = 1; back <= reach; back++) {
    const day = utcDay(now - back * DAY_MS);
    const models = usageForDay(opts.metas, day);
    if (models.length > 0) usage.push({ day, models });
    if (opts.history && workedOn(opts.metas, day)) active.push(day);
  }
  return {
    v: 1,
    id: opts.id,
    version: opts.version ?? appVersion(),
    os: systemOf(opts.platform ?? process.platform),
    day: today,
    ...(usage.length > 0 ? { usage } : {}),
    ...(active.length > 0 ? { active } : {}),
  };
}

/** Did the person ask the agent for anything that day? Background work nobody asked for does not count as a day of use. */
function workedOn(metas: readonly SessionMeta[], day: string): boolean {
  return metas.some((meta) => (callRecords(meta) as CallRecord[]).some((c) => !c.aux && utcDay(c.at) === day));
}

/** The same message, built from sessions already read: no waiting on the disk, so a screen can show it without a gap. */
export function previewPayloadFrom(metas: readonly SessionMeta[], deps: { root?: string; now?: number } = {}): Payload {
  const root = deps.root ?? stateRoot();
  return buildPayload({ metas, ...(deps.now !== undefined ? { now: deps.now } : {}), id: readConfig(root).id ?? PLACEHOLDER_ID, history: historyPending(root) });
}

/** What the preview shows for an id that has not been made yet. */
export const PLACEHOLDER_ID = "(made when the first count is sent)";

/** The message `/data` shows: the real builder, with the id that would be used (a placeholder while none exists yet). */
export async function previewPayload(deps: { root?: string; now?: number; metas?: readonly SessionMeta[] } = {}): Promise<Payload> {
  const root = deps.root ?? stateRoot();
  const metas = deps.metas ?? (await everyMeta());
  return buildPayload({ metas, ...(deps.now !== undefined ? { now: deps.now } : {}), id: readConfig(root).id ?? PLACEHOLDER_ID, history: historyPending(root) });
}

// ── sending ──────────────────────────────────────────────────────────────────

export type SendOutcome = "sent" | "off" | "blocked" | "already-today" | "wait" | "failed";

export interface SendDeps {
  root?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  installKind?: string;
  fetchImpl?: typeof fetch;
  metas?: readonly SessionMeta[];
}

let lastFailure = 0;

/**
 * Send today's count if sharing is on, this is a place a count may come from, and none went out today. Never throws, and
 * never holds anything up: a server that is down costs one quiet failed request every half hour at most.
 */
export async function sendDailyCount(deps: SendDeps = {}): Promise<SendOutcome> {
  const root = deps.root ?? stateRoot();
  const now = deps.now ?? Date.now();
  try {
    const cfg = readConfig(root);
    if (cfg.disabled === true) return "off";
    if (blockedReason(deps.env ?? process.env, deps.installKind, root)) return "blocked";
    if (cfg.sentDay === utcDay(now)) return "already-today";
    if (now - lastFailure < RETRY_AFTER_MS) return "wait";

    const id = cfg.id ?? randomUUID();
    const withHistory = cfg.noHistory !== true && cfg.historySent !== true;
    const payload = buildPayload({ metas: deps.metas ?? (await everyMeta()), now, id, history: withHistory });
    const doFetch = deps.fetchImpl ?? fetch;
    const res = await doFetch(endpoint(deps.env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      lastFailure = now;
      return "failed";
    }
    writeConfig({ ...cfg, id, sentDay: utcDay(now), ...(withHistory ? { historySent: true } : {}) }, root);
    return "sent";
  } catch {
    lastFailure = now;
    return "failed";
  }
}

/** Called after a real turn finishes. Fire and forget. */
export async function reportActiveDay(): Promise<void> {
  try {
    const { currentInstall } = await import("./updateRunner.js");
    await sendDailyCount({ installKind: currentInstall().kind });
  } catch {
    // Nothing here may ever show.
  }
}

/** For tests: forget a recent failure. */
export function forgetFailure(): void {
  lastFailure = 0;
}

// ── what is said ─────────────────────────────────────────────────────────────

/**
 * The line shown every time Mindweave starts, or null where nothing is counted anyway (a checkout, a test). Said every
 * launch on purpose: whether something leaves the machine is not a thing to tell once and forget.
 */
export function analyticsLine(env: NodeJS.ProcessEnv, installKind: string | undefined, root = stateRoot()): string | null {
  if (blockedReason(env, installKind, root)) return null;
  if (!analyticsEnabled(root)) {
    return `Data is off. /data to turn it on: one small daily count of tokens by model, so everyone can see which models perform best. See it at ${DATA_PAGE_URL}`;
  }
  const past = historyPending(root);
  return [
    past
      ? `Data is on. It shares one small daily count of tokens by model, and your last ${HISTORY_DAYS} days of usage once, so everyone can see which models perform best and which gets the best cache hit rate.`
      : "Data is on. It shares one small daily count of tokens by model, so everyone can see which models perform best and which gets the best cache hit rate.",
    "We never see your chats, your files or what your project is. Only the counts.",
    `See the numbers: ${DATA_PAGE_URL}`,
    `See how it is sent: ${SOURCE_URL}`,
    past ? "Turn off the past data, or all of it, with /data." : "Turn it off any time with /data.",
  ].join("\n");
}

/** What `/data` says when asked what the count is. Short lines, because it is read in a terminal. */
export const ANALYTICS_EXPLANATION = [
  "A daily count, on by default. You can turn it off any time.",
  "",
  `Where the numbers are shown: ${DATA_PAGE_URL}`,
  `The code that sends them: ${SOURCE_URL}`,
  "The numbers are shown there for everyone, so we can count how many people use Mindweave and anyone can see which model is the best at the moment, how much of each request gets reused, and much more.",
  "",
  "Sent once a day:",
  "  a random id, the version, your system and the day",
  "  for each model: tokens in, from the cache and out, calls, sessions, and the cost at list price",
  `Sent once, with the first count: the same counts for your last ${HISTORY_DAYS} days. Turn that off, or everything, with /data.`,
  "Never sent: a prompt, a reply, a file, a path, a project name or a key.",
  "A model name is sent only if it is built into Mindweave. Any other is sent as \"other\".",
].join("\n");

/** For code that wants to know whether a config exists at all (a first launch). */
export function hasAnalyticsConfig(root = stateRoot()): boolean {
  return existsSync(configPath(root));
}
