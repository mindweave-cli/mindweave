/**
 * endpoint.ts — where LM Studio's local server is.
 *
 * Its own module so the catalogue (which only lists models) and the client (which talks to one) agree on the address
 * without the catalogue loading any wire code. LM Studio serves on port 1234 by default; `MINDWEAVE_LMSTUDIO_URL` points
 * at a server somewhere else (another machine on the network), and is what the app's address field saves.
 */
import { parseUrl } from "../endpoints.js";

export const DEFAULT_URL = "http://127.0.0.1:1234";

/** The environment variable that holds an address set by hand or in the app. */
export const URL_ENV = "MINDWEAVE_LMSTUDIO_URL";

/** The server's root address, no trailing slash. Read on each call, so a changed variable counts at once. */
export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const own = env[URL_ENV]?.trim();
  return (own || DEFAULT_URL).replace(/\/+$/, "");
}

/**
 * An address as a person types it into the app: `host`, `host:port` or a full http(s) URL. LM Studio's port is added to a
 * bare host. Returns the root address as `baseUrl` holds it, or null when it is not an address.
 */
export function parseAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = parseUrl(withScheme);
  if (!parsed) return null;
  try {
    const url = new URL(parsed);
    if (!url.port && url.protocol === "http:" && !/:\d+(\/|$)/.test(raw)) url.port = "1234";
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * The variable that says the server answered with at least one model that can chat.
 *
 * Every provider is "connected" when its key variable is set, and every part of Mindweave that decides what can run
 * reads that one fact. A local server has no key, so discovery sets this variable while the server answers and clears it
 * when it does not: the same fact, with no second code path.
 */
export const RUNNING_ENV = "MINDWEAVE_LMSTUDIO_RUNNING";

/** LM Studio's own name for an access token, when the server was started with one required. */
export const TOKEN_ENV = "LM_API_TOKEN";
