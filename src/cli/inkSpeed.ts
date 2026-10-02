/**
 * inkSpeed.ts — install the faster Ink renderer before Ink is loaded.
 *
 * A load hook only sees modules loaded AFTER it is registered, and ES imports are all loaded
 * before any module runs. So the entry point (index.ts) registers this first and only then
 * imports the application with `await import()`. If registering fails for any reason the app
 * simply runs on the stock renderer.
 *
 * `module.registerHooks` runs the hook in the main thread, synchronously. The older
 * `module.register` runs it on a separate thread, and every module load then waits on a round
 * trip to that thread: about 700ms of startup, measured. `register` is only the fallback.
 */
import * as nodeModule from "node:module";
import { load, loadSync } from "./inkSpeedLoader.js";

type RegisterHooks = (hooks: { load: typeof loadSync }) => unknown;

export function registerInkSpeedups(): void {
  try {
    const registerHooks = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
    if (typeof registerHooks === "function") {
      registerHooks({ load: loadSync });
      return;
    }
    void load; // the fallback below loads the same file as a loader-thread module
    nodeModule.register("./inkSpeedLoader.js", import.meta.url);
  } catch {
    // Not available here: the stock renderer is fine.
  }
}
