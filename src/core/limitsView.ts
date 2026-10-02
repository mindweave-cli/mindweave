/**
 * limitsView.ts — the usage-limits settings and where they stand, as one plain object for a
 * front end to draw. The rules live in dynamo/usageLimits.ts; this only assembles the answer
 * a settings screen wants and applies what it sends back.
 */
import {
  analyzeCurrent,
  currentLimits,
  formatAmount,
  formatWait,
  formatWhen,
  limitStatus,
  refreshUsageLimits,
  saveLimits,
  type Analysis,
  type LimitsConfig,
  type LimitsStatus,
} from "../dynamo/usageLimits.js";

export interface LimitsView {
  config: LimitsConfig;
  status: LimitsStatus;
  /** Ready-made wording per window, so every front end phrases the same moment the same way. */
  lines: Array<{ id: string; label: string; used: string; limit: string; opens: string | null }>;
}

async function view(force: boolean): Promise<LimitsView> {
  await refreshUsageLimits({ force });
  const config = currentLimits();
  const status = limitStatus();
  return {
    config,
    status,
    lines: status.windows.map((w) => ({
      id: w.id,
      label: w.label,
      used: formatAmount(status.unit, w.used),
      limit: formatAmount(status.unit, w.limit),
      opens: w.end === null ? null : `${w.state === "blocked" ? "opens again" : "resets"} ${formatWhen(w.end, status.now)} (in ${formatWait(w.end - status.now)})`,
    })),
  };
}

/** The settings and the windows as they stand. `force` re-reads every session from disk. */
export function limitsView(force = false): Promise<LimitsView> {
  return view(force);
}

/** Save what the settings screen sent, then say where things stand under it. */
export async function saveLimitsFromPanel(patch: Partial<LimitsConfig>): Promise<LimitsView> {
  await saveLimits(patch);
  return view(true);
}

/**
 * Work out the 5-hour and weekly amounts from a month's budget and how the tool is actually
 * used. Nothing is saved: the screen shows the result and the person decides.
 */
export async function analyzeForPanel(input: Pick<LimitsConfig, "unit" | "monthly" | "monthStartDay">): Promise<Analysis> {
  await refreshUsageLimits({ force: true });
  return analyzeCurrent(input);
}
