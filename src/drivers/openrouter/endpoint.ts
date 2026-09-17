/**
 * endpoint.ts — where OpenRouter lives and how Mindweave introduces itself to it.
 *
 * Its own module so the catalogue and the client share it without the catalogue
 * loading any wire code.
 */

export const BASE_URL = (process.env.MINDWEAVE_OPENROUTER_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");

/**
 * App attribution. OpenRouter credits requests to an app by `HTTP-Referer` plus a title,
 * which is what lists it on openrouter.ai's app rankings; the `User-Agent` every driver
 * already sends is not read for that. `X-Title` is the older spelling of the title and
 * still accepted, so both go out.
 */
export const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/mindweave-cli/mindweave",
  "X-OpenRouter-Title": "mwcode",
  "X-Title": "mwcode",
  "X-OpenRouter-Categories": "cli-agent",
};
