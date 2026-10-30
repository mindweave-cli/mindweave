/**
 * lmstudio — the LM Studio driver.
 *
 * Loaded ONLY when the user has selected an LM Studio model; the cheap metadata other code needs regardless lives in
 * `manifest.ts`, and the catalogue in `catalog.ts`.
 *
 * No `sanitizeText`: tool calls arrive as structured `tool_calls`. No `webSearch`: a local model has no search service.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { lmstudioManifest } from "./manifest.js";

export const lmstudioDriver: Driver = { ...lmstudioManifest, toolTurn, streamTurn };

export default lmstudioDriver;
