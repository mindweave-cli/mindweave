/**
 * contextSettings.ts — the user's own auto-compaction bar, as a settings screen or the
 * CLI can read and change it.
 *
 * Mindweave picks a default per model (dynamo/contextWindow.ts's `autoCompactThreshold`):
 * a formula anchored to that model's real window, not a hand-set number, so it is already
 * right for every provider without anyone maintaining a table. This module adds one thing
 * on top: an OVERRIDE the user sets themselves, for this project or for all of them,
 * stored the same way rules/skills/mode already are (governor/index.ts's context.json,
 * project wins over global) and applied through the same live-refresh path
 * (refreshGovernance) everything else in the governor uses.
 *
 * Deliberately thin: no new precedence mechanism, no new file layout, just one more field
 * on Governance.
 */
import { basename } from "node:path";
import type { Session } from "../memory/types.js";
import { loadContextOverride, saveContextOverride, type GovernanceScope } from "../governor/index.js";
import { refreshGovernance } from "../dynamo/engine.js";
import { autoCompactThreshold, sharpContextWindow } from "../dynamo/contextWindow.js";

export type ContextScope = GovernanceScope;

/** Where the effective bar actually comes from, for the screen's banner line. */
export type ContextSource = "project" | "global" | "default";

/** Presets shown before "Custom" — plain numbers, not lists, so any model can use them. */
export const CONTEXT_PRESETS = [120_000, 200_000, 400_000] as const;

/** A floor for a custom bar: below this, compaction would fire on almost every turn. */
export const CONTEXT_MIN_TOKENS = 20_000;

export interface ContextRecommendation {
  model: string;
  /** The model's real context window, as its driver reports it. */
  window: number;
  /** Mindweave's own default bar for this model (the formula in contextWindow.ts). */
  recommended: number;
  /** One short, human sentence explaining the default — built from the numbers above. */
  note: string;
}

/** Mindweave's own recommendation for a model, in one templated sentence. */
export function contextRecommendationFor(model: string): ContextRecommendation {
  const window = sharpContextWindow(model);
  const recommended = autoCompactThreshold(model);
  const windowStr = formatTokens(window);
  const recommendedStr = formatTokens(recommended);
  const note =
    `${model}'s window is ${windowStr} tokens. We default to ${recommendedStr} so there's room to ` +
    `compact without losing early context or interrupting a turn. A model with a smaller window has ` +
    `less room to spare; a larger one can safely go higher.`;
  return { model, window, recommended, note };
}

function formatTokens(n: number): string {
  return n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n);
}

export interface ContextView {
  project: { name: string; cwd: string; current: boolean };
  model: string;
  recommendation: ContextRecommendation;
  /** This project's own override, or null if it has none. */
  projectOverride: number | null;
  /** The all-projects override, or null if it has none. */
  globalOverride: number | null;
  /** What is actually in force right now, and why. */
  effective: { tokens: number; source: ContextSource };
  presets: readonly number[];
  minTokens: number;
}

/** Everything the Usage > Context screen shows, for `cwd` (the open project by default,
 *  or any other project the user picks in its scope dropdown). */
export async function contextView(session: Session, cwd: string = session.cwd): Promise<ContextView> {
  const model = session.modelConfig.model;
  const recommendation = contextRecommendationFor(model);
  const [projectOverride, globalOverride] = await Promise.all([
    loadContextOverride(cwd, "project"),
    loadContextOverride(cwd, "global"),
  ]);
  const effective: { tokens: number; source: ContextSource } =
    projectOverride !== null
      ? { tokens: projectOverride, source: "project" }
      : globalOverride !== null
        ? { tokens: globalOverride, source: "global" }
        : { tokens: recommendation.recommended, source: "default" };
  return {
    project: { name: basename(cwd), cwd, current: sameProject(cwd, session.cwd) },
    model,
    recommendation,
    projectOverride,
    globalOverride,
    effective,
    presets: CONTEXT_PRESETS,
    minTokens: CONTEXT_MIN_TOKENS,
  };
}

function sameProject(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export type ContextResult = { ok: true } | { ok: false; error: string };

/** Set this scope's override. Clamped to [minTokens, the model's real window]  so a
 *  custom value can never be something the model could not physically hold. */
export async function setContextOverride(
  session: Session,
  scope: ContextScope,
  tokens: number,
  cwd: string = session.cwd,
): Promise<ContextResult> {
  if (!Number.isFinite(tokens) || tokens <= 0) return { ok: false, error: "Give a token count above zero." };
  const window = sharpContextWindow(session.modelConfig.model);
  const clamped = Math.min(Math.max(Math.round(tokens), CONTEXT_MIN_TOKENS), window);
  await saveContextOverride(cwd, scope, clamped);
  await refreshGovernance(session, true);
  return { ok: true };
}

/** Clear this scope's override, back to Mindweave's own default. */
export async function resetContextOverride(
  session: Session,
  scope: ContextScope,
  cwd: string = session.cwd,
): Promise<ContextResult> {
  await saveContextOverride(cwd, scope, null);
  await refreshGovernance(session, true);
  return { ok: true };
}
