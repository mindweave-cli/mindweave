/**
 * analytics.test.ts — the optional daily count.
 *
 * What is pinned here is who is NOT counted and what never leaves. A count that includes tests, scratch folders and dev
 * builds reads as users that do not exist (an earlier version showed about 200 "people" that way), and a message that
 * carries more than it says is worse than no count at all.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyticsEnabled,
  analyticsLine,
  blockedReason,
  buildPayload,
  canOfferHistory,
  forgetFailure,
  historyPending,
  previewPayload,
  publicModel,
  resetAnalyticsId,
  sendDailyCount,
  setAnalyticsEnabled,
  setShareHistory,
  usageForDay,
} from "./analytics.js";
import type { SessionMeta } from "../memory/types.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const YESTERDAY = Date.parse("2026-11-05T09:00:00Z");
const root = () => realpathSync(mkdtempSync(join(tmpdir(), "mw-analytics-")));
/** A real place: no moved state folder, no CI, an installed copy. */
const REAL: NodeJS.ProcessEnv = {};

function meta(id: string, calls: { at: number; model: string; hit?: number; miss?: number; out?: number; aux?: string }[]): SessionMeta {
  return {
    id,
    cwd: "C:\\Users\\someone\\secret-project",
    createdAt: calls[0]!.at,
    updatedAt: calls[0]!.at,
    firstPrompt: "please fix the login for acme-corp",
    lastPrompt: "and the tests",
    entryCount: 3,
    callLog: calls.map((c) => ({ at: c.at, model: c.model, hit: c.hit ?? 0, miss: c.miss ?? 0, out: c.out ?? 0, ...(c.aux ? { aux: c.aux } : {}) })),
  } as unknown as SessionMeta;
}

beforeEach(() => forgetFailure());

// ── who is not counted ───────────────────────────────────────────────────────

test("a moved state folder, CI, a test run, a checkout and a switch each stop a count", () => {
  assert.equal(blockedReason(REAL, "global"), null);
  assert.equal(blockedReason(REAL, "managed"), null);
  assert.equal(blockedReason(REAL, "app"), null);
  assert.match(blockedReason({ MINDWEAVE_STATE_DIR: "C:\\scratch" }, "global") ?? "", /state folder was moved/);
  assert.match(blockedReason({ CI: "true" }, "global") ?? "", /CI/);
  assert.match(blockedReason({ GITHUB_ACTIONS: "true" }, "global") ?? "", /CI/);
  assert.match(blockedReason({ NODE_ENV: "test" }, "global") ?? "", /test/);
  assert.match(blockedReason({ MINDWEAVE_NO_ANALYTICS: "1" }, "global") ?? "", /MINDWEAVE_NO_ANALYTICS/);
  for (const kind of ["source", "local", "unknown", undefined]) assert.ok(blockedReason(REAL, kind), String(kind));
});

test("it is on unless the person turned it off here, whatever an older version saved", () => {
  const dir = root();
  assert.equal(analyticsEnabled(dir), true, "the default");
  assert.equal(setAnalyticsEnabled(false, dir), false);
  assert.equal(analyticsEnabled(dir), false);
  assert.equal(setAnalyticsEnabled(true, dir), true);
  assert.equal(analyticsEnabled(dir), true);
  const old = root();
  writeFileSync(join(old, "analytics.json"), JSON.stringify({ enabled: false, id: "old-id-that-chose-off" }));
  assert.equal(analyticsEnabled(old), true, "an older version's saved off was about a different count; this one is on until it is turned off with /data");
  const older = root();
  writeFileSync(join(older, "analytics.json"), JSON.stringify({ enabled: true, id: "old-id-on-by-default" }));
  assert.equal(analyticsEnabled(older), true);
});

test("nothing is sent while it is off, or from a place that is not an install", async () => {
  const dir = root();
  let calls = 0;
  const fetchImpl = (async () => (calls++, new Response(null, { status: 204 }))) as typeof fetch;
  setAnalyticsEnabled(false, dir);
  assert.equal(await sendDailyCount({ root: dir, now: NOW, env: REAL, installKind: "global", fetchImpl, metas: [] }), "off");
  setAnalyticsEnabled(true, dir);
  assert.equal(await sendDailyCount({ root: dir, now: NOW, env: { MINDWEAVE_STATE_DIR: dir }, installKind: "global", fetchImpl, metas: [] }), "blocked");
  assert.equal(await sendDailyCount({ root: dir, now: NOW, env: REAL, installKind: "source", fetchImpl, metas: [] }), "blocked");
  assert.equal(calls, 0, "no request left the machine");
});

// ── what is sent ─────────────────────────────────────────────────────────────

test("a day's use is summed per model: fresh input, cached input, output, calls, sessions and cost", () => {
  const m1 = meta("s1", [
    { at: YESTERDAY, model: "claude-sonnet-5-5", hit: 8000, miss: 2000, out: 500 },
    { at: YESTERDAY + 1000, model: "claude-sonnet-5-5", hit: 9000, miss: 1000, out: 300 },
  ]);
  const m2 = meta("s2", [{ at: YESTERDAY, model: "claude-sonnet-5-5", hit: 1000, miss: 0, out: 10 }, { at: YESTERDAY - 3 * 86400000, model: "claude-sonnet-5-5", miss: 99999 }]);
  const [use] = usageForDay([m1, m2], "2026-11-05");
  assert.ok(use);
  assert.deepEqual({ p: use.p, m: use.m, i: use.i, c: use.c, o: use.o, n: use.n, s: use.s }, { p: "anthropic", m: "claude-sonnet-5-5", i: 3000, c: 18000, o: 810, n: 3, s: 2 });
  assert.ok(use.$ > 0, "a cost at the list price");
  assert.equal(use.pr?.length, 3, "and the list price it used");
});

test("a built-in model is sent with the name Mindweave lists it by, and its provider's name", () => {
  const name = publicModel("claude-sonnet-5-5");
  assert.ok(name.l && name.l.length > 0, "a model name");
  assert.ok(name.pn && name.pn.length > 0, "a provider name");
  assert.equal(publicModel("acme-internal-llm-v3").l, undefined, "and a private model has neither");
});

test("a model that is not built in is sent as other, so a private name never leaves", () => {
  assert.deepEqual({ p: publicModel("claude-sonnet-5-5").p, m: publicModel("claude-sonnet-5-5").m }, { p: "anthropic", m: "claude-sonnet-5-5" });
  assert.deepEqual(publicModel("acme-internal-llm-v3"), { p: "other", m: "other" });
  assert.deepEqual(publicModel("llama4:scout-finetune-for-acme"), { p: "other", m: "other" });
  const [use] = usageForDay([meta("s", [{ at: YESTERDAY, model: "acme-internal-llm-v3", miss: 5 }])], "2026-11-05");
  assert.deepEqual({ p: use!.p, m: use!.m }, { p: "other", m: "other" });
  assert.equal(use!.pr, undefined, "no price is claimed for a model nobody can name");
});

test("the message holds no prompt, no path, no project and nothing the person typed", () => {
  const metas = [meta("s1", [{ at: YESTERDAY, model: "acme-internal-llm-v3", hit: 1, miss: 1, out: 1 }])];
  const text = JSON.stringify(buildPayload({ metas, now: NOW, id: "11111111-2222", version: "3.4.5", platform: "win32" }));
  for (const leak of ["secret-project", "acme", "someone", "login", "C:\\", "tests"]) assert.equal(text.includes(leak), false, leak);
  const p = JSON.parse(text);
  assert.deepEqual(Object.keys(p).sort(), ["day", "id", "os", "usage", "v", "version"]);
});

test("the message is the documented shape, for yesterday and the day before, and omits an empty usage", () => {
  const p = buildPayload({ metas: [meta("s", [{ at: YESTERDAY, model: "claude-sonnet-5-5", miss: 5 }])], now: NOW, id: "11111111-2222", version: "3.4.5", platform: "darwin" });
  assert.equal(p.v, 1);
  assert.equal(p.day, "2026-11-06");
  assert.equal(p.os, "darwin");
  assert.deepEqual(p.usage?.map((u) => u.day), ["2026-11-05"]);
  assert.equal(buildPayload({ metas: [], now: NOW, id: "11111111-2222" }).usage, undefined);
  assert.equal(buildPayload({ metas: [], now: NOW, id: "11111111-2222", platform: "freebsd" }).os, "other");
});

// ── sending ──────────────────────────────────────────────────────────────────

test("when on, one count goes out a day, with the id made at that moment and kept", async () => {
  const dir = root();
  setAnalyticsEnabled(true, dir, NOW);
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => (bodies.push(String(init.body)), new Response(null, { status: 204 }))) as unknown as typeof fetch;
  const metas = [meta("s", [{ at: YESTERDAY, model: "claude-sonnet-5-5", hit: 1, miss: 1, out: 1 }])];
  const go = (now: number) => sendDailyCount({ root: dir, now, env: REAL, installKind: "global", fetchImpl, metas });

  assert.equal(await go(NOW), "sent");
  assert.equal(await go(NOW + 3600_000), "already-today", "a second turn the same day sends nothing");
  assert.equal(bodies.length, 1);
  const sent = JSON.parse(bodies[0]!);
  const saved = JSON.parse(readFileSync(join(dir, "analytics.json"), "utf8"));
  assert.equal(sent.id, saved.id, "the id that was sent is the id that is kept");
  assert.equal(saved.sentDay, "2026-11-06");
  assert.equal(await go(NOW + 86400_000), "sent", "and again the next day");
  assert.equal(JSON.parse(bodies[1]!).id, sent.id, "under the same id");
});

test("a server that is down costs one quiet failure, then a wait, and the count is still owed", async () => {
  const dir = root();
  setAnalyticsEnabled(true, dir, NOW);
  let calls = 0;
  const down = (async () => (calls++, new Response("no", { status: 503 }))) as typeof fetch;
  const args = { root: dir, now: NOW, env: REAL, installKind: "global", fetchImpl: down, metas: [] as SessionMeta[] };
  assert.equal(await sendDailyCount(args), "failed");
  assert.equal(await sendDailyCount({ ...args, now: NOW + 1000 }), "wait");
  assert.equal(calls, 1, "not asked again after every turn");
  assert.equal(JSON.parse(readFileSync(join(dir, "analytics.json"), "utf8")).sentDay, undefined, "not marked as sent");
  const thrown = (async () => { throw new Error("offline"); }) as typeof fetch;
  forgetFailure();
  assert.equal(await sendDailyCount({ ...args, fetchImpl: thrown }), "failed", "an offline machine never throws");
});

test("what /data shows is what would be sent", async () => {
  const dir = root();
  const metas = [meta("s", [{ at: YESTERDAY, model: "claude-sonnet-5-5", hit: 4, miss: 2, out: 1 }])];
  const shown = await previewPayload({ root: dir, now: NOW, metas });
  assert.match(shown.id, /made when the first count is sent/);
  setAnalyticsEnabled(true, dir, NOW);
  let body = "";
  const fetchImpl = (async (_u: string, init: RequestInit) => (body = String(init.body), new Response(null, { status: 204 }))) as unknown as typeof fetch;
  await sendDailyCount({ root: dir, now: NOW, env: REAL, installKind: "global", fetchImpl, metas });
  const sent = JSON.parse(body);
  assert.deepEqual({ ...sent, id: "x" }, { ...shown, id: "x" }, "the same builder: only the id differs while none exists");
  const again = await previewPayload({ root: dir, now: NOW, metas });
  assert.equal(again.id, sent.id, "once there is an id, the preview shows it");
});

test("resetting gives a new id and forgets what was sent", async () => {
  const dir = root();
  setAnalyticsEnabled(true, dir, NOW);
  const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;
  await sendDailyCount({ root: dir, now: NOW, env: REAL, installKind: "global", fetchImpl, metas: [] });
  const before = JSON.parse(readFileSync(join(dir, "analytics.json"), "utf8"));
  resetAnalyticsId(dir);
  const after = JSON.parse(readFileSync(join(dir, "analytics.json"), "utf8"));
  assert.equal(after.id, undefined);
  assert.equal(after.sentDay, undefined);
  assert.ok(before.id);
  assert.equal(analyticsEnabled(dir), true, "the choice is kept");
  setAnalyticsEnabled(false, dir);
  resetAnalyticsId(dir);
  assert.equal(analyticsEnabled(dir), false, "and an off stays off after starting over");
});

// ── what is said ─────────────────────────────────────────────────────────────

test("the line shown at every start says whether it is on, and is silent where nothing is counted", () => {
  const dir = root();
  const on = analyticsLine(REAL, "global", dir) ?? "";
  assert.match(on, /^Data is on\. It shares one small daily count of tokens by model, and your last 60 days of usage once, so everyone can see which models perform best and which gets the best cache hit rate\./, "the default says the past goes too");
  assert.match(on, /We never see your chats, your files or what your project is\. Only the counts\./);
  assert.match(on, /See the numbers: https:\/\/mindweavedev\.netlify\.app\/data/);
  assert.match(on, /See how it is sent: https:\/\/github\.com\/mindweave-cli\/Mindweave\/blob\/main\/src\/cli\/analytics\.ts/);
  assert.match(on, /Turn off the past data, or all of it, with \/data\./);
  setShareHistory(false, dir);
  const noPast = analyticsLine(REAL, "global", dir) ?? "";
  assert.match(noPast, /^Data is on\. It shares one small daily count of tokens by model, so everyone/, "turned off: no mention of the past");
  assert.equal(noPast.includes("60 days"), false);
  assert.match(noPast, /Turn it off any time with \/data\./);
  setShareHistory(true, dir);
  setAnalyticsEnabled(false, dir);
  assert.match(analyticsLine(REAL, "global", dir) ?? "", /^Data is off\. \/data to turn it on: .*https:\/\/mindweavedev\.netlify\.app\/data$/);
  setAnalyticsEnabled(true, dir);
  assert.equal(analyticsLine(REAL, "source", dir), null);
  assert.equal(analyticsLine({ CI: "1" }, "global", dir), null);
  mkdirSync(dir, { recursive: true });
});

// ── the past, shared once when the person chooses it ─────────────────────────

test("with the past included, every day of use in the last 60 is sent, and the days that were real work", () => {
  const at = (back: number) => NOW - back * 86400_000;
  const metas = [
    meta("s1", [{ at: at(1), model: "claude-sonnet-5-5", miss: 5 }, { at: at(30), model: "claude-sonnet-5-5", miss: 7 }, { at: at(59), model: "claude-sonnet-5-5", miss: 9 }, { at: at(70), model: "claude-sonnet-5-5", miss: 99 }]),
    meta("s2", [{ at: at(10), model: "claude-sonnet-5-5", miss: 3, aux: "notes" }]),
  ];
  const p = buildPayload({ metas, now: NOW, id: "11111111-2222", version: "3.4.5", platform: "win32", history: true });
  assert.deepEqual(p.usage?.map((u) => u.day).sort(), [utcOf(at(59)), utcOf(at(30)), utcOf(at(10)), utcOf(at(1))].sort(), "70 days back is outside the window");
  assert.deepEqual(p.active?.slice().sort(), [utcOf(at(59)), utcOf(at(30)), utcOf(at(1))].sort(), "a day of background work only (notes nobody asked for) is not a day of use");
  const plain = buildPayload({ metas, now: NOW, id: "11111111-2222", version: "3.4.5", platform: "win32" });
  assert.equal(plain.active, undefined, "without the choice, only the last two days and no list of days");
  assert.ok((plain.usage?.length ?? 0) <= 2);
});

function utcOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

test("the past goes out once with the first count, unless the person turned it off", async () => {
  const dir = root();
  const metas = [meta("s", [{ at: NOW - 5 * 86400_000, model: "claude-sonnet-5-5", miss: 5 }])];
  const bodies: string[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), new Response(null, { status: 204 }))) as unknown as typeof fetch;
  const go = (now: number) => sendDailyCount({ root: dir, now, env: REAL, installKind: "global", fetchImpl, metas });

  assert.equal(historyPending(dir), true, "the default: the past is still to go");
  assert.equal((await previewPayload({ root: dir, now: NOW, metas })).active?.length, 1, "what /data shows includes it");
  await go(NOW);
  assert.equal(JSON.parse(bodies[0]!).active.length, 1, "sent with the first count");
  assert.equal(historyPending(dir), false, "and now it is done");
  await go(NOW + 86400_000);
  assert.equal(JSON.parse(bodies[1]!).active, undefined, "never again");

  const other = root();
  setShareHistory(false, other);
  assert.equal(historyPending(other), false, "turned off: nothing of the past is pending");
  assert.equal(canOfferHistory(other), true, "and it can be turned back on");
  await sendDailyCount({ root: other, now: NOW, env: REAL, installKind: "global", fetchImpl, metas });
  assert.equal(JSON.parse(bodies[2]!).active, undefined, "so the first count carries no past");
  setShareHistory(true, other);
  assert.equal(historyPending(other), true);

  const off = root();
  setAnalyticsEnabled(false, off);
  assert.equal(historyPending(off), false, "with the whole count off, nothing is pending either");
});

test("starting over with a new id makes the past owed again, since it was sent under the old id", async () => {
  const dir = root();
  setAnalyticsEnabled(true, dir, NOW);
  setShareHistory(true, dir);
  const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;
  await sendDailyCount({ root: dir, now: NOW, env: REAL, installKind: "global", fetchImpl, metas: [] });
  assert.equal(historyPending(dir), false);
  resetAnalyticsId(dir);
  assert.equal(historyPending(dir), true);
});
