/**
 * catalog.ts — the models a custom endpoint lists, as picker entries with the facts the server gave.
 *
 * `GET /models` is part of the wire this driver speaks. Servers answer it with different amounts of detail: some add the
 * window (`context_length`, `max_model_len`, …) and a price, most add neither. What a server says is used, and what it does
 * not say is left at the assumed window and no price, and the entry says so.
 *
 * A server that does not answer `/models` at all is still usable: the ids typed by hand are offered, and the provider
 * counts as connected as long as there is an address and at least one model.
 */
import type { ModelChoice, ModelPrice } from "../types.js";
import { getJson, listedModels, toChoice, windowFrom, type ServerModel } from "../openaiCompat/server.js";
import { PREFIX } from "./manifest.js";
import { KEY_ENV, READY_ENV, assumedWindow, baseUrl, typedModels } from "./endpoint.js";

/** The names servers use for what a model holds. */
const WINDOW_FIELDS = ["context_length", "context_window", "max_model_len", "max_context_length", "max_input_tokens"];

/** A number a gateway reports a price as: `0.0000003` per token, `"0.30"` per million, or nothing. */
function amount(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The price a listing states, per million tokens. Two shapes are in use: a router's `pricing: { prompt, completion }`, a
 * price PER TOKEN as text, and a host's `pricing: { input, output }`, a price per million as a number. Anything else is not
 * guessed at.
 */
export function priceFrom(entry: Record<string, unknown>): ModelPrice | undefined {
  const p = entry.pricing as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return undefined;
  const perToken = { input: amount(p.prompt), output: amount(p.completion), read: amount(p.input_cache_read) };
  if (perToken.input !== undefined && perToken.output !== undefined) {
    return { cacheMiss: perToken.input * 1e6, output: perToken.output * 1e6, cacheHit: (perToken.read ?? perToken.input) * 1e6 };
  }
  const perMillion = { input: amount(p.input), output: amount(p.output), read: amount(p.cached_input ?? p.input_cached) };
  if (perMillion.input !== undefined && perMillion.output !== undefined) {
    return { cacheMiss: perMillion.input, output: perMillion.output, cacheHit: perMillion.read ?? perMillion.input };
  }
  return undefined;
}

/** One listed entry as a server model. */
export function fromListed(entry: Record<string, unknown>): ServerModel {
  const price = priceFrom(entry);
  return {
    id: entry.id as string,
    window: windowFrom(entry, WINDOW_FIELDS) ?? assumedWindow(),
    price,
    note: price ? undefined : "price not tracked",
  };
}

/**
 * The models the server lists plus those typed by hand. Also sets or clears the "ready" variable, which is what makes the
 * provider count as connected. Throws when there is no address, or when the server cannot be asked and nothing was typed, so
 * the registry keeps the list it had.
 */
export async function discoverModels(): Promise<ModelChoice[]> {
  const root = baseUrl();
  if (!root) {
    delete process.env[READY_ENV];
    throw new Error("No address is set for the custom endpoint.");
  }
  const typed = new Set(typedModels());
  let listed: ServerModel[] = [];
  let failure: unknown;
  try {
    listed = listedModels(await getJson<unknown>(`${root}/models`, process.env[KEY_ENV]?.trim() || undefined, 8000))
      .filter((m) => !typed.has(m.id as string))
      .map(fromListed);
  } catch (err) {
    failure = err;
  }
  // What was typed is offered by the manifest itself (see `extraModels`), so only the server's own are returned here.
  if (listed.length === 0 && typed.size === 0) {
    delete process.env[READY_ENV];
    throw failure ?? new Error("The server lists no models. Type a model id to use.");
  }
  process.env[READY_ENV] = "1";
  return listed.map((m) => toChoice(PREFIX, m, "custom endpoint"));
}
