/**
 * llamacpp — the llama.cpp driver.
 *
 * Loaded ONLY when the user has selected a llama.cpp model; the cheap metadata other code needs regardless lives in
 * `manifest.ts`, and the catalogue in `catalog.ts`.
 *
 * No `sanitizeText`: tool calls arrive as structured `tool_calls`. No `webSearch`: a local model has no search service.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { llamacppManifest } from "./manifest.js";

export const llamacppDriver: Driver = { ...llamacppManifest, toolTurn, streamTurn };

export default llamacppDriver;
