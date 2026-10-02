/**
 * auxModel.ts — the model settings for Mindweave's own background calls.
 *
 * Compaction's summary and the session notes are written by the user's chosen model with
 * reasoning switched off, and with no tool schemas attached: they are condensing, not
 * solving or calling tools. Two different providers refuse a plain call like that outright,
 * each for its own reason, and with no way round it every compaction failed three times and
 * then stopped trying, and the notes were never written, so a long session on such a model
 * simply grew until it overflowed:
 *
 *   - Some models refuse with reasoning off ("Reasoning is mandatory for this endpoint and
 *     cannot be disabled").
 *   - Some free/promotional OpenRouter models refuse a request with no tools at all,
 *     regardless of reasoning ("only available on agentic harnesses" — meaning they only
 *     serve requests shaped like a coding agent's, tools included).
 *
 * So the call is tried the cheap way first, and whichever refusal comes back is answered
 * with exactly the setting it named — reasoning on, or real tool schemas attached — and
 * remembered for the rest of the process so later calls go straight to what works. Nothing
 * here names a provider or builds a tool list: the only input is what the provider itself
 * said, and attaching tools is the CALLER's job (it owns the schemas; this module does not).
 */
import type { ModelConfig } from "../drivers/types.js";

/** Models that refused a call with reasoning off, for the life of this process. */
const reasoningRequired = new Set<string>();

/** Models that refused a call with no tool schemas attached, for the life of this process. */
const needsTools = new Set<string>();

/** Did the provider refuse because reasoning cannot be switched off? Pure. */
export function isReasoningRequired(error: unknown): boolean {
  const text = errorText(error);
  return (
    /reasoning[^.]{0,40}\b(mandatory|required)\b/i.test(text) ||
    /cannot\s+(be\s+)?disabl\w*[^.]{0,30}\b(reasoning|thinking)\b/i.test(text) ||
    /\b(reasoning|thinking)\b[^.]{0,40}cannot\s+be\s+disabled/i.test(text)
  );
}

/** Did the provider refuse because this model only serves tool-using ("agentic") calls? Pure. */
export function isAgenticOnlyRefusal(error: unknown): boolean {
  return /agentic\s+harness/i.test(errorText(error));
}

/** The settings a background call uses for this model. Pure apart from the memo. */
export function auxConfig(config: ModelConfig, thinking = reasoningRequired.has(config.model)): ModelConfig {
  return thinking ? { ...config, thinking: true, effort: "low" } : { ...config, thinking: false };
}

/**
 * Run a background call, retrying once for whichever refusal the provider actually gave —
 * reasoning forced on, or tool schemas attached — and once more if BOTH turn out to be
 * needed. `run`'s second argument says whether to attach real tool schemas this attempt;
 * building them from the tool registry is the caller's job.
 */
export async function withAuxModel<T>(
  config: ModelConfig,
  run: (model: ModelConfig, withTools: boolean) => Promise<T>,
): Promise<T> {
  return attempt(config, run, reasoningRequired.has(config.model), needsTools.has(config.model));
}

async function attempt<T>(
  config: ModelConfig,
  run: (model: ModelConfig, withTools: boolean) => Promise<T>,
  thinking: boolean,
  tools: boolean,
): Promise<T> {
  try {
    return await run(auxConfig(config, thinking), tools);
  } catch (error) {
    if (!thinking && isReasoningRequired(error)) {
      reasoningRequired.add(config.model);
      return attempt(config, run, true, tools);
    }
    if (!tools && isAgenticOnlyRefusal(error)) {
      needsTools.add(config.model);
      return attempt(config, run, thinking, true);
    }
    throw error;
  }
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const e = error as { message?: unknown; detail?: unknown; body?: unknown; error?: unknown };
  const parts = [e.message, e.detail, e.body, e.error].map((p) => (typeof p === "string" ? p : p ? JSON.stringify(p) : ""));
  return parts.join(" ");
}
