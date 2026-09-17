/**
 * openrouter — the OpenRouter driver.
 *
 * Loaded ONLY when the user has selected an OpenRouter model; the cheap metadata other
 * code needs regardless lives in `manifest.ts`, and the catalogue in `catalog.ts`.
 *
 * No `sanitizeText`: structured `tool_calls`, no markup in the text channel.
 * No `webSearch`: OpenRouter's search is a separately billed server tool.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { openrouterManifest } from "./manifest.js";

export const openrouterDriver: Driver = { ...openrouterManifest, toolTurn, streamTurn };

export default openrouterDriver;
