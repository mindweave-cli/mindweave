/**
 * catalog.ts — OpenRouter's model catalogue, turned into picker entries with facts.
 *
 * Separate from `client.ts` because the picker needs the list without loading any wire
 * code, and separate from `manifest.ts` because a manifest must not touch the network.
 */
import type { ModelChoice, ModelFacts, ModelPrice, ThinkLevel } from "../types.js";
import { BASE_URL, OPENROUTER_HEADERS } from "./endpoint.js";
import { PREFIX, USABLE_WINDOW_CAP } from "./manifest.js";

/** The slice of one catalogue entry this module reads. */
export interface CatalogEntry {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, unknown> & { overrides?: unknown[] };
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  supported_parameters?: string[];
  expiration_date?: string | null;
  reasoning?: { mandatory?: boolean; supported_efforts?: string[] } | null;
}

/**
 * Whether a model can serve an agent turn here at all.
 *
 * Everything that works is listed; a model is left out only when it would fail on
 * first use or cannot be priced:
 *   - no text output, or no `tools` — an agent turn needs both;
 *   - `:batch` entries, which only answer through the Batch API;
 *   - OpenRouter's own routers (`openrouter/…`, price `-1`), whose model, price and
 *     window are unknown until after the call;
 *   - `~` aliases, which point at whatever is newest, so a saved choice would silently
 *     change model, price and behaviour.
 */
export function isUsable(entry: CatalogEntry): boolean {
  if (!entry.id || entry.id.startsWith("~") || entry.id.startsWith("openrouter/")) return false;
  if (entry.id.endsWith(":batch")) return false;
  if (!(entry.architecture?.output_modalities ?? []).includes("text")) return false;
  if (!(entry.supported_parameters ?? []).includes("tools")) return false;
  const prompt = Number(entry.pricing?.prompt);
  return Number.isFinite(prompt) && prompt >= 0;
}

const EFFORT_LEVELS: ThinkLevel[] = [
  { label: "Low", description: "reasoning effort: low", thinking: true, effort: "low" },
  { label: "Medium", description: "reasoning effort: medium", thinking: true, effort: "medium" },
  { label: "High", description: "reasoning effort: high", thinking: true, effort: "high" },
  { label: "Extra high", description: "reasoning effort: extra high", thinking: true, effort: "xhigh" },
  { label: "Maximum", description: "reasoning effort: maximum", thinking: true, effort: "max" },
];

const STANDARD: ThinkLevel = { label: "Standard", description: "answer directly — fastest", thinking: false, effort: "low" };

/**
 * The `/think` ladder the catalogue says this model accepts.
 *
 * No reasoning object: one row, nothing to choose. A reasoning model whose thinking is
 * `mandatory` gets no Standard row, because OpenRouter rejects turning it off. Effort
 * rungs are the ones it lists that Mindweave also has (`minimal` has no equivalent). A
 * model that only toggles reasoning, with no efforts, gets a single Thinking row.
 */
export function levelsFor(entry: CatalogEntry): ThinkLevel[] {
  const r = entry.reasoning;
  if (!r) return [{ ...STANDARD, description: "this model has no reasoning dial" }];
  const offered = new Set(r.supported_efforts ?? []);
  const rungs = EFFORT_LEVELS.filter((l) => offered.has(l.effort));
  const on = rungs.length > 0 ? rungs : [{ label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" as const }];
  return r.mandatory ? on : [STANDARD, ...on];
}

/** Per-token price strings to USD per million. */
function perMillion(value: unknown): number | undefined {
  const n = Number(value);
  return typeof value === "string" && value !== "" && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
}

export function priceFor(entry: CatalogEntry): ModelPrice | undefined {
  const p = entry.pricing ?? {};
  const miss = perMillion(p.prompt);
  const output = perMillion(p.completion);
  if (miss === undefined || output === undefined) return undefined;
  const hit = perMillion(p.input_cache_read);
  const write = perMillion(p.input_cache_write);
  return { cacheMiss: miss, output, cacheHit: hit ?? miss, ...(write !== undefined ? { cacheWrite: write } : {}) };
}

/** "Anthropic: Claude Fable 5.1" → vendor "Anthropic", label "Claude Fable 5.1". */
function splitName(entry: CatalogEntry): { vendor: string; label: string } {
  const name = entry.name?.trim() || entry.id;
  const colon = name.indexOf(": ");
  if (colon > 0) return { vendor: name.slice(0, colon), label: name.slice(colon + 2) };
  return { vendor: entry.id.split("/")[0] ?? "", label: name };
}

function money(n: number): string {
  if (n === 0) return "0";
  return n >= 1 ? n.toFixed(2).replace(/\.00$/, "") : n.toPrecision(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function toChoice(entry: CatalogEntry): ModelChoice {
  const { vendor, label } = splitName(entry);
  const price = priceFor(entry);
  // `:free` variants share a tight daily request limit. A model can also simply cost
  // nothing without the suffix (a stealth preview), and "$0 in / $0 out" reads as a
  // missing price rather than a free one.
  const limited = entry.id.endsWith(":free");
  const free = limited || (price !== undefined && price.cacheMiss === 0 && price.output === 0);
  const advertised = entry.top_provider?.context_length || entry.context_length || 0;
  const facts: ModelFacts = {
    thinkLevels: levelsFor(entry),
    acceptsImages: (entry.architecture?.input_modalities ?? []).includes("image"),
    ...(price ? { price } : {}),
    ...(advertised > 0 ? { contextWindow: Math.min(advertised, USABLE_WINDOW_CAP) } : {}),
  };
  const parts = [vendor];
  if (free) parts.push(limited ? "free, rate-limited" : "free");
  else if (price) parts.push(`$${money(price.cacheMiss)} in / $${money(price.output)} out per M`);
  // Some hosts bill more at peak hours. The listed price is the base one, and saying so
  // is better than a cost figure that quietly reads low half the day.
  if (Array.isArray(entry.pricing?.overrides) && entry.pricing!.overrides.length > 0) parts.push("peak hours cost more");
  const until = entry.expiration_date ? Date.parse(entry.expiration_date) : NaN;
  return {
    id: PREFIX + entry.id,
    label,
    description: parts.filter(Boolean).join(" · "),
    facts,
    ...(Number.isFinite(until) ? { until } : {}),
  };
}

export function toChoices(entries: CatalogEntry[]): ModelChoice[] {
  return entries.filter(isUsable).map(toChoice);
}

/**
 * Fetch the catalogue. It is public, but asked for only with a key: without one the
 * provider cannot be used, and every launch would otherwise download it for nothing.
 * Throws on any failure, so the registry keeps the list it had.
 */
export async function discoverModels(): Promise<ModelChoice[]> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("No OPENROUTER_API_KEY");
  const response = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_HEADERS },
  });
  if (!response.ok) throw new Error(`OpenRouter catalogue: HTTP ${response.status}`);
  const body = (await response.json()) as { data?: CatalogEntry[] };
  const choices = toChoices(body.data ?? []);
  if (choices.length === 0) throw new Error("OpenRouter catalogue listed no usable models");
  return choices;
}
