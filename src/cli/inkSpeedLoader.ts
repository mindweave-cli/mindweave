/**
 * inkSpeedLoader.ts — the module load hook that swaps in the faster Ink renderer text.
 *
 * It touches exactly two files, `ink/build/output.js` and `widest-line/index.js`, and each only
 * when its content is the stock one this was written against (see inkOutputPatch.ts and
 * widestLinePatch.ts); everything else passes through untouched.
 *
 * Two shapes of the same hook. `loadSync` is the one used: it runs in the main thread through
 * `module.registerHooks`. `load` is the asynchronous form for `module.register`, kept only as a
 * fallback, because `register` runs hooks on a separate thread and every module the app loads then
 * waits on a round trip to it. Measured on startup, that cost about 700ms, more than half of the
 * time to a usable prompt, for a hook that changes two files.
 */
import { patchInkOutput } from "./inkOutputPatch.js";
import { patchWidestLine } from "./widestLinePatch.js";

type Source = string | ArrayBuffer | ArrayBufferView | null | undefined;
type LoadResult = { format?: string | null; source?: Source; shortCircuit?: boolean };

/** The patch for this module, or null when it is not one of the two this changes. */
function patchFor(url: string): ((text: string) => string | null) | null {
  if (/\/node_modules\/ink\/build\/output\.js$/.test(url)) return patchInkOutput;
  if (/\/node_modules\/widest-line\/index\.js$/.test(url)) return patchWidestLine;
  return null;
}

function asText(source: Source): string {
  if (typeof source === "string") return source;
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString("utf8");
  return Buffer.from(source as ArrayBuffer).toString("utf8");
}

function apply(url: string, result: LoadResult): LoadResult {
  const patch = patchFor(url);
  if (!patch || result.source == null) return result;
  const patched = patch(asText(result.source));
  return patched ? { ...result, source: patched } : result;
}

/** For `module.registerHooks`: synchronous, in the main thread. */
export function loadSync(url: string, context: unknown, nextLoad: (url: string, context: unknown) => LoadResult): LoadResult {
  const result = nextLoad(url, context);
  return patchFor(url) ? apply(url, result) : result;
}

/** For `module.register`: the asynchronous fallback, run on the loader thread. */
export async function load(url: string, context: unknown, nextLoad: (url: string, context: unknown) => Promise<LoadResult>): Promise<LoadResult> {
  return apply(url, await nextLoad(url, context));
}
