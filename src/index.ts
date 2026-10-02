#!/usr/bin/env node
/**
 * Mindweave — entry point.
 *
 * This file only prepares the process, then starts the real program in `main.ts`. The split is
 * not cosmetic: two things have to happen before React and Ink are LOADED, and ES imports are
 * all loaded before any code runs, so they cannot happen inside the program that imports them.
 *
 *   1. React picks its production or development build when it first loads, from NODE_ENV
 *      (see cli/prodEnv.ts). Nothing set it, so the app ran on the slow development build.
 *   2. The faster Ink renderer is installed by a loader hook, which only sees modules loaded
 *      after it is registered (see cli/inkSpeed.ts).
 *
 * Node's on-disk compile cache (`module.enableCompileCache`) is deliberately NOT used. Measured
 * here it made every launch slower, about 1.0s to a usable prompt against 0.82s without it, warm
 * cache included: reading and checking the cache cost more than recompiling saved.
 *
 * The shebang above + the `bin` entry in package.json make this the `mindweave` command.
 */
import { loadWithProductionEnv } from "./cli/prodEnv.js";
import { registerInkSpeedups } from "./cli/inkSpeed.js";

registerInkSpeedups();
await loadWithProductionEnv();
await import("./main.js");
