/**
 * endpoint.ts — where the local Ollama server is.
 *
 * Its own module so the catalogue (which only lists models) and the client (which talks to one)
 * agree on the address without the catalogue loading any wire code.
 *
 * Ollama's own variable, `OLLAMA_HOST`, is honoured the way Ollama reads it: a bare `host:port`
 * or a full URL, and `0.0.0.0` (which a server binds to, but nobody can connect to) means this
 * machine. `MINDWEAVE_OLLAMA_URL` overrides both, for a server somewhere else.
 */

export const DEFAULT_URL = "http://127.0.0.1:11434";

/** The server's root URL, no trailing slash. Read on each call, so a changed variable counts. */
export function baseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const own = env.MINDWEAVE_OLLAMA_URL?.trim();
  if (own) return own.replace(/\/+$/, "");
  const host = env.OLLAMA_HOST?.trim();
  if (!host) return DEFAULT_URL;
  const withScheme = /^[a-z]+:\/\//i.test(host) ? host : `http://${host}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname === "0.0.0.0" || url.hostname === "::" || url.hostname === "[::]") url.hostname = "127.0.0.1";
    if (!url.port && url.protocol === "http:" && !/:\d+$/.test(host)) url.port = "11434";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_URL;
  }
}

/**
 * The variable that says the server answered with at least one usable model.
 *
 * Every provider is "connected" when its key variable is set, and every part of Mindweave that
 * decides what can run (first-run setup, the fallback to another provider, the app's composer)
 * reads that one fact. A local server has no key, so discovery sets this variable when the
 * server is up and clears it when it is not: the same fact, with no second code path.
 */
export const RUNNING_ENV = "MINDWEAVE_OLLAMA_RUNNING";
