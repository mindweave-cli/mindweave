/**
 * endpoint.ts — where a local llama.cpp server (`llama-server`) is.
 *
 * Its own module so the catalogue (which only lists models) and the client (which talks to one) agree on the address without
 * the catalogue loading any wire code. llama-server has no one fixed port: 8080 is the long-standing default and some builds
 * use another, so when no address was set, the likely ones are tried in turn and the one that answered is remembered for the
 * requests that follow. `MINDWEAVE_LLAMACPP_URL` names a server directly (another machine, or any port), and is what the
 * app's address field saves.
 */
import { parseUrl } from "../endpoints.js";

/** Tried in order when no address is set. */
export const DEFAULT_URLS = ["http://127.0.0.1:8080", "http://127.0.0.1:9931"];

/** The environment variable that holds an address set by hand or in the app. */
export const URL_ENV = "MINDWEAVE_LLAMACPP_URL";

/** The address discovery found answering, when none was set. Kept for the requests that follow. */
let found: string | null = null;

export function rememberFound(url: string | null): void {
  found = url;
}

/** The address set by hand or in the app, no trailing slash, or "" when none is set. */
export function ownUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env[URL_ENV]?.trim() ?? "").replace(/\/+$/, "");
}

/** The addresses to ask, first to last. An address that was set is the only one: it is never second-guessed. */
export function candidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = ownUrl(env);
  return own ? [own] : DEFAULT_URLS;
}

/** The server's root address, no trailing slash. Read on each call, so a changed variable counts at once. */
export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return ownUrl(env) || found || DEFAULT_URLS[0]!;
}

/**
 * An address as a person types it into the app: `host`, `host:port` or a full http(s) URL. A bare host gets port 8080.
 * Returns the root address as `baseUrl` holds it, or null when it is not an address.
 */
export function parseAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = parseUrl(withScheme);
  if (!parsed) return null;
  try {
    const url = new URL(parsed);
    if (!url.port && url.protocol === "http:" && !/:\d+(\/|$)/.test(raw)) url.port = "8080";
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The variable that says a server answered with a model. Same idea as the other local providers: see `lmstudio/endpoint.ts`. */
export const RUNNING_ENV = "MINDWEAVE_LLAMACPP_RUNNING";

/** llama-server's own name for the key it was started with (`--api-key`), when it requires one. */
export const KEY_ENV = "LLAMA_API_KEY";
