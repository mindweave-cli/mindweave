/**
 * manifest.ts — models running on this machine through Ollama.
 *
 * LOCAL: no key, no account, nothing leaves the machine, and nothing is billed. The lineup is
 * whatever the user has pulled (`ollama pull <model>`), so it is discovered (see `catalog.ts`),
 * and each model's facts (window, vision, thinking) come from Ollama itself on each
 * `ModelChoice`. The functions below are the fallbacks for a model not described yet.
 *
 * Ids are NAMESPACED: Mindweave stores `ollama:qwen3:8b`, and the client strips the prefix on
 * the wire, so a local model can never be mistaken for a cloud model of the same name.
 */
import type { DriverManifest, ModelConfig, ModelId, ModelPrice, ThinkLevel } from "../types.js";
import { RUNNING_ENV } from "./endpoint.js";

/** The namespace every Ollama model id carries inside Mindweave. */
export const PREFIX = "ollama:";

/** Ollama's own name for a namespaced id. */
export function wireId(model: ModelId): string {
  return model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model;
}

/**
 * The context each request asks Ollama for, in tokens.
 *
 * Ollama loads a model with a small window by default (a few thousand tokens) and silently
 * drops whatever does not fit, which an agent's instructions and tools alone can exceed. So
 * every request states its window. 32K by default: room for the agent's instructions and a real
 * conversation. It costs memory (the model's cache for 32K tokens can be several GB), so
 * `MINDWEAVE_OLLAMA_CONTEXT` sets another size for a smaller machine. A model trained on less
 * keeps its own figure (see `catalog.ts`).
 */
export const LOCAL_WINDOW = 32_768;

/** The window asked for: `MINDWEAVE_OLLAMA_CONTEXT` when set to a sensible number, else 32K. */
export function localWindow(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MINDWEAVE_OLLAMA_CONTEXT);
  return Number.isInteger(n) && n >= 2048 ? n : LOCAL_WINDOW;
}

/** Nothing is billed: the model runs here. */
const FREE: ModelPrice = { cacheHit: 0, cacheMiss: 0, output: 0 };

export function price(_model: ModelId): ModelPrice {
  return FREE;
}

export function thinkLevels(_model: ModelId): ThinkLevel[] {
  return [{ label: "Standard", description: "answer directly", thinking: false, effort: "low" }];
}

export function contextWindow(_model: ModelId): number {
  return localWindow();
}

/** A buffered call's ceiling, well inside the window it shares. */
export const BUFFERED_OUTPUT_TOKENS = 4_096;

export function bufferedOutputTokens(_model: ModelId): number {
  return BUFFERED_OUTPUT_TOKENS;
}

/** Keep a saved local model even before discovery has listed it; see OpenRouter's. */
export function normalize(config: ModelConfig): ModelConfig {
  const thinking = config.thinking === true;
  return { model: config.model, thinking, effort: thinking ? "high" : "low" };
}

export function ownsModel(model: ModelId): boolean {
  return model.startsWith(PREFIX);
}

export const ollamaManifest: DriverManifest = {
  id: "ollama",
  label: "Ollama",
  apiKeyEnv: RUNNING_ENV,
  keysUrl: "https://ollama.com/download",
  local: true,
  // Empty until discovery: only what is pulled on this machine is offered.
  models: [],
  thinkLevels,
  price,
  contextWindow,
  bufferedOutputTokens,
  normalize,
  ownsModel,
  discoverModels: async () => (await import("./catalog.js")).discoverModels(),
};
