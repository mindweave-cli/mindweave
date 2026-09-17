/**
 * registry.ts — the one place that knows which providers exist.
 *
 * Every other core module reads the driver through `activeDriver()` and never
 * names a provider. That is what keeps the boundary real: if a second file in
 * `dynamo/` or `cli/` ever imports `drivers/<provider>/` directly, the seam has
 * been broken and it will be obvious here.
 *
 * The split that makes this cheap: each provider's MANIFEST (model list, prices,
 * reasoning levels, context window) is plain data and is always loaded, because
 * the `/model` picker and the cost/compaction math need it before anyone has
 * chosen anything. The provider's DRIVER (wire format, SDK, streaming) is behind
 * a dynamic import and loads only once the user actually selects one of its
 * models. So a DeepSeek user never loads Anthropic's SDK, and adding providers
 * doesn't make any single user's startup heavier.
 *
 * The session picks a driver once, at start, and again when `/model` changes the
 * selection — "compile down to one driver" rather than branching per call.
 */
import type { Driver, DriverManifest, Effort, ModelChoice, ModelConfig, ModelFacts, ModelId, ThinkLevel } from "./types.js";
import { deepseekManifest } from "./deepseek/manifest.js";
import { anthropicManifest } from "./anthropic/manifest.js";
import { openaiManifest } from "./openai/manifest.js";
import { qwenManifest } from "./qwen/manifest.js";
import { kimiManifest } from "./kimi/manifest.js";
import { glmManifest } from "./glm/manifest.js";
import { xaiManifest } from "./xai/manifest.js";
import { mistralManifest } from "./mistral/manifest.js";
import { groqManifest } from "./groq/manifest.js";
import { cerebrasManifest } from "./cerebras/manifest.js";
import { geminiManifest } from "./gemini/manifest.js";
import { metaManifest } from "./meta/manifest.js";
import { minimaxManifest } from "./minimax/manifest.js";
import { tencentManifest } from "./tencent/manifest.js";
import { openrouterManifest } from "./openrouter/manifest.js";

/** Every provider's cheap metadata, in display order. Always loaded. */
const MANIFESTS: DriverManifest[] = [
  deepseekManifest,
  anthropicManifest,
  openaiManifest,
  qwenManifest,
  kimiManifest,
  glmManifest,
  xaiManifest,
  mistralManifest,
  groqManifest,
  cerebrasManifest,
  geminiManifest,
  metaManifest,
  minimaxManifest,
  tencentManifest,
  openrouterManifest,
];

/** How to load each provider's wire code, on demand. Keyed by manifest id. */
const LOADERS: Record<string, () => Promise<Driver>> = {
  deepseek: async () => (await import("./deepseek/index.js")).deepseekDriver,
  anthropic: async () => (await import("./anthropic/index.js")).anthropicDriver,
  openai: async () => (await import("./openai/index.js")).openaiDriver,
  qwen: async () => (await import("./qwen/index.js")).qwenDriver,
  kimi: async () => (await import("./kimi/index.js")).kimiDriver,
  glm: async () => (await import("./glm/index.js")).glmDriver,
  xai: async () => (await import("./xai/index.js")).xaiDriver,
  mistral: async () => (await import("./mistral/index.js")).mistralDriver,
  groq: async () => (await import("./groq/index.js")).groqDriver,
  cerebras: async () => (await import("./cerebras/index.js")).cerebrasDriver,
  gemini: async () => (await import("./gemini/index.js")).geminiDriver,
  meta: async () => (await import("./meta/index.js")).metaDriver,
  minimax: async () => (await import("./minimax/index.js")).minimaxDriver,
  tencent: async () => (await import("./tencent/index.js")).tencentDriver,
  openrouter: async () => (await import("./openrouter/index.js")).openrouterDriver,
};

/** The provider used when a model id doesn't match any other. */
const FALLBACK = MANIFESTS[0]!;

const loaded = new Map<string, Driver>();
let active: Driver | null = null;

/**
 * Live model lists for DISCOVERED providers, keyed by manifest id.
 *
 * The registry owns this cache rather than each driver, for one reason: a driver
 * that memoized its own would go stale exactly when the user pulls a new model and
 * reopens the picker to find it. Here there is one place to refresh and one place
 * to reason about.
 */
const discovered = new Map<string, ModelChoice[]>();

/**
 * The models a provider currently offers — its discovered list when it has one,
 * its declared list otherwise.
 *
 * Every caller must go through this rather than reading `manifest.models`, or a
 * discovered provider reads as permanently empty. That is the single rule this
 * whole mechanism depends on, and `registry.test.ts` pins it.
 */
export function modelsOf(manifest: DriverManifest): ModelChoice[] {
  const list = discovered.get(manifest.id) ?? manifest.models;
  // Drop any model whose retirement date has passed (see ModelChoice.until). A model
  // the vendor has folded into a successor must stop appearing in the picker, even in
  // a build published before the date, so this is checked at read time rather than
  // baked into the list.
  const now = Date.now();
  return list.filter((m) => m.until === undefined || m.until > now);
}

/**
 * The manifest that declares a given model id, or the fallback for an unknown id.
 *
 * Three steps, in order, and the order matters: a provider's real list wins, then a
 * discovered provider's namespace claim, then the fallback. Checking claims last is
 * what stops a provider that claims broadly from stealing a model another provider
 * actually serves.
 */
export function manifestForModel(model: ModelId): DriverManifest {
  return withFacts(
    MANIFESTS.find((m) => modelsOf(m).some((c) => c.id === model)) ??
      MANIFESTS.find((m) => m.ownsModel?.(model) === true) ??
      FALLBACK,
  );
}

/** The facts a discovered listing reported for one model, if any. */
function factsOf(manifest: DriverManifest, model: ModelId): ModelFacts | undefined {
  return discovered.get(manifest.id)?.find((c) => c.id === model)?.facts;
}

const views = new WeakMap<DriverManifest, DriverManifest>();

/**
 * A discovered provider's manifest, answering from its listing's facts first.
 *
 * Every consumer reads a model's window, price, vision and reasoning ladder through
 * `manifestForModel`, so wrapping here is what lets a router report real numbers
 * without a single call site learning that discovered facts exist. Anything the
 * listing did not report falls through to the manifest's own function.
 *
 * A fixed provider is returned untouched: it has no listing to consult.
 */
function withFacts(manifest: DriverManifest): DriverManifest {
  if (!manifest.discoverModels) return manifest;
  let view = views.get(manifest);
  if (view) return view;
  view = {
    ...manifest,
    thinkLevels: (model) => factsOf(manifest, model)?.thinkLevels ?? manifest.thinkLevels(model),
    price: (model) => factsOf(manifest, model)?.price ?? manifest.price(model),
    contextWindow: (model) => factsOf(manifest, model)?.contextWindow ?? manifest.contextWindow(model),
    bufferedOutputTokens: (model) =>
      factsOf(manifest, model)?.bufferedOutputTokens ?? manifest.bufferedOutputTokens?.(model) ?? 0,
    acceptsImages: (model) => factsOf(manifest, model)?.acceptsImages ?? manifest.acceptsImages?.(model) ?? false,
    normalize: (config) => {
      const base = manifest.normalize(config);
      const levels = factsOf(manifest, base.model)?.thinkLevels;
      // Snapped from the caller's own selection, not the manifest's fallback answer: the
      // fallback ladder is coarser, and rounding through it first would lose a rung the
      // real ladder has.
      return levels ? snapToLevels({ ...config, model: base.model }, levels) : base;
    },
  };
  views.set(manifest, view);
  return view;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Move a reasoning selection onto a ladder the model actually offers.
 *
 * Thinking is kept on or off when the ladder allows it, and flipped when it does not
 * (a model that cannot stop reasoning has no off rung). The effort goes to the nearest
 * offered rung, ties downward, which is the convention every fixed driver follows:
 * rounding up would quietly spend more than the user chose.
 */
export function snapToLevels(config: ModelConfig, levels: ThinkLevel[]): ModelConfig {
  if (levels.length === 0) return config;
  const same = levels.filter((l) => l.thinking === config.thinking);
  const pool = same.length > 0 ? same : levels;
  const thinking = pool[0]!.thinking;
  if (pool.some((l) => l.effort === config.effort)) return { ...config, thinking };
  const want = EFFORTS.indexOf(config.effort);
  let best = pool[0]!;
  for (const level of pool) {
    const d = Math.abs(EFFORTS.indexOf(level.effort) - want);
    const bestD = Math.abs(EFFORTS.indexOf(best.effort) - want);
    if (d < bestD || (d === bestD && EFFORTS.indexOf(level.effort) < EFFORTS.indexOf(best.effort))) best = level;
  }
  return { ...config, thinking, effort: best.effort };
}

/** Every model offered across all installed providers. */
export function allModels(): ModelChoice[] {
  return MANIFESTS.flatMap((m) => modelsOf(m));
}

/**
 * Refresh the model lists of every discovered provider.
 *
 * Called at session start and before a picker opens, so the list reflects what is
 * actually available now. Providers are refreshed CONCURRENTLY and independently:
 * one local runtime being down must not delay or empty another provider's list.
 *
 * A failure is deliberately silent here and non-destructive — the previous list
 * survives. A provider that cannot be reached is reported where the user can act on
 * it (no key, nothing running), not by a picker that quietly loses its contents.
 * Returns the ids that refreshed successfully, so a caller can tell the difference.
 */
export async function refreshModels(options: { maxAgeMs?: number } = {}): Promise<string[]> {
  const maxAge = options.maxAgeMs ?? 0;
  const now = Date.now();
  const dynamic = MANIFESTS.filter((m) => m.discoverModels).filter((m) => {
    // A list younger than the caller's tolerance is left alone. A router's catalogue is
    // a large download, and asking for it on every picker open costs a visible pause
    // for a list that changes weekly.
    const at = refreshedAt.get(m.id);
    return maxAge <= 0 || at === undefined || now - at >= maxAge;
  });
  const results = await Promise.all(
    dynamic.map(async (m) => {
      try {
        const models = await m.discoverModels!();
        // An empty result is a real answer — a runtime with nothing pulled — and is
        // stored as such. Failure is the case that must not overwrite.
        discovered.set(m.id, models);
        refreshedAt.set(m.id, Date.now());
        return m.id;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((id): id is string => id !== null);
}

/** When each discovered list was fetched, in ms. Seeded lists carry their fetch time. */
const refreshedAt = new Map<string, number>();

/**
 * A discovered provider's list as last fetched, for persisting. Undefined when it has
 * never been fetched or seeded, which is different from an empty list.
 */
export function discoveredList(id: string): { models: ModelChoice[]; fetchedAt: number } | undefined {
  const models = discovered.get(id);
  const fetchedAt = refreshedAt.get(id);
  return models && fetchedAt !== undefined ? { models, fetchedAt } : undefined;
}

/**
 * Install a previously fetched list, so a picker and the first turn have real facts
 * before the network answers. Never replaces a list fetched in this process: a disk
 * copy is older by definition.
 */
export function seedDiscovered(id: string, models: ModelChoice[], fetchedAt: number): void {
  if (!MANIFESTS.some((m) => m.id === id && m.discoverModels)) return;
  if (discovered.has(id)) return;
  discovered.set(id, models);
  refreshedAt.set(id, fetchedAt);
}

/** Ids of every provider that discovers its models. */
export function discoveredProviderIds(): string[] {
  return MANIFESTS.filter((m) => m.discoverModels).map((m) => m.id);
}

/** Drop every discovered list. For tests, and for a full provider reset. */
export function clearDiscovered(): void {
  discovered.clear();
  refreshedAt.clear();
}

/**
 * Every installed provider, in display order — what `/provider` lists.
 *
 * Manifests only: this stays synchronous and loads nobody's wire code, so the
 * picker can show every provider without paying to import the ones you don't use.
 */
export function allProviders(): DriverManifest[] {
  return [...MANIFESTS];
}

/**
 * Coerce a config onto something the owning provider actually serves. Pure and
 * synchronous — it consults only manifests, so the pickers can normalize a
 * selection without loading any provider's wire code.
 */
export function normalizeConfig(config: ModelConfig): ModelConfig {
  return manifestForModel(config.model).normalize(config);
}

/**
 * Load the driver that serves `model` and make it the session's active one.
 * Idempotent and cached, so calling it before every turn costs nothing after the
 * first. This is the only place a provider's wire code is ever loaded.
 */
export async function ensureDriver(model: ModelId): Promise<Driver> {
  const id = manifestForModel(model).id;
  let driver = loaded.get(id);
  if (!driver) {
    const load = LOADERS[id];
    if (!load) throw new Error(`No driver registered for provider '${id}'.`);
    driver = await load();
    loaded.set(id, driver);
  }
  active = driver;
  return driver;
}

/**
 * The driver currently serving this session. Callers reach this only from inside
 * a turn, which `ensureDriver` has already opened — a throw here means someone
 * tried to talk to a model before the session selected one.
 */
export function activeDriver(): Driver {
  if (!active) {
    throw new Error("No model driver is loaded yet — the session must select a model first.");
  }
  return active;
}

/**
 * Normalize streamed text for display: let the active driver repair anything its
 * provider leaked into the text channel, then trim. The trim is deliberately here
 * rather than in a driver — a reply that is only whitespace is an empty reply on
 * every provider, and the display layer treats an empty string as "nothing to
 * show". A driver with no repairs to make (or no driver yet) still gets the trim.
 */
export function sanitizeStreamText(raw: string): string {
  const driver = active;
  const repaired = driver?.sanitizeText ? driver.sanitizeText(raw) : raw;
  return repaired.trim();
}
