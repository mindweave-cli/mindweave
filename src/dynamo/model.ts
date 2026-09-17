/**
 * model.ts — which model answers, and how hard it thinks.
 *
 * One small config object decides both: `/model` picks the model, `/think` picks
 * the reasoning level for that model. What those choices ARE is the driver's
 * business (each provider exposes reasoning differently); this module owns only
 * the parts that are the same for every provider — the shape of the config, the
 * labels the UI renders, and making the choice sticky.
 *
 * The choice is sticky PER PROJECT (saved under the project's state dir, like
 * sessions and the governor), so it carries across sessions in that project.
 * Loading a config also selects the driver that serves it, so the rest of the
 * session talks to the right provider without ever naming one.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir, stateRoot } from "../memory/store.js";
import {
  allModels,
  allProviders,
  discoveredList,
  discoveredProviderIds,
  ensureDriver,
  manifestForModel,
  modelsOf,
  normalizeConfig,
  refreshModels as refreshDiscovered,
  seedDiscovered,
} from "../drivers/registry.js";
import type { Effort, ModelChoice, ModelConfig, ModelId, ThinkLevel } from "../drivers/types.js";

export type { Effort, ModelChoice, ModelConfig, ModelId, ThinkLevel };

/**
 * How long a discovered model list is trusted before it is fetched again.
 *
 * A router's catalogue is a large download that changes weekly, and asking for it every
 * time `/model` opens puts a pause in front of a list that almost never changed. Six
 * hours keeps a new model a same-day arrival without paying for it on every open.
 */
export const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000;

function discoveryCachePath(id: string): string {
  return join(stateRoot(), "cache", `models-${id}.json`);
}

/**
 * Refresh discovered model lists older than `maxAgeMs` (all of them by default), and
 * keep what arrived on disk so the next launch starts with it.
 */
export async function refreshModels(options: { maxAgeMs?: number } = {}): Promise<string[]> {
  const refreshed = await refreshDiscovered(options);
  await Promise.all(refreshed.map((id) => persistDiscovered(id)));
  return refreshed;
}

async function persistDiscovered(id: string): Promise<void> {
  const entry = discoveredList(id);
  if (!entry) return;
  try {
    const path = discoveryCachePath(id);
    await fs.mkdir(join(stateRoot(), "cache"), { recursive: true });
    // Written beside and renamed over, so a crash mid-write leaves the old list rather
    // than half a JSON file that would be discarded on the next launch.
    const tmp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ fetchedAt: entry.fetchedAt, models: entry.models }), "utf8");
    await fs.rename(tmp, path);
  } catch {
    /* best-effort: the list is still in memory */
  }
}

/** Write one provider's list to disk now. Exported for tests only. */
export const persistedForTest = persistDiscovered;

/** Install every discovered list saved by an earlier run. A bad file is ignored. */
export async function loadDiscoveryCache(): Promise<void> {
  await Promise.all(
    discoveredProviderIds().map(async (id) => {
      try {
        const parsed = JSON.parse(await fs.readFile(discoveryCachePath(id), "utf8")) as {
          fetchedAt?: unknown;
          models?: unknown;
        };
        if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.models)) return;
        const models = parsed.models.filter(
          (m): m is ModelChoice =>
            !!m && typeof (m as ModelChoice).id === "string" && typeof (m as ModelChoice).label === "string",
        );
        seedDiscovered(id, models.map((m) => ({ ...m, description: m.description ?? "" })), parsed.fetchedAt);
      } catch {
        /* no cache yet, or unreadable: discovery will fill it */
      }
    }),
  );
}

/**
 * The models offered by `/model`, across every installed provider.
 *
 * A FUNCTION rather than the module-level constant it used to be. That constant was
 * a snapshot taken at import time, which was correct while every provider declared a
 * fixed lineup and silently wrong the moment one discovers its models at runtime: a
 * locally-served model would never appear in a label lookup, however many times the
 * list refreshed. Nothing may cache this result.
 */
export function models(): ModelChoice[] {
  return allModels();
}

/**
 * The out-of-the-box choice: the first offered model, NO thinking.
 *
 * Thinking stays off unless the user turns it on with `/think`. It costs reasoning
 * tokens on every request, and that is the user's call to make, not a default to
 * inherit. Over-narration is NOT solved by paying for a reasoning channel — it is
 * solved by not emitting the deliberation at all, which `narrationBudget` enforces
 * mechanically and the prompt states as a rule.
 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = normalizeConfig({
  // The first model of the first provider. Read at import time on purpose: this is
  // the out-of-the-box fallback, so it must resolve without any provider having been
  // reached, which rules out anything a discovered provider could contribute.
  model: allModels()[0]!.id,
  thinking: false,
  effort: "high",
});

/**
 * The provider serving a model. The active provider is always DERIVED from the
 * current model rather than stored beside it: a second copy of the same fact is a
 * second thing to keep in sync, and the two disagreeing is the bug nobody notices.
 */
export function providerOf(model: ModelId): { id: string; label: string } {
  const { id, label } = manifestForModel(model);
  return { id, label };
}

/**
 * The models `/model` offers: those of the provider currently in use, not every
 * model everywhere. Picking a provider is `/provider`'s job.
 */
export function modelsOfProvider(model: ModelId): ModelChoice[] {
  return modelsOf(manifestForModel(model));
}

/**
 * A model we can actually run, when the configured one's provider has no key.
 *
 * A saved config outlives the key that made it usable — a key can be removed, or
 * (as happened) written by a version that persisted a provider switch before
 * checking. Without a way back, the project reopens straight into the key prompt on
 * every launch and there is nothing the user can do from inside the app. Returns
 * null when the current provider is fine, or when no installed provider has a key
 * (genuine first run — the prompt is then the right answer).
 *
 * `hasKey` is injected so this stays pure and testable.
 */
export function usableFallback(model: ModelId, hasKey: (envVar: string) => boolean): ModelId | null {
  if (hasKey(manifestForModel(model).apiKeyEnv)) return null;
  for (const provider of allProviders()) {
    const first = modelsOf(provider)[0];
    if (first && hasKey(provider.apiKeyEnv)) return first.id;
  }
  return null;
}

/**
 * Does this machine need a key BEFORE anything can run?
 *
 * True only when no installed provider has one. The first-run gate used to ask about
 * the DEFAULT provider alone, so someone arriving with a key for any of the other twelve
 * was shown a prompt for a provider they had not chosen and could not dismiss — the
 * escape is only offered when a switch is pending mid-session. The session loader would
 * meanwhile move them onto the provider they could actually run, underneath a screen
 * still demanding a different one.
 *
 * `hasKey` is injected for the same reason as above: this decides whether the app opens
 * at all, so it is worth being able to test.
 */
export function needsKeySetup(model: ModelId, hasKey: (envVar: string) => boolean): boolean {
  if (hasKey(manifestForModel(model).apiKeyEnv)) return false;
  return usableFallback(model, hasKey) === null;
}

/** The reasoning levels offered by `/think` for a model. */
export function thinkLevels(model: ModelId): ThinkLevel[] {
  return manifestForModel(model).thinkLevels(model);
}

/** The label of the reasoning level a config currently represents. */
export function thinkLabel(cfg: ModelConfig): string {
  const match = thinkLevels(cfg.model).find(
    (l) => l.thinking === cfg.thinking && (!l.thinking || l.effort === cfg.effort),
  );
  return match?.label ?? "Standard";
}

/** The model's display name (for status lines / confirmations). Reads the list
 *  live, so a model that only exists after discovery still gets its real name
 *  rather than falling back to its raw id. */
export function modelLabel(model: ModelId): string {
  return allModels().find((m) => m.id === model)?.label ?? model;
}

/**
 * Switch the model, letting the owning provider keep the reasoning intent valid
 * (a level the target model doesn't offer is clamped down rather than sent and
 * rejected). Synchronous: it consults only manifests. The provider's wire code is
 * loaded separately, by `ensureDriver`, before the next turn runs.
 */
export function withModel(cfg: ModelConfig, model: ModelId): ModelConfig {
  return normalizeConfig({ ...cfg, model });
}

function configPath(projectCwd: string): string {
  return join(projectDir(projectCwd), "model.json");
}

/**
 * Load the project's saved model config, or the default when none is saved, and
 * load the provider that serves it — this is where a session's provider gets
 * decided, and the only place its wire code comes off disk.
 *
 * Discovery runs FIRST, and the order is load-bearing. A discovered provider's
 * models are unknown until it is asked, so normalizing a saved config before that
 * would coerce a perfectly valid local model onto some other provider's default,
 * and the user would find their choice silently changed on every launch. Discovery
 * failing is harmless here: `ownsModel` still attributes the id correctly, and the
 * config survives to be normalized against a list that arrives later.
 */
export async function loadModelConfig(projectCwd: string): Promise<ModelConfig> {
  // A provider with a saved list starts from it and refreshes in the background once
  // stale; only a provider with no list at all is waited on, because normalizing a
  // saved config against nothing is the bug the comment above describes.
  await loadDiscoveryCache();
  const refresh = refreshModels({ maxAgeMs: DISCOVERY_TTL_MS });
  if (discoveredProviderIds().some((id) => !discoveredList(id))) await refresh;

  let config: ModelConfig;
  try {
    const raw = await fs.readFile(configPath(projectCwd), "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelConfig>;
    config = normalizeConfig({
      model: parsed.model ?? DEFAULT_MODEL_CONFIG.model,
      thinking: parsed.thinking === true,
      effort: parsed.effort ?? "high",
    });
  } catch {
    config = { ...DEFAULT_MODEL_CONFIG };
  }
  await ensureDriver(config.model);
  return config;
}

/** Persist the project's model config (best-effort; never throws). */
export async function saveModelConfig(projectCwd: string, cfg: ModelConfig): Promise<void> {
  try {
    await fs.mkdir(projectDir(projectCwd), { recursive: true });
    await fs.writeFile(configPath(projectCwd), JSON.stringify(cfg, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}
