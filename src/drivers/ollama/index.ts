/**
 * ollama — the Ollama driver: models running on this machine.
 *
 * Loaded ONLY when the user has selected an Ollama model; the cheap metadata other code needs
 * regardless lives in `manifest.ts`, and the model list in `catalog.ts`.
 *
 * No `sanitizeText`: structured `tool_calls`, no markup in the text channel.
 * No `webSearch`: a local model has no search of its own.
 */
import type { Driver } from "../types.js";
import { streamTurn, toolTurn } from "./client.js";
import { ollamaManifest } from "./manifest.js";

export const ollamaDriver: Driver = { ...ollamaManifest, toolTurn, streamTurn };

export default ollamaDriver;
