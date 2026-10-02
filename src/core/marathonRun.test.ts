/**
 * marathonRun.test.ts — a Marathon as a front end drives it: the events it streams, the
 * live task list, error reporting, and surviving a restart through the session file.
 * The engine calls are replaced with fakes; everything else is the real glue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, resumeSession } from "../memory/session.js";
import { saveSession } from "../memory/store.js";
import type { MarathonDeps } from "../dynamo/marathon.js";
import type { VerdictReport } from "../tools/verifyReport.js";
import {
  dismissMarathon,
  forwardEngineEvent,
  marathonOf,
  resumeMarathonRun,
  startMarathonRun,
  type TurnEvent,
} from "./turnRunner.js";

async function freshSession() {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mrun-state-"));
  const cwd = mkdtempSync(join(tmpdir(), "mrun-proj-"));
  return createSession(cwd);
}

const pass: VerdictReport = { verdict: "pass", body: "checked", evidence: 2, downgraded: false, concerns: [] };

/** One turn of plain work: a tool call and its result, so it never reads as stuck. */
function work(s: Awaited<ReturnType<typeof freshSession>>, n: number) {
  s.transcript.push({ role: "assistant", content: "", toolCalls: [{ id: `w${n}`, name: "edit", arguments: `{"n":${n}}` }] });
  s.transcript.push({ role: "tool", toolCallId: `w${n}`, content: `edited ${n}` });
}

test("a run streams the model's events, the task list and its own progress, then finishes with done", async () => {
  const session = await freshSession();
  const events: TurnEvent[] = [];
  const fake: Partial<MarathonDeps> = {
    respond: async (s, options) => {
      options?.onEvent?.({ type: "text", delta: "on it" });
      options?.onEvent?.({ type: "todos", items: [{ content: "Fix it", activeForm: "Fixing it", status: "in_progress" }] });
      work(s, 1);
      return "on it";
    },
    verify: async () => pass,
    sleep: async () => {},
  };
  const state = await startMarathonRun(session, "fix the button", { onEvent: (e) => events.push(e) }, fake);
  assert.equal(state?.status, "done");

  const types = events.map((e) => e.type);
  assert.ok(types.includes("text"));
  assert.ok(types.includes("todos"));
  assert.equal(types[types.length - 1], "done");

  const marathon = events.filter((e): e is Extract<TurnEvent, { type: "marathon" }> => e.type === "marathon");
  assert.deepEqual(
    marathon.map((m) => m.event.type),
    ["started", "turn", "planned", "turn", "verifying", "verified", "finished"],
  );
  assert.ok(marathon.every((m) => m.text.length > 0), "every progress event carries its one-line wording");
});

test("an error from the provider is reported, the run stays resumable, and the turn still ends", async () => {
  const session = await freshSession();
  const events: TurnEvent[] = [];
  const fake: Partial<MarathonDeps> = {
    respond: async () => {
      throw new Error("provider exploded");
    },
    verify: async () => pass,
    sleep: async () => {},
  };
  const state = await startMarathonRun(session, "goal", { onEvent: (e) => events.push(e) }, fake);
  assert.equal(state, null);
  assert.ok(events.some((e) => e.type === "error" || e.type === "notice"));
  assert.equal(events[events.length - 1]!.type, "done");
  assert.equal(marathonOf(session)?.status, "running", "an outage must not end the goal");
});

test("a run saved mid-way comes back after a restart with its goal, counters and task list", async () => {
  const session = await freshSession();
  const controller = new AbortController();
  let turns = 0;
  const fake: Partial<MarathonDeps> = {
    respond: async (s, options) => {
      turns++;
      options?.onEvent?.({ type: "todos", items: [{ content: "Step one", activeForm: "Doing step one", status: "in_progress" }] });
      work(s, turns);
      if (turns === 2) controller.abort();
      options?.onPause?.("stepBudget");
      return "ok";
    },
    verify: async () => pass,
    sleep: async () => {},
  };
  await startMarathonRun(session, "migrate the database", { onEvent: () => {}, signal: controller.signal }, fake);
  assert.equal(marathonOf(session)?.status, "running");
  await saveSession(session);

  const restored = await resumeSession(session.cwd, session.id);
  const state = marathonOf(restored!);
  assert.equal(state?.goal, "migrate the database");
  assert.equal(state?.status, "running");
  assert.equal(state?.turnsSpent, 1);
  assert.equal(state?.todos?.[0]?.content, "Step one");

  // And it carries on from there.
  const resumed = await resumeMarathonRun(restored!, { onEvent: () => {} }, {
    respond: async (s, options) => {
      work(s, 99);
      options?.onPause?.("reScope");
      return "done";
    },
    verify: async () => pass,
    sleep: async () => {},
  });
  assert.equal(resumed?.status, "done");
});

test("resuming when nothing is running says so instead of starting anything", async () => {
  const session = await freshSession();
  assert.equal(await resumeMarathonRun(session, { onEvent: () => {} }), null);
});

test("the task list and tool events map to plain events for a front end", () => {
  const out: TurnEvent[] = [];
  forwardEngineEvent({ type: "todos", items: [{ content: "A", activeForm: "A", status: "pending" }] }, (e) => out.push(e));
  forwardEngineEvent({ type: "tool", phase: "start", id: "1", name: "read_file", args: { path: "a.ts" } }, (e) => out.push(e));
  assert.deepEqual(out.map((e) => e.type), ["todos", "toolStart"]);
});

test("a tool start carries what the call was given, with long text cut", () => {
  const out: TurnEvent[] = [];
  const big = "x".repeat(5000);
  forwardEngineEvent({ type: "tool", phase: "start", id: "7", name: "write_file", args: { path: "src/a.ts", content: big } }, (e) => out.push(e));
  const start = out[0];
  assert.equal(start?.type, "toolStart");
  if (start?.type !== "toolStart") return;
  assert.equal(start.args?.path, "src/a.ts");
  assert.equal((start.args?.content as string).length, 2000);
});

test("an image attached to the goal rides on the goal message only, like any first message", async () => {
  const session = await freshSession();
  const image = { path: "C:\\shots\\mock.png", mediaType: "image/png" };
  const seen: Array<{ content: string; images?: unknown }> = [];
  let n = 0;
  const fake: Partial<MarathonDeps> = {
    respond: async (s, options) => {
      n++;
      const last = s.transcript[s.transcript.length - 1];
      if (last?.role === "user") seen.push({ content: last.content, images: last.images });
      work(s, n);
      options?.onPause?.(n === 1 ? "stepBudget" : "reScope");
      return "ok";
    },
    verify: async () => pass,
    sleep: async () => {},
  };
  await startMarathonRun(session, { content: "make it look like this", images: [image] }, { onEvent: () => {} }, fake);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0]!.images, [image]);
  assert.equal(seen[1]!.images, undefined, "the nudges after it carry no image");
});

test("an attached file that cannot be read is reported, not silently dropped", async () => {
  const session = await freshSession();
  const events: TurnEvent[] = [];
  const fake: Partial<MarathonDeps> = {
    respond: async (s, options) => {
      work(s, 1);
      options?.onPause?.("reScope");
      return "ok";
    },
    verify: async () => pass,
    sleep: async () => {},
  };
  await startMarathonRun(session, { content: "goal", imagePaths: [join(tmpdir(), "does-not-exist.png")] }, { onEvent: (e) => events.push(e) }, fake);
  assert.ok(events.some((e) => e.type === "activity" && e.error === true && /couldn't read/.test(e.line)));
});

test("a dismissed run stays dismissed after the session is reopened", async () => {
  const session = await freshSession();
  const fake: Partial<MarathonDeps> = { respond: async (s) => (work(s, 1), "ok"), verify: async () => pass, sleep: async () => {} };
  await startMarathonRun(session, "fix the button", { onEvent: () => {} }, fake);
  await saveSession(session);
  assert.ok(marathonOf((await resumeSession(session.cwd, session.id))!), "the finished run is saved with the session");
  await dismissMarathon(session);
  assert.equal(marathonOf((await resumeSession(session.cwd, session.id))!), null, "closing it removed it from the saved file too");
});
