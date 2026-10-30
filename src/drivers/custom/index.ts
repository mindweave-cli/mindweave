/**
 * custom — the custom-endpoint driver.
 *
 * Loaded ONLY when the user has selected a model from it; the cheap metadata other code needs regardless lives in
 * `manifest.ts`, and the catalogue in `catalog.ts`.
 *
 * No `sanitizeText`: tool calls arrive as structured `tool_calls`. No `webSearch`: what a given server offers is unknown.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { customManifest } from "./manifest.js";

export const customDriver: Driver = { ...customManifest, toolTurn, streamTurn };

export default customDriver;
