/**
 * catalog.ts — the models in LM Studio's local server, as picker entries with facts.
 *
 * Separate from `client.ts` so the picker needs no wire code, and from `manifest.ts` because a manifest must not touch the
 * network. Asking a server on this machine takes milliseconds, so the registry asks every time (see `local` on the manifest).
 *
 * LM Studio has two listings. Its own `GET /api/v0/models` says what each model IS (chat, vision or embeddings), whether it
 * is loaded, and how much context it holds. The OpenAI-style `GET /v1/models` only lists ids. The first is preferred, and
 * the second is the fallback for a version that does not have it.
 */
import type { ModelChoice } from "../types.js";
import { SERVER_WINDOW_DEFAULT, getJson, listedModels, windowFrom, toChoice, type ServerModel } from "../openaiCompat/server.js";
import { PREFIX } from "./manifest.js";
import { RUNNING_ENV, TOKEN_ENV, baseUrl } from "./endpoint.js";

/** The kinds of model that cannot answer a chat message. */
const NOT_CHAT = new Set(["embeddings", "embedding", "rerank", "reranker"]);

/** One entry of `GET /api/v0/models`, with only the fields this reads. */
export interface NativeEntry {
  id: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
  capabilities?: string[];
  publisher?: string;
  quantization?: string;
}

/** Whether a listed model is one a chat can be sent to. */
export function isChat(entry: { id: string; type?: string }): boolean {
  if (entry.type && NOT_CHAT.has(entry.type.toLowerCase())) return false;
  // The plain listing has no type; an embedding model gives itself away by name.
  return !(entry.type === undefined && /embed/i.test(entry.id));
}

/** A native entry as a server model. A loaded model's own window is what a request gets; one not yet loaded gets the default. */
export function fromNative(entry: NativeEntry): ServerModel {
  const loaded = entry.state === "loaded";
  const trained = entry.max_context_length;
  const window = loaded && entry.loaded_context_length ? entry.loaded_context_length : trained ? Math.min(trained, SERVER_WINDOW_DEFAULT) : undefined;
  const note = [loaded ? "loaded" : "not loaded", entry.quantization].filter(Boolean).join(" · ");
  return {
    id: entry.id,
    window,
    loaded,
    tools: entry.capabilities ? entry.capabilities.includes("tool_use") : undefined,
    note,
  };
}

/** The chat models LM Studio lists. Throws when the server does not answer, so the registry keeps the list it had. */
export async function listChatModels(root: string, token?: string): Promise<ServerModel[]> {
  try {
    const native = await getJson<{ data?: NativeEntry[] }>(`${root}/api/v0/models`, token);
    const entries = (native.data ?? []).filter((e) => typeof e.id === "string" && isChat(e));
    return entries.map(fromNative);
  } catch (nativeError) {
    // An older LM Studio, or one that answers only on the OpenAI-style routes.
    try {
      const plain = await getJson<unknown>(`${root}/v1/models`, token);
      return listedModels(plain)
        .map((m) => ({ id: m.id as string, window: windowFrom(m, ["context_length", "max_context_length"]) }))
        .filter((m) => isChat(m));
    } catch {
      throw nativeError;
    }
  }
}

/**
 * The models that can serve a chat. Also sets or clears the "running" variable, which is what makes LM Studio count as
 * connected: set only when there is at least one model to use, since a server with nothing downloaded answers nothing.
 */
export async function discoverModels(): Promise<ModelChoice[]> {
  const root = baseUrl();
  let models: ServerModel[];
  try {
    models = await listChatModels(root, process.env[TOKEN_ENV]?.trim() || undefined);
  } catch (err) {
    delete process.env[RUNNING_ENV];
    throw err;
  }
  const choices = models.map((m) => toChoice(PREFIX, m, "on this machine"));
  if (choices.length > 0) process.env[RUNNING_ENV] = "1";
  else delete process.env[RUNNING_ENV];
  return choices;
}
