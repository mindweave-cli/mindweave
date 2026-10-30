/**
 * endpoint.ts — the one address a person can point Mindweave at that is none of the providers it knows: any server that
 * speaks the OpenAI chat-completions wire. A hosting service (Together, Fireworks, DeepInfra, Hugging Face), a company's own
 * gateway, a vLLM or a LiteLLM on the network, a model server in the cloud.
 *
 * Everything here is a setting kept like a key (in the global `~/.mindweave/.env`, so the terminal and the app agree), and
 * is read on every request so a change counts at once.
 */
import { parseUrl } from "../endpoints.js";

/** The address, as far as `/chat/completions` and `/models`: `https://api.together.xyz/v1`. */
export const URL_ENV = "MINDWEAVE_CUSTOM_URL";
/** The key, when the server wants one. Several can be kept, as for any provider (see `providerKeys`). */
export const KEY_ENV = "MINDWEAVE_CUSTOM_API_KEY";
/** Model ids typed by hand, comma separated: for a server that has no model listing, or to name one it does not list. */
export const MODELS_ENV = "MINDWEAVE_CUSTOM_MODELS";
/** What the server's models hold, in tokens, when the server does not say. */
export const WINDOW_ENV = "MINDWEAVE_CUSTOM_WINDOW";
/** Set while the server answered with a model to use: this is what makes the provider count as connected. */
export const READY_ENV = "MINDWEAVE_CUSTOM_READY";

/** What a hosted model is assumed to hold when nothing says: a typical modern window, below most advertised ones. */
export const DEFAULT_WINDOW = 128_000;

/** The address in use, no trailing slash, or "" when none is set. */
export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env[URL_ENV]?.trim() ?? "").replace(/\/+$/, "");
}

/** The window asked for models that do not report one. */
export function assumedWindow(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[WINDOW_ENV]);
  return Number.isInteger(n) && n >= 2048 ? n : DEFAULT_WINDOW;
}

/** The model ids typed by hand, in order, without repeats. */
export function typedModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  for (const part of (env[MODELS_ENV] ?? "").split(/[,\n]/)) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * An address as a person types it: a full http(s) URL, with `/v1` or whatever path the server serves the wire under.
 * Returns it as it is kept, or null when it is not an address. A bare host is refused rather than guessed at: this address
 * can be anywhere, and a path a guess got wrong is a request that fails with no hint why.
 */
export function parseAddress(input: string): string | null {
  const raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  return parseUrl(raw);
}
