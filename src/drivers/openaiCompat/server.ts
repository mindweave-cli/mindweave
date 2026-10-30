/**
 * server.ts — what an OpenAI-compatible SERVER that is not a vendor has in common: LM Studio and llama.cpp running on this
 * machine, and a custom endpoint someone typed in.
 *
 * None of them has a lineup known when the driver is written, so each DISCOVERS its models from `GET /models`, and each
 * model carries its own facts (window, price, vision) the way Ollama's and OpenRouter's do. What they share is here: the
 * ids are namespaced (so a local `qwen3` can never be mistaken for the cloud model of the same name), nothing is billed
 * that this driver can know about, reasoning is left entirely to the server, and an answer from the server is a fact about
 * whether it is there at all.
 */
import type { ModelChoice, ModelConfig, ModelFacts, ModelId, ModelPrice, ThinkLevel } from "../types.js";

/** How long to wait on a server before calling it not there. Quick: a refused connection answers at once. */
export const SERVER_TIMEOUT_MS = 2500;

/** The most context Mindweave lets a transcript grow into on a server it cannot measure. */
export const SERVER_WINDOW_CAP = 200_000;

/** What a server is assumed to hold when it does not say: room for the agent's instructions and a real conversation. */
export const SERVER_WINDOW_DEFAULT = 32_768;

/** An agent's own instructions and tools take about this much, so a window below it cannot hold even one turn. */
export const SERVER_WINDOW_MIN = 16_384;

/** Nothing is billed that this driver can know about. */
export const FREE: ModelPrice = { cacheHit: 0, cacheMiss: 0, output: 0 };

/** One answer to the question every server is asked: which models do you have. */
export interface ServerModel {
  /** The id the server calls it, sent back on the wire as given. */
  id: string;
  /** A name worth reading, when the id is a path or a file name. */
  label?: string;
  /** Tokens it holds, when the server says. */
  window?: number;
  /** The server says it has this model loaded and ready (LM Studio). */
  loaded?: boolean;
  /** The server says what the model can do, when it does. */
  tools?: boolean;
  /** Tokens it was priced at, per million, when a gateway lists them. */
  price?: ModelPrice;
  /** A short note on where it runs or what size it is. */
  note?: string;
}

/** The one reasoning state every model is offered: the server decides, and nothing is requested. */
export const STANDARD: ThinkLevel = { label: "Standard", description: "the model decides how much to think", thinking: false, effort: "low" };

export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [STANDARD];
}

/** A discovered model as a picker entry, with the facts it carries. */
export function toChoice(prefix: string, m: ServerModel, where: string): ModelChoice {
  const window = Math.min(m.window ?? SERVER_WINDOW_DEFAULT, SERVER_WINDOW_CAP);
  const facts: ModelFacts = {
    contextWindow: window,
    price: m.price ?? FREE,
    // The shared wire layer does not render images into the request, so none is claimed.
    acceptsImages: false,
    thinkLevels: [STANDARD],
  };
  const parts = [where, m.note, window < SERVER_WINDOW_MIN ? `only ${window.toLocaleString("en-US")} tokens of context: too small for an agent` : ""].filter(Boolean);
  return { id: prefix + m.id, label: m.label ?? m.id, description: parts.join(" · "), facts };
}

/** `GET` a path under a server and read it as JSON. Throws on a refusal, an error status or no answer. */
export async function getJson<T>(url: string, key?: string, timeoutMs = SERVER_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** The ids in an OpenAI-style `{ data: [{ id }] }` listing, with the extra fields some servers add kept. */
export function listedModels(body: unknown): Record<string, unknown>[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.filter((m): m is Record<string, unknown> => !!m && typeof (m as { id?: unknown }).id === "string" && (m as { id: string }).id.length > 0);
}

/** The first positive whole number among a model entry's fields, for the names servers use for their window. */
export function windowFrom(entry: Record<string, unknown>, fields: string[]): number | undefined {
  for (const f of fields) {
    const v = entry[f];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return undefined;
}

/**
 * Keep a saved server model even before discovery has listed it, as Ollama's and OpenRouter's do: coercing a valid
 * choice onto something else would change it on every launch. Reasoning is never on, since nothing here can ask for it.
 */
export function normalizeServer(config: ModelConfig): ModelConfig {
  return { model: config.model, thinking: false, effort: "low" };
}

/** A namespaced id's own name on the wire. */
export function stripPrefix(prefix: string, model: ModelId): string {
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}
