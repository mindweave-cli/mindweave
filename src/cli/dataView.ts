/**
 * dataView.ts — the words of `/data`: a person's own usage on this computer, and the state of the optional daily count.
 *
 * Pure. The numbers come from `spendView` (which reads the sessions already on disk) and the setting; nothing is sent from
 * here. The count itself, and what exactly it holds, is in analytics.ts.
 */
import type { SpendView } from "../core/spendView.js";
import { ANALYTICS_EXPLANATION, DATA_PAGE_URL, PLACEHOLDER_ID, type Payload } from "./analytics.js";

/** The explanation, shown on request: it is too long for the box that holds the summary. */
export { ANALYTICS_EXPLANATION };

function tokens(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

/** The summary shown at the top of `/data`. */
export function dataSummary(spend: SpendView | null, state: { on: boolean; blocked: string | null; past?: "pending" | "sent" | "off" }): string {
  // Five lines at most: the box this sits in shows only a few, and the line that says whether anything is sent must not be the one cut off.
  const lines: string[] = [];
  if (!spend || spend.totalBilled === 0) {
    lines.push("Your usage on this computer: nothing recorded yet");
  } else {
    const week = spend.daily.slice(-7).reduce((sum, d) => sum + d.billed, 0);
    lines.push(`Your usage: ${tokens(week)} tokens in 7 days, ${tokens(spend.totalBilled)} in all (${spend.sessionsScanned} sessions, ${spend.projectsScanned} projects)`);
    const top = spend.byModel.slice(0, 2).map((m) => `${m.model} ${tokens(m.billed)}`).join(" · ");
    if (top) lines.push(`Top models: ${top}`);
  }
  const on = state.past === "pending" ? "Daily count: ON. Your last 60 days go once, then one a day." : state.past === "off" ? "Daily count: ON. Your past is not shared." : "Daily count: ON. One small message a day, after your first real work.";
  lines.push(state.on ? on : "Daily count: OFF. Nothing is sent.");
  if (state.on && state.blocked) lines.push(`Not sent from here: ${state.blocked}.`);
  return lines.join("\n");
}

const LONGEST_RAW = 1400;

/**
 * The message as a person can read it: who, when, and one line per model per day, then the exact message itself when it
 * is short enough to read (a person's past makes it long, so then only its size is said). Pure.
 */
export function describePayload(p: Payload): string {
  const lines: string[] = ["This is what would be sent. Nothing is sent while sharing is off.", ""];
  lines.push(`  id        ${p.id === PLACEHOLDER_ID ? "random, made when the first count is sent" : p.id}`);
  lines.push(`  from      Mindweave ${p.version} on ${p.os}, ${p.day}`);
  const days = p.usage ?? [];
  if (days.length === 0) {
    lines.push("  usage     none yet");
  } else {
    const models = new Set(days.flatMap((d) => d.models.map((m) => m.m)));
    lines.push(`  usage     ${days.length} ${days.length === 1 ? "day" : "days"}, ${models.size} ${models.size === 1 ? "model" : "models"}`);
    for (const d of days.slice(0, 4)) {
      for (const m of d.models.slice(0, 3)) {
        lines.push(`    ${d.day}  ${m.m}: ${tokens(m.i)} in, ${tokens(m.c)} cached, ${tokens(m.o)} out, ${m.n} calls, $${m.$.toFixed(2)}`);
      }
      if (d.models.length > 3) lines.push(`    ${d.day}  and ${d.models.length - 3} more models`);
    }
    if (days.length > 4) lines.push(`    and ${days.length - 4} more days`);
  }
  if (p.active && p.active.length > 0) lines.push(`  past      ${p.active.length} days of work, sent once with the days above`);
  lines.push("");
  lines.push(`Shown for everyone at ${DATA_PAGE_URL}`);
  const raw = JSON.stringify(p);
  lines.push(raw.length <= LONGEST_RAW ? `Exactly as sent: ${raw}` : `Exactly as sent: the same fields for each day, ${(raw.length / 1024).toFixed(1)} KB in all.`);
  return lines.join("\n");
}
