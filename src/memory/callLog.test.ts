/**
 * callLog.test.ts — the per-call usage record survives to disk.
 *
 * This exists because a session total cannot answer the only question anyone asks about
 * a bill. "That turn billed 36K" is equally true of one call carrying 36K and six calls
 * carrying 11K each with a provider caching 40%, and those have nothing in common except
 * the total. The breakdown is the difference between diagnosing a session and guessing
 * about one, so it has to actually reach the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSession, listSessions } from "./store.js";
import { resumeSession } from "./session.js";
import { toCallRecord } from "../dynamo/engine.js";
import type { Session, CallUsage } from "./types.js";

const call = (o: Partial<CallUsage> = {}): CallUsage => ({
  at: 1_700_000_000_000,
  prompt: 11_000,
  hit: 4_400,
  miss: 6_600,
  out: 20,
  model: "test-model",
  ...o,
});

async function sessionIn(dir: string, callLog?: CallUsage[]): Promise<Session> {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    cwd: dir,
    createdAt: Date.now(),
    transcript: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    toolContext: { cwd: dir } as Session["toolContext"],
    projectMemory: "",
    memoryDir: path.join(dir, "memory"),
    memoryIndex: "",
    priorSessions: 0,
    projectContext: "",
    governance: { rules: [], skills: [], forbidden: [] } as unknown as Session["governance"],
    modelConfig: { model: "test-model" } as Session["modelConfig"],
    ...(callLog ? { callLog } : {}),
  } as Session;
}

test("the per-call breakdown reaches the session file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-calllog-"));
  try {
    // Six calls of an 11K prompt: the shape that produced a 36K turn nobody could explain.
    const log = Array.from({ length: 6 }, (_, i) => call({ at: 1_700_000_000_000 + i * 1000 }));
    await saveSession(await sessionIn(dir, log));
    const meta = (await listSessions(dir))[0]!;
    assert.equal(meta.callLog?.length, 6, "the breakdown did not survive the write");
    assert.equal(meta.callLog?.[0]?.prompt, 11_000);
    // Which model produced it. Without this, "did behaviour change because we changed
    // something, or because the model changed?" has no answer anywhere on the machine —
    // the project's saved model is only ever the current one.
    assert.equal(meta.callLog?.[0]?.model, "test-model");
    // And it must add up to what the totals would claim, or it explains nothing.
    const miss = meta.callLog!.reduce((n, c) => n + c.miss, 0);
    assert.equal(miss, 39_600);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a session that never called a model carries no empty log", async () => {
  // A row of zeroes reads as a measurement. Absent means "not measured", which is true.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-calllog-"));
  try {
    await saveSession(await sessionIn(dir));
    assert.equal((await listSessions(dir))[0]!.callLog, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a resumed session re-advertises the deferred tools it had already surfaced", async () => {
  // Problem it guards: resume rebuilds a FRESH toolContext, so without persisting the
  // activation set a continued session would strip a deferred tool the model had searched
  // for and was mid-use of — and (for a strict function-calling model) it could no longer
  // call it. The set must survive to disk and come back.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-activated-"));
  try {
    const first = await sessionIn(dir);
    first.toolContext.activatedTools = new Set(["screenshot", "save_memory"]);
    await saveSession(first);

    const meta = (await listSessions(dir))[0]!;
    assert.deepEqual([...(meta.activatedTools ?? [])].sort(), ["save_memory", "screenshot"], "the activation set did not reach disk");

    const back = await resumeSession(dir, first.id);
    assert.ok(back, "the session did not resume");
    assert.ok(back.toolContext.activatedTools?.has("screenshot"), "resume dropped an activated tool");
    assert.ok(back.toolContext.activatedTools?.has("save_memory"), "resume dropped an activated tool");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a session that never searched carries no activation list", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-activated-"));
  try {
    const s = await sessionIn(dir);
    s.toolContext.activatedTools = new Set();
    await saveSession(s);
    assert.equal((await listSessions(dir))[0]!.activatedTools, undefined, "an empty set must not write a key");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resuming a session keeps what it already spent", async () => {
  // The failure this guards is worse than forgetting. `resumeSession` rebuilt the session
  // without its spend, and the next save OVERWRITES the meta — so a continued session
  // replaced a true running total with a smaller one and the earlier cost was gone for
  // good. A session's cost is the whole session's cost; /continue is not a new session.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-resume-"));
  try {
    const first = await sessionIn(dir, [call(), call()]);
    first.spend = {
      billed: 47_297,
      cacheHit: 32_481,
      cacheMiss: 47_174,
      cacheWrite: 0,
      output: 123,
      costUsd: 0.0767,
      turns: 2,
      estimated: false,
    };
    await saveSession(first);

    const back = await resumeSession(dir, first.id);
    assert.ok(back, "the session did not resume at all");
    assert.equal(back.spend?.billed, 47_297, "the resumed session forgot what it had spent");
    assert.equal(back.spend?.turns, 2);
    assert.equal(back.callLog?.length, 2, "and the per-call detail behind it");

    // And it must survive the round trip, since the overwrite is where it was lost.
    await saveSession(back);
    const meta = (await listSessions(dir))[0]!;
    assert.equal(meta.spend?.billed, 47_297, "saving a resumed session destroyed the running total");
    assert.equal(meta.spend?.turns, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the engine records the model that produced each call", () => {
  // Separate from the persistence tests above ON PURPOSE. Those build a CallUsage by
  // hand and check it survives the write, which says nothing about whether the engine
  // ever fills the field in — a red-check proved exactly that hole by blanking the model
  // here and watching every test still pass.
  const rec = toCallRecord(
    {
      promptTokens: 11_000,
      completionTokens: 20,
      totalTokens: 11_020,
      cacheHitTokens: 4_400,
      cacheMissTokens: 6_600,
    },
    "gemini-3.6-flash",
  );
  assert.equal(rec.model, "gemini-3.6-flash");
  assert.equal(rec.prompt, 11_000);
  assert.equal(rec.hit, 4_400);
  assert.equal(rec.miss, 6_600);
  assert.equal(rec.out, 20);
});

test("a session with nothing said in it is not listed", async () => {
  // Real project: 4 of the 12 sessions since 2.4.0 had 0 entries (saved by /include or
  // /update before any message) and each showed up in /continue as "0 msgs".
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mw-emptysession-"));
  try {
    const empty = await sessionIn(dir);
    empty.id = "00000000-0000-0000-0000-000000000000";
    empty.transcript = [];
    await saveSession(empty);
    await saveSession(await sessionIn(dir));
    const listed = await listSessions(dir);
    assert.deepEqual(listed.map((m) => m.id), ["11111111-2222-3333-4444-555555555555"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
