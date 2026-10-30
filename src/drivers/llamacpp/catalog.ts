/**
 * catalog.ts — the model a local llama-server is running, as a picker entry with its facts.
 *
 * `GET /v1/models` lists the model (a server runs one), and `GET /props` says how much context the server was started with,
 * which is what a request really gets: the model's trained maximum is not. Asking a server on this machine takes
 * milliseconds, so the registry asks every time (see `local` on the manifest).
 */
import type { ModelChoice } from "../types.js";
import { SERVER_WINDOW_DEFAULT, getJson, listedModels, toChoice, windowFrom, type ServerModel } from "../openaiCompat/server.js";
import { PREFIX } from "./manifest.js";
import { KEY_ENV, RUNNING_ENV, candidates, rememberFound } from "./endpoint.js";

/** The part of `GET /props` this reads. */
export interface Props {
  n_ctx?: number;
  default_generation_settings?: { n_ctx?: number };
  model_alias?: string;
}

/** A file path or a file name as something to read: `/models/Qwen3-8B-Q4_K_M.gguf` is `Qwen3-8B-Q4_K_M`. */
export function readableName(id: string): string {
  const last = id.split(/[\\/]/).filter(Boolean).pop() ?? id;
  return last.replace(/\.gguf$/i, "");
}

/** The context the server was started with, from `/props`. */
export function startedWindow(props: Props | null): number | undefined {
  const n = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
  return typeof n === "number" && n > 0 ? Math.floor(n) : undefined;
}

/** One listed entry as a server model, with the window the server really holds when it said so. */
export function fromListed(entry: Record<string, unknown>, props: Props | null): ServerModel {
  const id = entry.id as string;
  const meta = (entry.meta ?? {}) as Record<string, unknown>;
  const window = startedWindow(props) ?? windowFrom(meta, ["n_ctx", "n_ctx_train"]) ?? SERVER_WINDOW_DEFAULT;
  return { id, label: props?.model_alias || readableName(id), window };
}

/**
 * The model the server runs. Also sets or clears the "running" variable, which is what makes llama.cpp count as connected,
 * and remembers which address answered when none was set. Throws when no address answers, so the registry keeps the list it had.
 */
export async function discoverModels(): Promise<ModelChoice[]> {
  const key = process.env[KEY_ENV]?.trim() || undefined;
  let lastError: unknown = new Error("no llama-server address to ask");
  for (const root of candidates()) {
    try {
      const listed = listedModels(await getJson<unknown>(`${root}/v1/models`, key));
      const props = await getJson<Props>(`${root}/props`, key).catch(() => null);
      rememberFound(root);
      const choices = listed.map((m) => toChoice(PREFIX, fromListed(m, props), "on this machine"));
      if (choices.length > 0) process.env[RUNNING_ENV] = "1";
      else delete process.env[RUNNING_ENV];
      return choices;
    } catch (err) {
      lastError = err;
    }
  }
  delete process.env[RUNNING_ENV];
  throw lastError;
}
