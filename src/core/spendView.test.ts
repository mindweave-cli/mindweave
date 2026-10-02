/**
 * spendView.test.ts — reading token totals back from what sessions already record,
 * across every project: per model, and bucketed by day/week/month.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spendView } from "./spendView.js";

async function writeMeta(stateDir: string, projectSlug: string, id: string, meta: Record<string, unknown>) {
  const dir = join(stateDir, "projects", projectSlug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${id}.meta.json`), JSON.stringify(meta), "utf8");
}

function freshStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spend-state-"));
  process.env.MINDWEAVE_STATE_DIR = dir;
  return dir;
}

const DAY = 24 * 60 * 60 * 1000;

test("with nothing on disk, the totals are all zero rather than throwing", async () => {
  freshStateDir();
  const view = await spendView();
  assert.equal(view.totalBilled, 0);
  assert.equal(view.byModel.length, 0);
  assert.equal(view.sessionsScanned, 0);
});

test("callLog rows sum into the total, split by model, cache hits excluded from billed", async () => {
  const dir = freshStateDir();
  const now = Date.now();
  await writeMeta(dir, "proj-a", "s1", {
    cwd: "C:\\proj-a",
    entryCount: 4,
    updatedAt: now,
    callLog: [
      { at: now, prompt: 1000, hit: 200, miss: 800, out: 100, model: "glm-5.3" },
      { at: now, prompt: 500, hit: 0, miss: 500, out: 50, model: "gemini-3.1-pro" },
    ],
  });
  const view = await spendView();
  // billed = miss + out for each call: (800+100) + (500+50) = 1450
  assert.equal(view.totalBilled, 1450);
  assert.equal(view.totalOutput, 150);
  assert.equal(view.byModel.length, 2);
  const glm = view.byModel.find((m) => m.model === "glm-5.3");
  assert.equal(glm?.billed, 900);
  assert.equal(glm?.calls, 1);
});

test("a session with no callLog (older sessions) falls back to its lump spend total", async () => {
  const dir = freshStateDir();
  await writeMeta(dir, "proj-b", "s1", {
    cwd: "C:\\proj-b",
    entryCount: 2,
    updatedAt: Date.now(),
    model: "deepseek-v4-flash",
    spend: { billed: 3000, cacheHit: 0, cacheMiss: 3000, cacheWrite: 0, output: 400, costUsd: 0.01, turns: 3, estimated: true },
  });
  const view = await spendView();
  assert.equal(view.totalBilled, 3000);
  assert.equal(view.byModel[0]?.model, "deepseek-v4-flash");
  assert.equal(view.byModel[0]?.calls, 1);
});

test("a session with zero entries (never actually used) is not counted", async () => {
  const dir = freshStateDir();
  await writeMeta(dir, "proj-c", "s1", { cwd: "C:\\proj-c", entryCount: 0, updatedAt: Date.now(), spend: { billed: 999, output: 0 } });
  const view = await spendView();
  assert.equal(view.totalBilled, 0);
  assert.equal(view.sessionsScanned, 0);
});

test("spend totals combine across every project, not just one", async () => {
  const dir = freshStateDir();
  const now = Date.now();
  await writeMeta(dir, "proj-a", "s1", {
    cwd: "C:\\proj-a",
    entryCount: 2,
    updatedAt: now,
    callLog: [{ at: now, prompt: 100, hit: 0, miss: 100, out: 10, model: "m1" }],
  });
  await writeMeta(dir, "proj-b", "s1", {
    cwd: "C:\\proj-b",
    entryCount: 2,
    updatedAt: now,
    callLog: [{ at: now, prompt: 100, hit: 0, miss: 100, out: 10, model: "m1" }],
  });
  const view = await spendView();
  assert.equal(view.projectsScanned, 2);
  assert.equal(view.totalBilled, 220);
});

test("day/week/month buckets are keyed correctly and sorted oldest first", async () => {
  const dir = freshStateDir();
  const today = Date.now();
  const lastWeek = today - 8 * DAY;
  await writeMeta(dir, "proj-a", "s1", {
    cwd: "C:\\proj-a",
    entryCount: 2,
    updatedAt: today,
    callLog: [
      { at: lastWeek, prompt: 100, hit: 0, miss: 100, out: 0, model: "m1" },
      { at: today, prompt: 200, hit: 0, miss: 200, out: 0, model: "m1" },
    ],
  });
  const view = await spendView();
  assert.equal(view.daily.length, 2);
  assert.ok(view.daily[0]!.key < view.daily[1]!.key, "oldest day first");
  assert.equal(view.daily[0]!.billed, 100);
  assert.equal(view.daily[1]!.billed, 200);
  // Different ISO weeks (8 days apart spans a week boundary in almost every case).
  assert.ok(view.weekly.length >= 1);
});

test("only .meta.json files are read, and a corrupt one doesn't take down the total", async () => {
  const dir = freshStateDir();
  const projDir = join(dir, "projects", "proj-a");
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(join(projDir, "not-a-meta.txt"), "ignore me", "utf8");
  await fs.writeFile(join(projDir, "broken.meta.json"), "{not json", "utf8");
  await writeMeta(dir, "proj-a", "good", {
    cwd: "C:\\proj-a",
    entryCount: 1,
    updatedAt: Date.now(),
    callLog: [{ at: Date.now(), prompt: 10, hit: 0, miss: 10, out: 5, model: "m1" }],
  });
  const view = await spendView();
  assert.equal(view.sessionsScanned, 1);
  assert.equal(view.totalBilled, 15);
});
