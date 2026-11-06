/**
 * dataView.test.ts — the words of /data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dataSummary, describePayload } from "./dataView.js";
import { ANALYTICS_EXPLANATION, DATA_PAGE_URL, PLACEHOLDER_ID, type Payload } from "./analytics.js";
import type { SpendView } from "../core/spendView.js";

const spend = (over: Partial<SpendView> = {}): SpendView => ({
  totalBilled: 5_000_000,
  totalOutput: 1_000_000,
  byModel: [
    { model: "claude-sonnet-5-5", billed: 3_000_000, output: 600_000, calls: 120 },
    { model: "deepseek-flash", billed: 1_500_000, output: 300_000, calls: 80 },
    { model: "gpt-6.1-terra", billed: 400_000, output: 80_000, calls: 20 },
  ],
  daily: [{ key: "2026-11-04", billed: 1_000_000 }, { key: "2026-11-05", billed: 2_000_000 }],
  weekly: [],
  monthly: [],
  sessionsScanned: 12,
  projectsScanned: 3,
  background: { billed: 0, calls: 0 },
  ...over,
});

test("it shows the person's own usage and the top two models", () => {
  const text = dataSummary(spend(), { on: false, blocked: null });
  assert.match(text, /Your usage: 3\.0M tokens in 7 days, 5\.0M in all \(12 sessions, 3 projects\)/);
  assert.match(text, /Top models: claude-sonnet-5-5 3\.0M · deepseek-flash 1\.5M/);
  assert.equal(text.includes("gpt-6.1"), false, "only the top two");
});

test("it says plainly whether anything is sent, and fits the box it sits in", () => {
  assert.match(dataSummary(spend(), { on: false, blocked: null }), /Daily count: OFF\. Nothing is sent\./);
  assert.match(dataSummary(spend(), { on: true, blocked: null }), /Daily count: ON\./);
  assert.match(dataSummary(spend(), { on: true, blocked: "this is a CI run" }), /Not sent from here: this is a CI run\./);
  // The box shows a few lines and cuts the rest, and the line that says whether anything is sent must never be what is cut.
  for (const on of [false, true]) {
    const lines = dataSummary(spend(), { on, blocked: on ? "this is a CI run" : null }).split("\n");
    assert.ok(lines.length <= 4, `${lines.length} lines`);
    for (const l of lines) assert.ok(l.length <= 90, `a line of ${l.length} characters wraps in a narrow window`);
  }
});

test("with nothing recorded it says so", () => {
  const text = dataSummary(spend({ totalBilled: 0, byModel: [], daily: [] }), { on: false, blocked: null });
  assert.match(text, /nothing recorded yet/);
  assert.match(text, /Daily count: OFF/);
  assert.match(dataSummary(null, { on: false, blocked: null }), /nothing recorded yet/);
});

const payload = (over: Partial<Payload> = {}): Payload => ({
  v: 1,
  id: PLACEHOLDER_ID,
  version: "3.4.5",
  os: "win32",
  day: "2026-11-06",
  usage: [{ day: "2026-11-05", models: [{ p: "deepseek", m: "deepseek-flash", i: 12_300, c: 80_100, o: 2_100, n: 14, s: 2, $: 0.0234 }] }],
  ...over,
});

test("the message reads as plain lines, with where it is shown and the exact message", () => {
  const text = describePayload(payload());
  assert.match(text, /Nothing is sent while sharing is off/);
  assert.match(text, /id        random, made when the first count is sent/);
  assert.match(text, /from      Mindweave 3\.4\.5 on win32, 2026-11-06/);
  assert.match(text, /usage     1 day, 1 model/);
  assert.match(text, /2026-11-05  deepseek-flash: 12\.3K in, 80\.1K cached, 2\.1K out, 14 calls, \$0\.02/);
  assert.ok(text.includes(`Shown for everyone at ${DATA_PAGE_URL}`));
  assert.match(text, /Exactly as sent: \{"v":1,/);
});

test("a long message (a person's past) says its size instead of printing a wall of text", () => {
  const days = Array.from({ length: 60 }, (_, n) => ({ day: `2026-09-${String((n % 28) + 1).padStart(2, "0")}`, models: [payload().usage![0]!.models[0]!, { ...payload().usage![0]!.models[0]!, m: "glm-5.3" }] }));
  const text = describePayload(payload({ id: "11111111-2222", usage: days, active: days.map((d) => d.day) }));
  assert.match(text, /usage     60 days, 2 models/);
  assert.match(text, /and 56 more days/);
  assert.match(text, /past      60 days of work/);
  assert.match(text, /Exactly as sent: the same fields for each day, [\d.]+ KB in all\./);
  assert.equal(text.includes('{"v":1'), false);
  assert.ok(text.split("\n").length < 30);
});

test("the explanation names the page the numbers are shown on, and what for", () => {
  assert.ok(ANALYTICS_EXPLANATION.includes(DATA_PAGE_URL));
  assert.match(ANALYTICS_EXPLANATION, /which model is the best at the moment/);
  assert.match(ANALYTICS_EXPLANATION, /Never sent: a prompt, a reply, a file, a path, a project name or a key\./);
  for (const line of ANALYTICS_EXPLANATION.split("\n")) assert.ok(line.length <= 260, "a line too long to read in a terminal");
});
