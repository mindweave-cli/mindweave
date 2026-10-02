/**
 * usageLimits.test.ts — the windows, the gate, the heads-ups and the analysis.
 *
 * Time is always passed in, never read, so every case is a fixed moment. Local dates are built
 * with the local constructor because the billing month is the user's own calendar month.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  FIVE_HOURS_MS,
  WEEK_MS,
  analyzeLimits,
  billingMonth,
  blockReason,
  callAmount,
  computeStatus,
  currentLimits,
  formatWait,
  limitGateReason,
  noteUsage,
  readLimitsConfig,
  resetUsageLimitsForTests,
  saveLimits,
  sanitizeLimits,
  setLedgerForTests,
  takeLimitWarnings,
  type LimitsConfig,
} from "./usageLimits.js";

const H = 60 * 60 * 1000;
const cfg = (over: Partial<LimitsConfig> = {}): LimitsConfig => ({
  enabled: true, unit: "tokens", monthly: 1_000_000, monthStartDay: 1, fiveHour: 100_000, weekly: 400_000, enforce: true, ...over,
});
const rec = (at: number, tokens: number, usd = 0) => ({ at, tokens, usd });
const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime(); // 15 Sep 2026, noon

beforeEach(() => {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "limits-"));
  resetUsageLimitsForTests();
});

// ── the 5-hour window ────────────────────────────────────────────────────────

test("a 5-hour window opens at the first use and counts what follows inside it", () => {
  const s = computeStatus(cfg(), [rec(NOW - 3 * H, 30_000), rec(NOW - 1 * H, 20_000)], NOW);
  const w = s.windows.find((x) => x.id === "fiveHour")!;
  assert.equal(w.used, 50_000);
  assert.equal(w.start, NOW - 3 * H);
  assert.equal(w.end, NOW - 3 * H + FIVE_HOURS_MS);
  assert.equal(w.state, "ok");
});

test("it closes when its amount is used and stays closed until the window ends", () => {
  const s = computeStatus(cfg(), [rec(NOW - 4 * H, 60_000), rec(NOW - 1 * H, 45_000)], NOW);
  const w = s.windows.find((x) => x.id === "fiveHour")!;
  assert.equal(w.state, "blocked");
  assert.equal(s.blocked?.id, "fiveHour");
  assert.equal(s.blocked?.end, NOW - 4 * H + FIVE_HOURS_MS, "it reopens 5 hours after the window's own first use");
});

test("once the window has ended, the amount starts over and the next use opens a new one", () => {
  const s = computeStatus(cfg(), [rec(NOW - 6 * H, 100_000)], NOW);
  const w = s.windows.find((x) => x.id === "fiveHour")!;
  assert.equal(w.state, "idle");
  assert.equal(w.used, 0);
  assert.equal(s.blocked, null);
  const next = computeStatus(cfg(), [rec(NOW - 6 * H, 100_000), rec(NOW - 60_000, 5_000)], NOW);
  const w2 = next.windows.find((x) => x.id === "fiveHour")!;
  assert.equal(w2.used, 5_000, "only the new window's use counts");
  assert.equal(w2.start, NOW - 60_000);
});

// ── the week and the month ───────────────────────────────────────────────────

test("a spent week holds work back for days, and it wins over a 5-hour window that reopens sooner", () => {
  const recs = [rec(NOW - 2 * 24 * H, 380_000), rec(NOW - 1 * H, 30_000), rec(NOW - 1 * H + 1, 90_000)];
  const s = computeStatus(cfg({ weeklyResetAt: NOW - 2 * 24 * H }), recs, NOW);
  assert.equal(s.windows.find((x) => x.id === "weekly")!.state, "blocked");
  assert.equal(s.windows.find((x) => x.id === "fiveHour")!.state, "blocked");
  assert.equal(s.blocked?.id, "weekly", "the one that opens last is what the user waits for");
  assert.equal(s.blocked?.end, NOW - 2 * 24 * H + WEEK_MS);
});

test("the month is the billing month, and last month's use does not count", () => {
  const last = new Date(2026, 7, 30, 12).getTime();
  const s = computeStatus(cfg({ monthly: 500_000, fiveHour: 0, weekly: 0 }), [rec(last, 400_000), rec(NOW - 2 * H, 50_000)], NOW);
  const m = s.windows.find((x) => x.id === "monthly")!;
  assert.equal(m.used, 50_000);
});

test("a month that starts mid-month runs from that day to the same day next month", () => {
  const { start, end } = billingMonth(NOW, 20); // 15 Sep with a 20th start: the period began 20 Aug
  assert.equal(new Date(start).getMonth(), 7);
  assert.equal(new Date(start).getDate(), 20);
  assert.equal(new Date(end).getMonth(), 8);
  assert.equal(new Date(end).getDate(), 20);
});

test("a window with no amount set is simply absent", () => {
  const s = computeStatus(cfg({ fiveHour: 0, weekly: 0 }), [rec(NOW - H, 1)], NOW);
  assert.deepEqual(s.windows.map((w) => w.id), ["monthly"]);
});

test("money is counted in money, not tokens", () => {
  const s = computeStatus(cfg({ unit: "usd", monthly: 20, weekly: 5, fiveHour: 1 }), [rec(NOW - H, 1_000_000, 0.4), rec(NOW - 30 * 60_000, 500_000, 0.7)], NOW);
  const w = s.windows.find((x) => x.id === "fiveHour")!;
  assert.ok(Math.abs(w.used - 1.1) < 1e-9);
  assert.equal(w.state, "blocked");
});

// ── the gate ─────────────────────────────────────────────────────────────────

test("the gate says when work will be possible again, in words", () => {
  setLedgerForTests([rec(NOW - 4 * H, 120_000)], cfg());
  const reason = limitGateReason(NOW)!;
  assert.match(reason, /5-hour limit is used up/);
  assert.match(reason, /opens again/);
  assert.match(reason, /in 1h/);
});

test("nothing is held back when limits are off, or when they only warn", () => {
  setLedgerForTests([rec(NOW - H, 900_000)], cfg({ enabled: false }));
  assert.equal(limitGateReason(NOW), null);
  setLedgerForTests([rec(NOW - H, 900_000)], cfg({ enforce: false }));
  assert.equal(limitGateReason(NOW), null, "warn-only mode never stops a step");
});

test("a step that starts under the limit is not cut off: only the next one is refused", () => {
  setLedgerForTests([rec(NOW - H, 99_000)], cfg());
  assert.equal(limitGateReason(NOW), null, "1K under: the step goes ahead");
  noteUsage("m", { promptTokens: 3000, completionTokens: 500, totalTokens: 3500, cacheHitTokens: 0, cacheMissTokens: 3000 }, NOW);
  assert.match(limitGateReason(NOW + 1)!, /5-hour/, "that step took it over; the next is what stops");
  const s = computeStatus(currentLimits(), [], NOW);
  assert.equal(s.windows.length, 3);
});

test("it can be past a limit by no more than the step that crossed it", () => {
  setLedgerForTests([rec(NOW - H, 99_500)], cfg());
  noteUsage("m", { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cacheHitTokens: 0, cacheMissTokens: 1200 }, NOW);
  const w = computeStatus(currentLimits(), [rec(NOW - H, 99_500), rec(NOW, 1500)], NOW).windows.find((x) => x.id === "fiveHour")!;
  assert.equal(w.used, 101_000);
  assert.ok(w.used - w.limit <= 1500, "overshoot is bounded by one step");
});

// ── heads-ups ────────────────────────────────────────────────────────────────

test("80% and 95% each speak once per window, highest first when both are crossed at once", () => {
  setLedgerForTests([rec(NOW - H, 82_000)], cfg({ weekly: 0, monthly: 0 }));
  const first = takeLimitWarnings(NOW);
  assert.equal(first.length, 1);
  assert.match(first[0]!, /^80% of your 5-hour limit/);
  assert.deepEqual(takeLimitWarnings(NOW), [], "said once");
  setLedgerForTests([rec(NOW - H, 96_000)], cfg({ weekly: 0, monthly: 0 }));
  const second = takeLimitWarnings(NOW);
  assert.match(second[0]!, /^95%/);
  assert.deepEqual(takeLimitWarnings(NOW), []);
});

test("a window crossed straight to 95% says 95% only, and never 80% after it", () => {
  setLedgerForTests([rec(NOW - H, 96_000)], cfg({ weekly: 0, monthly: 0 }));
  assert.match(takeLimitWarnings(NOW)[0]!, /^95%/);
  assert.deepEqual(takeLimitWarnings(NOW), []);
});

test("a fresh window speaks again, and a full one leaves the talking to the gate", () => {
  setLedgerForTests([rec(NOW - 7 * H, 90_000), rec(NOW - H, 85_000)], cfg({ weekly: 0, monthly: 0 }));
  assert.equal(takeLimitWarnings(NOW).length, 1, "the new window is at 85%");
  setLedgerForTests([rec(NOW - H, 100_000)], cfg({ weekly: 0, monthly: 0 }));
  assert.deepEqual(takeLimitWarnings(NOW), [], "at 100% the gate speaks instead");
});

// ── analyze ──────────────────────────────────────────────────────────────────

test("the week gets its share of the month, so full weeks add up to the month and no more", () => {
  const a = analyzeLimits({ unit: "tokens", monthly: 3_000_000, monthStartDay: 1 }, [], NOW); // September: 30 days
  assert.equal(a.weekly, 700_000);
  assert.equal(a.windowsPerWeek, 8, "with no history it assumes a typical week");
  assert.equal(a.basedOnDays, 0);
});

test("a 5-hour window is half again its fair share, and never more than half the week", () => {
  const a = analyzeLimits({ unit: "tokens", monthly: 3_000_000, monthStartDay: 1 }, [], NOW);
  assert.equal(a.fiveHour, Math.round(((700_000 / 8) * 1.5) / 1000) * 1000);
  const heavy = analyzeLimits({ unit: "tokens", monthly: 3_000_000, monthStartDay: 1 }, [
    // one work window a week: it can use 4, the floor, but the cap of half the week still holds
    rec(NOW - 20 * 24 * H, 1), rec(NOW - 13 * 24 * H, 1), rec(NOW - 6 * 24 * H, 1),
  ], NOW);
  assert.ok(heavy.fiveHour <= heavy.weekly * 0.5 + 1000);
});

test("how you actually work sets the window: many short sessions get smaller windows than a few long ones", () => {
  const busy: ReturnType<typeof rec>[] = [];
  for (let d = 0; d < 28; d++) for (const h of [9, 15]) busy.push(rec(NOW - d * 24 * H - h * H + 12 * H, 1)); // two windows a day
  const calm: ReturnType<typeof rec>[] = [];
  for (let d = 0; d < 28; d += 3) calm.push(rec(NOW - d * 24 * H, 1)); // a window every third day
  const inp = { unit: "tokens", monthly: 3_000_000, monthStartDay: 1 } as const;
  const b = analyzeLimits(inp, busy, NOW);
  const c = analyzeLimits(inp, calm, NOW);
  assert.ok(b.windowsPerWeek > c.windowsPerWeek);
  assert.ok(b.fiveHour < c.fiveHour, "more windows a week means each one is worth less");
  assert.ok(b.basedOnDays > 0);
});

test("money is rounded to cents and tokens to thousands", () => {
  const usd = analyzeLimits({ unit: "usd", monthly: 20, monthStartDay: 1 }, [], NOW);
  assert.equal(usd.weekly, Math.round(((20 * 7) / 30) * 100) / 100);
  const tok = analyzeLimits({ unit: "tokens", monthly: 1_234_567, monthStartDay: 1 }, [], NOW);
  assert.equal(tok.weekly % 1000, 0);
});

// ── settings and history ─────────────────────────────────────────────────────

test("garbage in the settings file never gets through", () => {
  const c = sanitizeLimits({ enabled: "yes", unit: "euros", monthly: -5, monthStartDay: 99, fiveHour: "abc", weekly: 12.6, enforce: 0 });
  assert.equal(c.enabled, false);
  assert.equal(c.unit, "tokens");
  assert.equal(c.monthly, 0);
  assert.equal(c.monthStartDay, 28);
  assert.equal(c.fiveHour, 0);
  assert.equal(c.weekly, 13);
  assert.equal(c.enforce, true, "only an explicit false turns enforcing off");
});

test("settings are saved, read back, and switched off when there is nothing to track", async () => {
  await saveLimits({ enabled: true, unit: "usd", monthly: 20, fiveHour: 1.5, weekly: 5 });
  const read = await readLimitsConfig();
  assert.equal(read.unit, "usd");
  assert.equal(read.monthly, 20);
  assert.equal(read.enabled, true);
  const empty = await saveLimits({ monthly: 0, fiveHour: 0, weekly: 0 });
  assert.equal(empty.enabled, false, "no amounts means off");
});

test("new use is counted while limits are on, and ignored while they are off", () => {
  setLedgerForTests([], cfg());
  noteUsage("m", { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cacheHitTokens: 0, cacheMissTokens: 1000 }, NOW - 1000);
  assert.equal(computeStatus(currentLimits(), [], NOW).windows.length, 3);
  setLedgerForTests([], cfg({ enabled: false }));
  noteUsage("m", { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cacheHitTokens: 0, cacheMissTokens: 1000 }, NOW - 1000);
  assert.equal(limitGateReason(NOW), null);
});

test("a call costs its fresh input plus its output in tokens, and each at its own rate in money", () => {
  process.env.MINDWEAVE_PRICE = "0.1,1,4"; // per million: cache hit, fresh input, output
  try {
    const c = callAmount("any", 5_000_000, 1_000_000, 250_000);
    assert.equal(c.tokens, 1_250_000, "cache hits are not billed tokens");
    assert.ok(Math.abs(c.usd - (0.5 + 1 + 1)) < 1e-9);
  } finally {
    delete process.env.MINDWEAVE_PRICE;
  }
});

test("waits read the way a person would say them", () => {
  assert.equal(formatWait(40 * 60_000), "40m");
  assert.equal(formatWait(2 * H + 10 * 60_000), "2h 10m");
  assert.equal(formatWait(3 * 24 * H + 4 * H), "3d 4h");
  assert.match(blockReason(computeStatus(cfg(), [rec(NOW - H, 100_000)], NOW))!, /used up \(100K tokens of 100K tokens\)/);
});

// ── the weekly reset is fixed, like a plan's ─────────────────────────────────

const week = (over: Partial<LimitsConfig>) => cfg({ fiveHour: 0, monthly: 0, weekly: 100_000, ...over });

test("the week resets at the same moment every week, whenever you use the tool", () => {
  const A = new Date(2026, 8, 4, 20, 13).getTime(); // the reset moment: a Friday evening
  const at = (weeks: number, plus = 0) => A + weeks * WEEK_MS + plus;
  for (const k of [0, 1, 2, 5, 9]) {
    const s = computeStatus(week({ weeklyResetAt: A }), [], at(k, 3 * 24 * H));
    const w = s.windows[0]!;
    assert.equal(w.start, at(k), `week ${k} began at the reset moment`);
    assert.equal(w.end, at(k + 1), `and ends exactly a week later`);
  }
  // the moment before and after a reset land in different weeks
  assert.equal(computeStatus(week({ weeklyResetAt: A }), [], at(3, -1)).windows[0]!.start, at(2));
  assert.equal(computeStatus(week({ weeklyResetAt: A }), [], at(3)).windows[0]!.start, at(3));
});

test("use before the reset does not count toward the new week, and use after it does", () => {
  const A = NOW - 10 * 24 * H; // weeks begin at A, A+7d: NOW is 3 days into the second week
  const recs = [rec(A + 6 * 24 * H, 80_000), rec(A + 8 * 24 * H, 30_000), rec(NOW - H, 20_000)];
  const w = computeStatus(week({ weeklyResetAt: A }), recs, NOW).windows[0]!;
  assert.equal(w.used, 50_000, "only the new week's use");
  assert.equal(w.end, A + 14 * 24 * H);
});

test("a spent week reopens at the reset moment, not seven days after the last message", () => {
  const A = NOW - 10 * 24 * H;
  const s = computeStatus(week({ weeklyResetAt: A, weekly: 50_000 }), [rec(NOW - H, 60_000)], NOW);
  assert.equal(s.blocked?.end, A + 14 * 24 * H);
  const after = computeStatus(week({ weeklyResetAt: A, weekly: 50_000 }), [rec(NOW - H, 60_000)], A + 14 * 24 * H);
  assert.equal(after.blocked, null, "the moment the week turns over, work is possible again");
  assert.equal(after.windows[0]!.used, 0);
});

test("the week never depends on how much history is in view", () => {
  const A = NOW - 10 * 24 * H;
  const all = [rec(NOW - 40 * 24 * H, 9), rec(NOW - 20 * 24 * H, 9), rec(NOW - 5 * 24 * H, 40_000), rec(NOW - H, 10_000)];
  const a = computeStatus(week({ weeklyResetAt: A }), all, NOW).windows[0]!;
  const b = computeStatus(week({ weeklyResetAt: A }), all.slice(2), NOW).windows[0]!;
  assert.deepEqual([a.start, a.end, a.used], [b.start, b.end, b.used]);
});

test("turning limits on sets the week's reset once, and later saves leave it alone", async () => {
  const first = await saveLimits({ enabled: true, monthly: 900_000, weekly: 200_000, fiveHour: 50_000 });
  assert.ok(first.weeklyResetAt && Math.abs(first.weeklyResetAt - Date.now()) < 5_000);
  await new Promise((r) => setTimeout(r, 20));
  const again = await saveLimits({ weekly: 250_000 });
  assert.equal(again.weeklyResetAt, first.weeklyResetAt, "editing the numbers does not move the reset");
  assert.equal((await readLimitsConfig()).weeklyResetAt, first.weeklyResetAt, "and it survives a restart");
});

// ── the 5-hour session keeps its start ───────────────────────────────────────

test("a 5-hour session's boundaries do not move when old history ages out of view", () => {
  // nonstop use: a call every 4h for 40 days, so the chain never gets a gap to re-anchor on
  const calls: ReturnType<typeof rec>[] = [];
  for (let t = NOW - 40 * 24 * H; t <= NOW; t += 4 * H) calls.push(rec(t, 1000));
  const seed = NOW - 3 * H;
  const full = computeStatus(cfg({ weekly: 0, monthly: 0 }), calls, NOW, seed).windows[0]!;
  const trimmed = computeStatus(cfg({ weekly: 0, monthly: 0 }), calls.slice(30), NOW, seed).windows[0]!;
  assert.deepEqual([full.start, full.end, full.used], [trimmed.start, trimmed.end, trimmed.used]);
  assert.equal(full.start, seed);
});

test("turning limits on mid-session keeps the hours already used: the next call does not start a fresh window", async () => {
  // A saved session used 90K tokens an hour ago. Limits are then switched on and one more call lands.
  const dir = join(process.env.MINDWEAVE_STATE_DIR!, "projects", "p1");
  mkdirSync(dir, { recursive: true });
  const at = Date.now() - H;
  writeFileSync(join(dir, "s1.meta.json"), JSON.stringify({
    id: "s1", cwd: "c:/p", entryCount: 1, updatedAt: at, model: "m", spend: { billed: 90_000, output: 0 },
    callLog: [{ at, prompt: 90_000, hit: 0, miss: 90_000, out: 0, model: "m" }],
  }));
  await saveLimits({ enabled: true, fiveHour: 100_000 });
  noteUsage("m", { promptTokens: 20_000, completionTokens: 0, totalTokens: 20_000, cacheHitTokens: 0, cacheMissTokens: 20_000 });
  const w = computeStatus(currentLimits(), [], Date.now()).windows.length; // config is live
  assert.equal(w, 1);
  assert.match(limitGateReason()!, /5-hour limit is used up \(110K tokens of 100K tokens\)/);
});

// ── the month rolls over correctly ───────────────────────────────────────────

test("the billing month crosses the new year and short months without slipping", () => {
  const jan5 = new Date(2027, 0, 5, 9).getTime();
  const m = billingMonth(jan5, 20); // before the 20th: still the month that began 20 Dec
  assert.deepEqual([new Date(m.start).getFullYear(), new Date(m.start).getMonth(), new Date(m.start).getDate()], [2026, 11, 20]);
  assert.deepEqual([new Date(m.end).getFullYear(), new Date(m.end).getMonth(), new Date(m.end).getDate()], [2027, 0, 20]);
  const feb = billingMonth(new Date(2027, 1, 28, 12).getTime(), 28); // the 28th exists in every month
  assert.equal(new Date(feb.start).getDate(), 28);
  assert.equal(new Date(feb.end).getMonth(), 2);
  // day 1: a plain calendar month, and a use at the last second of it belongs to it, not the next
  const sep = billingMonth(new Date(2026, 8, 30, 23, 59, 59).getTime(), 1);
  assert.equal(new Date(sep.start).getMonth(), 8);
  assert.equal(new Date(sep.end).getMonth(), 9);
  assert.equal(new Date(sep.end).getDate(), 1);
});

test("the very moment a month turns over, the new one starts empty", () => {
  const boundary = new Date(2026, 9, 1, 0, 0, 0).getTime();
  const s = computeStatus(cfg({ monthly: 500_000, fiveHour: 0, weekly: 0 }), [rec(boundary - 1, 400_000), rec(boundary + 5, 7_000)], boundary + 10);
  assert.equal(s.windows[0]!.used, 7_000);
});
