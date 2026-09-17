/**
 * clientId.ts — the identifying string Mindweave sends with every provider
 * request.
 *
 * Every provider logs the `User-Agent` (or equivalent) header on inbound
 * requests for its own analytics, rate-limit tiers, and abuse review, so a client
 * that names itself reads as an application rather than a bare SDK call. This is that string, sent
 * consistently from every driver so Mindweave's traffic reads as Mindweave's
 * traffic wherever a provider looks.
 *
 * Deliberately self-contained rather than importing `cli/version.ts` — a driver
 * may import nothing from outside `drivers/` except `types.js` (see the header of
 * that file), and this constant is exactly the kind of core-adjacent thing that
 * boundary exists to keep out. So the same safe, degrade-to-nothing read is
 * duplicated here in miniature rather than the boundary being bent for it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cached: string | null = null;

/** `mindweave/1.9.9 (mwcode)`, or `mindweave (mwcode)` if the version can't be
 *  read — never throws, never blocks a request on a missing package.json. */
export function clientId(): string {
  if (cached !== null) return cached;
  let version = "";
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // No package.json (or it's malformed) — identify without a version rather
    // than fail a request over it.
  }
  cached = version ? `mindweave/${version} (mwcode)` : "mindweave (mwcode)";
  return cached;
}
