/**
 * catalog.ts — the models pulled into the local Ollama server, as picker entries with facts.
 *
 * Separate from `client.ts` so the picker needs no wire code, and from `manifest.ts` because a
 * manifest must not touch the network. Asking a server on this machine takes milliseconds, so
 * the registry asks every time rather than caching (see `local` on the manifest).
 */
import type { ModelChoice, ModelFacts, ThinkLevel } from "../types.js";
import { baseUrl, RUNNING_ENV } from "./endpoint.js";
import { localWindow, PREFIX } from "./manifest.js";

/** How long to wait for the server before calling it not running. It is on this machine. */
const TIMEOUT_MS = 1500;

/** One entry of `GET /api/tags`. */
export interface TagEntry {
  name: string;
  size?: number;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

/** The part of `POST /api/show` this module reads. */
export interface ShowInfo {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

const STANDARD: ThinkLevel = { label: "Standard", description: "answer directly", thinking: false, effort: "low" };
const THINKING: ThinkLevel = { label: "Thinking", description: "think first, then answer", thinking: true, effort: "high" };

/**
 * Whether a model can serve an agent turn: it has to take tools. Ollama lists what each model
 * can do; an older Ollama that lists nothing is given the benefit of the doubt.
 */
export function isUsable(show: ShowInfo | null): boolean {
  const caps = show?.capabilities;
  return !caps || caps.includes("tools");
}

/** The context the model was trained on, from `model_info` ("<arch>.context_length"). */
export function trainedWindow(show: ShowInfo | null): number | undefined {
  const info = show?.model_info ?? {};
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith(".context_length") && typeof v === "number" && v > 0) return v;
  }
  return undefined;
}

function sizeLabel(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

export function toChoice(tag: TagEntry, show: ShowInfo | null): ModelChoice {
  const caps = show?.capabilities ?? [];
  const trained = trainedWindow(show);
  const facts: ModelFacts = {
    contextWindow: Math.min(trained ?? localWindow(), localWindow()),
    price: { cacheHit: 0, cacheMiss: 0, output: 0 },
    acceptsImages: caps.includes("vision"),
    thinkLevels: caps.includes("thinking") ? [STANDARD, THINKING] : [STANDARD],
  };
  const parts = ["on this machine", tag.details?.parameter_size, sizeLabel(tag.size)].filter(Boolean);
  return { id: PREFIX + tag.name, label: tag.name, description: parts.join(" · "), facts };
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(baseUrl() + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Ollama ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The pulled models that can run an agent turn. Also sets or clears the "running" variable,
 * which is what makes Ollama count as connected (see endpoint.ts): set only when there is at
 * least one model to use, since a server with nothing pulled cannot answer anything.
 * Throws when the server does not answer, so the registry keeps the list it had.
 */
export async function discoverModels(): Promise<ModelChoice[]> {
  let tags: TagEntry[];
  try {
    tags = (await getJson<{ models?: TagEntry[] }>("/api/tags")).models ?? [];
  } catch (err) {
    delete process.env[RUNNING_ENV];
    throw err;
  }
  const shown = await Promise.all(
    tags.map((t) =>
      getJson<ShowInfo>("/api/show", { method: "POST", body: JSON.stringify({ model: t.name }) }).catch(() => null),
    ),
  );
  const choices = tags.flatMap((t, i) => (isUsable(shown[i]!) ? [toChoice(t, shown[i]!)] : []));
  if (choices.length > 0) process.env[RUNNING_ENV] = "1";
  else delete process.env[RUNNING_ENV];
  return choices;
}
