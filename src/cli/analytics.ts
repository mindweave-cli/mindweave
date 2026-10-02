/**
 * analytics.ts — the anonymous usage count, PAUSED while a better one is built.
 *
 * Nothing is sent, for anyone, whatever an older install saved in its settings file. The
 * on/off switch is kept so the commands and screens that mention it keep working, but it
 * cannot be turned on: `setAnalyticsEnabled(true)` is refused and says why.
 *
 * It used to send `{ id, version }`, a random uuid made once per machine plus the version
 * number, to a plain HTTP endpoint. To bring it back, flip `ANALYTICS_PAUSED` and change
 * what is sent in one place; the callers do not need to change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoot } from "../memory/store.js";

/**
 * Where pings land. Swap this one line (or set MINDWEAVE_ANALYTICS_URL) once the site
 * has a real domain — nothing else here needs to change.
 */
const DEFAULT_ENDPOINT = "https://mindweavedev.netlify.app/.netlify/functions/ping";

/** The counting is switched off for everyone until the replacement exists. */
export const ANALYTICS_PAUSED = true;

/** What to tell someone who tries to turn it on while it is paused. */
export const ANALYTICS_PAUSED_MESSAGE =
  "Analytics is off and cannot be turned on for now. We are building a better way to count " +
  "how many people use Mindweave, and nothing is sent in the meantime.";

function endpoint(): string {
  return process.env.MINDWEAVE_ANALYTICS_URL?.trim() || DEFAULT_ENDPOINT;
}

interface AnalyticsConfig {
  enabled: boolean;
  id: string;
}

function configPath(): string {
  return join(stateRoot(), "analytics.json");
}

function readConfig(): AnalyticsConfig | null {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    if (typeof raw?.id === "string" && typeof raw?.enabled === "boolean") {
      return { enabled: raw.enabled, id: raw.id };
    }
    return null;
  } catch {
    return null;
  }
}

function writeConfig(cfg: AnalyticsConfig): void {
  if (!existsSync(stateRoot())) mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

let cached: AnalyticsConfig | null = null;

function config(): AnalyticsConfig {
  if (cached) return cached;
  cached = readConfig() ?? { enabled: true, id: randomUUID() };
  if (!readConfig()) writeConfig(cached);
  return cached;
}

export function analyticsEnabled(): boolean {
  return !ANALYTICS_PAUSED && config().enabled;
}

/**
 * Switch the count on or off. Returns whether it is on afterwards, which while paused is
 * always false: a request to turn it on is ignored and the saved setting is left alone.
 */
export function setAnalyticsEnabled(on: boolean): boolean {
  if (ANALYTICS_PAUSED) return false;
  const cfg = config();
  cfg.enabled = on;
  writeConfig(cfg);
  return cfg.enabled;
}

/**
 * What /analytics prints: why usage counting is off for now. Nothing is sent, and there is no
 * switch to flip while it is paused.
 */
export const ANALYTICS_EXPLANATION =
  "Usage counting is off for now, and nothing is sent. We are building a better way to count " +
  "how many people use Mindweave. When it is ready it will stay off until you turn it on.";

/** Fire-and-forget. Never throws, never delays startup. */
export function sendAnalyticsPing(version: string): void {
  if (ANALYTICS_PAUSED) return;
  const cfg = config();
  if (!cfg.enabled) return;
  void fetch(endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: cfg.id, version }),
  }).catch(() => {});
}
