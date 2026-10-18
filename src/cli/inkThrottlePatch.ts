/**
 * inkThrottlePatch.ts — load Ink's `throttle` from the one file that holds it.
 *
 * Ink imports a single function, `throttle`, from `es-toolkit/compat`. That entry point is an
 * index which loads the whole compatibility layer behind it: hundreds of small files, opened and
 * checked one by one before the first screen. On Windows each file costs real time (more on a cold
 * disk or under a virus scanner), and this one import was close to half of all the files read at
 * startup and about 0.3s of a 0.9s launch.
 *
 * `es-toolkit/compat/function/throttle.mjs` is the very module the index re-exports, so the
 * function is the same one, not a lookalike. The package does not export that path, so the hook
 * points Ink at it by file address.
 *
 * Same mechanism as inkOutputPatch.ts: the loader hook rewrites the module text, and
 * `MINDWEAVE_NO_INK_PATCH=1` turns it off. Unlike that one it keys on the exact stock import line
 * instead of a whole-file hash, so an Ink update that keeps the line keeps the speedup; one that
 * changes it simply loads the stock import. If the target file is not where it is expected, the
 * stock import is kept too.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The line this replaces, exactly as Ink writes it. */
export const STOCK_THROTTLE_IMPORT = "import { throttle } from 'es-toolkit/compat';";

/** Where the throttle module sits, relative to `ink/build/ink.js`: hoisted beside Ink, or nested under it. */
export const THROTTLE_LOCATIONS: readonly string[] = [
  "../../es-toolkit/dist/compat/function/throttle.mjs",
  "../node_modules/es-toolkit/dist/compat/function/throttle.mjs",
];

/** The patched text for Ink's `ink.js` at `url`, or null when it is not the stock import (or patching is off). */
export function patchInkThrottle(source: string, url: string): string | null {
  if (process.env["MINDWEAVE_NO_INK_PATCH"] === "1") return null;
  if (!source.includes(STOCK_THROTTLE_IMPORT)) return null;
  for (const location of THROTTLE_LOCATIONS) {
    const target = new URL(location, url);
    if (target.protocol === "file:" && existsSync(fileURLToPath(target))) {
      return source.replace(STOCK_THROTTLE_IMPORT, `import { throttle } from '${target.href}';`);
    }
  }
  return null;
}
