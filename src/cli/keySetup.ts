/**
 * keySetup.ts — what the first-run setup screen offers, as plain data.
 *
 * The old screen asked for ONE provider's key, the default one, and had no way past it.
 * Mindweave speaks to thirteen, and which one a new user already has an account with is
 * not something we can guess — so the screen shows the same list `/provider` does and
 * lets them fill in as many as they like before going in.
 *
 * The rows are derived here rather than in the view, so "is Continue available", "which
 * ones are already set up" and "what order are they in" can be checked without rendering
 * anything.
 */
import { allProviders } from "../drivers/registry.js";

export interface SetupRow {
  /** Manifest id, used to look the provider back up when a row is chosen. */
  id: string;
  /** What the user sees: "DeepSeek". */
  label: string;
  /** The variable its key is written to. */
  envVar: string;
  /** Where to get one, shown while entering that provider's key. */
  keysUrl: string;
  /** Already has a key — from this screen, the shell, or a previous run. */
  ready: boolean;
}

export interface SetupView {
  rows: SetupRow[];
  /** How many providers are ready to use. */
  readyCount: number;
  /**
   * Whether the user may leave setup. ONE key is enough — the whole point is that a
   * user who came for one provider is not made to care about the other twelve.
   */
  canContinue: boolean;
}

export function setupView(hasKey: (envVar: string) => boolean): SetupView {
  // A local runtime (Ollama) takes no key, so it is no row to fill in; running, it is still a
  // way to start, so it counts toward leaving setup.
  const rows = allProviders().filter((p) => !p.local).map((p) => ({
    id: p.id,
    label: p.label,
    envVar: p.apiKeyEnv,
    keysUrl: p.keysUrl,
    ready: hasKey(p.apiKeyEnv),
  }));
  const localReady = allProviders().filter((p) => p.local && hasKey(p.apiKeyEnv)).length;
  const readyCount = rows.filter((r) => r.ready).length + localReady;
  return { rows, readyCount, canContinue: readyCount > 0 };
}

/**
 * Which row to land on when the screen opens.
 *
 * The first provider WITHOUT a key, so adding a second or third key does not start by
 * re-offering one already done. Falls back to the top when everything is set up.
 */
export function initialRow(view: SetupView): number {
  const next = view.rows.findIndex((r) => !r.ready);
  return next === -1 ? 0 : next;
}
