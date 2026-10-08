/**
 * spendView.ts — tokens Mindweave has actually used, across every project on this
 * machine, read-only.
 *
 * Nothing new is recorded here: every session already keeps a per-call log
 * (`SessionMeta.callLog` — timestamp, tokens, model; see memory/types.ts's `CallUsage`),
 * written for exactly this kind of question. This module only reads it back, across
 * every project's every session, and sums it by model and by day/week/month.
 *
 * TOKENS ONLY, deliberately — no dollar figure. Several providers price in tiers this
 * module does not model, so a total in USD would look more authoritative than it is;
 * a token count carries no such claim. `billed` is the same definition SessionSpend
 * already uses elsewhere: fresh input plus output, cache hits excluded, because a hit
 * is not what the conversation actually cost to run.
 *
 * A session saved before callLog existed has only the coarser `spend` + `model` total
 * (one lump for the whole session, no per-call split) — used as a fallback so an old
 * session is not silently missing from the total, just less precisely attributed.
 */
import { callRecords, everyMeta, type CallRecord } from "../memory/allMetas.js";

export interface ModelSpend {
  model: string;
  /** Fresh input plus output — tokens actually billed, cache hits excluded. */
  billed: number;
  output: number;
  calls: number;
}

export interface SpendBucket {
  /** "2026-09-27" for a day or a week (that week's Monday), "2026-09" for a month. */
  key: string;
  billed: number;
}

export interface SpendView {
  totalBilled: number;
  totalOutput: number;
  /** Heaviest model first. */
  byModel: ModelSpend[];
  /** Chronological (oldest first, for a chart), most recent 30 days that have activity. */
  daily: SpendBucket[];
  /** Chronological, most recent 12 ISO weeks that have activity. */
  weekly: SpendBucket[];
  /** Chronological, most recent 12 months that have activity. */
  monthly: SpendBucket[];
  sessionsScanned: number;
  projectsScanned: number;
  /** The part of the total that was background work nobody asked for (session notes, summaries, page fetches). */
  background: { billed: number; calls: number };
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
/** The Monday (UTC) of the week containing `ms`, as a day key — a stable, sortable
 *  bucket id without pulling in a week-numbering library for one line of arithmetic. */
function weekKey(ms: number): string {
  const d = new Date(ms);
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return dayKey(d.getTime());
}

function bump(map: Map<string, number>, key: string, n: number): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

/** Newest `limit` keys, then re-sorted chronologically — what a chart or a list
 *  reading top-to-bottom-by-recency both want, from the same map. */
function recentBuckets(map: Map<string, number>, limit: number): SpendBucket[] {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, limit)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, billed]) => ({ key, billed }));
}

function accumulate(
  model: string,
  billed: number,
  output: number,
  at: number,
  byModel: Map<string, ModelSpend>,
  daily: Map<string, number>,
  weekly: Map<string, number>,
  monthly: Map<string, number>,
): void {
  const row = byModel.get(model) ?? { model, billed: 0, output: 0, calls: 0 };
  row.billed += billed;
  row.output += output;
  row.calls += 1;
  byModel.set(model, row);
  bump(daily, dayKey(at), billed);
  bump(weekly, weekKey(at), billed);
  bump(monthly, monthKey(at), billed);
}

function accumulateCall(
  call: CallRecord,
  byModel: Map<string, ModelSpend>,
  daily: Map<string, number>,
  weekly: Map<string, number>,
  monthly: Map<string, number>,
): number {
  const billed = call.miss + call.out;
  accumulate(call.model, billed, call.out, call.at, byModel, daily, weekly, monthly);
  return billed;
}

/** Everything the Spend screen shows: total tokens billed, by model, by day/week/month. */
export async function spendView(): Promise<SpendView> {
  const metas = await everyMeta();
  const byModel = new Map<string, ModelSpend>();
  const daily = new Map<string, number>();
  const weekly = new Map<string, number>();
  const monthly = new Map<string, number>();
  const projects = new Set<string>();
  let totalBilled = 0;
  let totalOutput = 0;
  const background = { billed: 0, calls: 0 };

  for (const meta of metas) {
    projects.add(meta.cwd);
    for (const call of callRecords(meta)) {
      const billed = accumulateCall(call, byModel, daily, weekly, monthly);
      totalBilled += billed;
      totalOutput += call.out;
      if (call.aux) {
        background.billed += billed;
        background.calls += 1;
      }
    }
  }

  return {
    totalBilled,
    totalOutput,
    byModel: [...byModel.values()].sort((a, b) => b.billed - a.billed),
    daily: recentBuckets(daily, 30),
    weekly: recentBuckets(weekly, 12),
    monthly: recentBuckets(monthly, 12),
    sessionsScanned: metas.length,
    projectsScanned: projects.size,
    background,
  };
}
