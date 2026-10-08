/**
 * planLifecycle.test.ts — an approved plan has to END.
 *
 * `completePlanArtifact` existed, worked, and was covered by its own test. Nothing
 * called it. So `.mindweave/plan.md` stayed `status=active` forever, every later
 * session loaded it, and its binding block ("this is the agreed scope of the current
 * work — do not silently do something else") was injected into every request of
 * unrelated work weeks later, until the user found and deleted the file.
 *
 * The suite was green throughout, because the test proved the function worked and
 * never that anything used it. That is the shape being defended against here: these
 * tests drive the ENGINE, not the artifact module.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import { savePlanArtifact, loadPlanArtifact } from "./planArtifact.js";
import { saveSession, transcriptPath } from "../memory/store.js";
import type { Session } from "../memory/types.js";
import { PLAN_CHOICES } from "../tools/exitPlan.js";
import { APPROVAL_TEXT } from "../tools/approval.js";
import { appendSentinelAllow } from "../governor/write.js";

/**
 * A real turn, against a local stand-in provider.
 *
 * The settle happens AROUND the turn, so a test that never runs one proves nothing —
 * and the defect being fixed was precisely a function that worked and was never
 * called. There is no driver stub in this codebase, so the honest way to run a turn
 * is to point a real driver at a server that answers immediately.
 */
let server: Server;
/** Set by a test just before its turn: the one tool call the model will make. */
let nextToolCall: { id: string; type: "function"; function: { name: string; arguments: string } } | null = null;
/** Send the scripted call even when the tool is not advertised — the one case that
 *  matters is a model calling a tool it should no longer have. */
let sendUnadvertised = false;

function planCall(plan: string) {
  return { id: "call_1", type: "function" as const, function: { name: "exit_plan", arguments: JSON.stringify({ plan }) } };
}
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Real SSE, because the engine streams. A JSON body here parses as an empty
      // turn, which looks like a passing test and exercises nothing.
      // Matched on the REQUEST, not on call order. Turn-end housekeeping makes its own
      // model calls, and those were silently eating the scripted call before the test's
      // turn ever reached the provider. A request that advertises exit_plan is the
      // planning turn; anything else is background work.
      const isPlanningTurn = body.includes(String.fromCharCode(34) + "exit_plan" + String.fromCharCode(34));
      const call = isPlanningTurn || sendUnadvertised ? nextToolCall : null;
      if (call) {
        nextToolCall = null;
        sendUnadvertised = false;
      }
      const frames = call
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
          ]
        : [
            { choices: [{ delta: { content: "done" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
          ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      const SEP = String.fromCharCode(10, 10);
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.MINDWEAVE_GEMINI_URL = `http://127.0.0.1:${port}`;
});
after(() => void server.close());

function tempRoot(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "mw-planlife-")));
}

function session(root: string, over: Record<string, unknown> = {}): Session {
  // `toolContext` is merged, never replaced: spreading `over` wholesale silently
  // dropped `reads` and the turn then threw on a missing ledger.
  const { toolContext: ctxOver, ...rest } = over;
  return {
    cwd: root,
    transcript: [{ role: "user", content: "go" }],
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: {
      cwd: root,
      roots: [root],
      reads: new Map(),
      todos: [],
      activePlan: "1. Rename the widget",
      activePlanApprovedAt: new Date().toISOString(),
      planMode: false,
      ...(ctxOver as object),
    },
    ...rest,
  } as unknown as Session;
}

test("a plan is marked done once the turn carrying it out ends", async () => {
  const root = tempRoot();
  await savePlanArtifact(root, "1. Rename the widget", "lightning");
  assert.ok(await loadPlanArtifact(root), "precondition: the plan starts active");

  const s = session(root);
  await respond(s);

  assert.equal(s.toolContext.activePlan, "", "the session still thinks a plan is running");
  assert.equal(
    await loadPlanArtifact(root),
    null,
    "the artifact stayed active, so every later session would be bound by it",
  );
});

test("an INTERRUPTED turn keeps the plan, because the work was cut off not concluded", async () => {
  const root = tempRoot();
  await savePlanArtifact(root, "1. Rename the widget", "lightning");

  const s = session(root);
  const aborted = new AbortController();
  aborted.abort();
  await respond(s, { signal: aborted.signal }).catch(() => undefined);

  assert.equal(s.toolContext.activePlan, "1. Rename the widget", "an interrupted plan was dropped");
  assert.ok(await loadPlanArtifact(root), "an interrupted plan must survive to be continued");
});

test("planning turns never settle a plan, because nothing is being carried out", async () => {
  const root = tempRoot();
  await savePlanArtifact(root, "1. Rename the widget", "lightning");

  const s = session(root, { toolContext: { planMode: true } as object });
  await respond(s);

  assert.ok(await loadPlanArtifact(root), "a plan was retired by a turn spent planning");
});

test("a session with no plan does not touch the file", async () => {
  const root = tempRoot();
  await fs.mkdir(join(root, ".mindweave"), { recursive: true });
  await fs.writeFile(join(root, ".mindweave", "plan.md"), "hand written, not ours\n");

  const s = session(root, { toolContext: { activePlan: "" } as object });
  await respond(s);

  assert.equal(
    await fs.readFile(join(root, ".mindweave", "plan.md"), "utf8"),
    "hand written, not ours\n",
    "a file that was never an approved plan was rewritten",
  );
});


// ── the fresh-context start ──────────────────────────────────────────────────

test("a fresh start replaces the conversation with the plan, and says where the rest went", async () => {
  const root = tempRoot();
  const PLAN = "1. Rename the widget";
  const s = session(root, {
    id: "abc-123",
    transcript: [
      { role: "user", content: "how should we do this?" },
      { role: "assistant", content: "I looked at nine files and here is what I found" },
    ] as object,
    toolContext: {
      activePlan: "",
      planMode: true,
      requestApproval: async () => PLAN_CHOICES[1], // Approve — Lightning, fresh context
    } as object,
  });
  nextToolCall = planCall(PLAN);

  await respond(s);

  // The turn carries on after the reset, so the reply lands on top of the new opening.
  // What matters is that the planning conversation is gone from underneath it.
  assert.ok(s.transcript.length <= 2, `the planning conversation was not cleared (${s.transcript.length} entries)`);
  const opening = s.transcript[0]!;
  assert.equal(opening.role, "user");
  assert.ok(opening.content.includes("Implement the following plan"));
  assert.ok(opening.content.includes(PLAN), "the plan must survive, it is the only instruction left");
  assert.ok(!opening.content.includes("nine files"), "the exploration came along anyway");
  // Nothing is truly lost: the model is told where to read the rest.
  assert.ok(opening.content.includes("abc-123.jsonl"), "the model cannot find the conversation it lost");
  assert.equal(s.toolContext.planFreshStart, undefined, "the request must be consumed exactly once");
  // The work continues under a NEW id, so the planning conversation is not overwritten
  // by the next save — a session file is rewritten whole every time.
  assert.notEqual(s.id, "abc-123", "the new conversation kept the old id and will overwrite it");
  assert.equal(s.toolContext.sessionId, s.id, "the tool context still points at the old session");
});

test("the planning conversation SURVIVES on disk, so the pointer is not a lie", async () => {
  // The pointer names a file. Without a new id the next persist writes the replacement
  // message over that same file, and the model following the pointer finds only itself.
  const root = tempRoot();
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-ptrhome-")));
  process.env.MINDWEAVE_HOME = home;

  const s = session(root, {
    id: "planning-session",
    transcript: [{ role: "user", content: "the planning discussion, nine files deep" }] as object,
    toolContext: {
      activePlan: "",
      planMode: true,
      requestApproval: async () => PLAN_CHOICES[1],
    } as object,
  });
  nextToolCall = planCall("1. Do the thing");

  await respond(s, { persist: async () => void (await saveSession(s)) });

  const priorPath = transcriptPath(root, "planning-session");
  const kept = await fs.readFile(priorPath, "utf8");
  assert.ok(kept.includes("nine files deep"), "the planning conversation was overwritten");
  assert.ok(
    String(s.transcript[0]!.content).includes("planning-session.jsonl"),
    "the message points somewhere other than the conversation it kept",
  );
});

test("a fresh start clears the read ledger, so the model is not told it holds files it cannot see", async () => {
  // The same lie a compaction used to leave behind: `reads` describes what is on
  // screen, and after this nothing is.
  const root = tempRoot();
  const reads = new Map([[join(root, "a.ts"), { mtimeMs: 1, size: 10, full: true, touchedAt: 1 }]]);
  const s = session(root, {
    id: "abc-123",
    toolContext: {
      activePlan: "",
      planMode: true,
      reads,
      requestApproval: async () => PLAN_CHOICES[1],
    } as object,
  });
  nextToolCall = planCall("1. Do the thing");

  await respond(s);
  assert.equal(s.toolContext.reads.size, 0, "the ledger outlived the conversation it described");
});

test("approving WITHOUT a fresh context keeps the conversation", async () => {
  const root = tempRoot();
  const s = session(root, {
    id: "abc-123",
    transcript: [{ role: "user", content: "how should we do this?" }] as object,
    toolContext: {
      activePlan: "",
      planMode: true,
      requestApproval: async () => PLAN_CHOICES[0], // plain Lightning
    } as object,
  });
  nextToolCall = planCall("1. Do the thing");

  await respond(s);
  assert.ok(s.transcript.length > 1, "the conversation was cleared without being asked");
  assert.equal(s.transcript[0]!.content, "how should we do this?", "the planning turn was lost");
});

test("a fresh start reports the reclaim through the same channel a compaction does", async () => {
  const root = tempRoot();
  const s = session(root, {
    id: "abc-123",
    transcript: Array.from({ length: 40 }, () => ({ role: "user", content: "x".repeat(400) })) as object,
    toolContext: {
      activePlan: "",
      planMode: true,
      requestApproval: async () => PLAN_CHOICES[1],
    } as object,
  });
  nextToolCall = planCall("1. Do the thing");

  let report: { before: number; after: number } | undefined;
  await respond(s, { onCompaction: (r) => void (report = r) });
  assert.ok(report, "the conversation shrank enormously and the user was told nothing");
  assert.ok(report!.before > report!.after, "the report claims nothing was reclaimed");
});

// ── calling exit_plan when there is nothing to exit ──────────────────────────

test("exit_plan outside plan mode is refused, and cannot put the user into planning", async () => {
  // `planOnly` only filters the ADVERTISED schema, and exit_plan is read-only, so
  // neither of the dispatcher's other refusals caught it. The tool list a model holds
  // was built at the start of the step, so the step right after an approval still has
  // exit_plan in it — approving from there set the session up to return to planning,
  // putting the user in a mode they never chose.
  const root = tempRoot();
  let asked = false;
  const s = session(root, {
    id: "abc-123",
    toolContext: {
      activePlan: "",
      planMode: false, // already working — planning is over
      requestApproval: async () => {
        asked = true;
        return PLAN_CHOICES[0];
      },
    } as object,
  });
  nextToolCall = planCall("1. Sneak back into planning");
  sendUnadvertised = true;

  await respond(s);

  assert.equal(asked, false, "the user was prompted to approve a plan they never asked for");
  assert.equal(s.toolContext.planMode, false, "the session was put into planning by a tool call");
  const refusal = s.transcript.find((e) => e.role === "tool");
  assert.ok(refusal, "the call produced no result at all");
  assert.ok(String(refusal!.content).includes("not in plan mode"), "the model was not told why");
});


// ── Sentinel: a grant covers the action it was given for, and nothing else ────

test("SENTINEL: approving one kind of action does not authorise another", async () => {
  // The defect: the gate consulted a single boolean, so "yes, and stop asking" on a
  // file edit turned it off for shell commands, sub-agents and writes too, for the rest
  // of the session. Someone agreeing to an edit has agreed to an edit.
  const root = tempRoot();
  const asked: string[] = [];
  const s = session(root, {
    id: "abc-123",
    toolContext: {
      activePlan: "",
      guarded: true,
      requestApproval: async (_q: string, options: string[], detail?: string) => {
        asked.push(String(detail).split(String.fromCharCode(10))[0]!);
        return options[1]!; // "…and don't ask again for THIS kind"
      },
    } as object,
  });

  // First: a write. Granted for writes.
  nextToolCall = { id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) } };
  sendUnadvertised = true;
  await respond(s);
  assert.deepEqual([...(s.toolContext.guardAllowed ?? [])], ["write_file"]);

  // Second: a shell command that is not read-only (an `echo` no longer asks). Must still be asked about.
  nextToolCall = { id: "c2", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node -e 0" }) } };
  sendUnadvertised = true;
  await respond(s);

  assert.equal(asked.length, 2, "the shell command ran without being asked about");
  assert.ok(asked[0]!.includes("File write"));
  assert.ok(asked[1]!.includes("Shell execution"), "the second prompt was not about the command");
});

test("SENTINEL: a second call of the SAME kind is not asked about again", async () => {
  const root = tempRoot();
  let asks = 0;
  const s = session(root, {
    id: "abc-123",
    toolContext: {
      activePlan: "",
      guarded: true,
      requestApproval: async (_q: string, options: string[]) => {
        asks++;
        return options[1]!;
      },
    } as object,
  });

  for (const id of ["c1", "c2"]) {
    nextToolCall = { id, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `${id}.txt`, content: "x" }) } };
    sendUnadvertised = true;
    await respond(s);
  }
  assert.equal(asks, 1, "the grant was not honoured, so the user was asked twice");
});

test("SENTINEL: an action the user saved as allowed is not asked about, and others still are", async () => {
  // Saved through the same writer the Permissions screen uses, and picked up from disk
  // by the turn's own governance refresh: the whole path a real session takes.
  const root = tempRoot();
  await appendSentinelAllow(root, "write_file", "project");
  const asked: string[] = [];
  const s = session(root, {
    id: "abc-123",
    toolContext: {
      activePlan: "",
      guarded: true,
      requestApproval: async (_q: string, options: string[], detail?: string) => {
        asked.push(String(detail).split(String.fromCharCode(10))[0]!);
        return options[0]!;
      },
    } as object,
  });
  nextToolCall = { id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) } };
  sendUnadvertised = true;
  await respond(s);
  assert.equal(asked.length, 0, "a saved allowance was asked about anyway");

  nextToolCall = { id: "c2", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node -e 0" }) } };
  sendUnadvertised = true;
  await respond(s);
  assert.equal(asked.length, 1, "an action that was not saved went through without asking");
});

test("SENTINEL: a declined action carries the user's own direction back", async () => {
  const root = tempRoot();
  const s = session(root, {
    id: "abc-123",
    toolContext: {
      activePlan: "",
      guarded: true,
      requestApproval: async () => APPROVAL_TEXT + "use pnpm, not npm",
    } as object,
  });
  nextToolCall = { id: "c1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "npm install" }) } };
  sendUnadvertised = true;

  await respond(s);
  const result = s.transcript.find((e) => e.role === "tool");
  assert.ok(result, "the declined call produced no result");
  assert.ok(String(result!.content).includes("use pnpm, not npm"), "the user's direction never reached the model");
  assert.equal(s.toolContext.guardAllowed, undefined, "a refusal must not grant anything");
});


test("a fresh start leaves the session notes able to restart, not stalled", async () => {
  // "Should the notes update" asks how far the transcript has grown SINCE the last
  // update. Clearing the notes without rebasing that measurement leaves the difference
  // negative, so they would never update again until the new work exceeded the old
  // conversation it replaced. A compaction rebases for the same reason.
  const root = tempRoot();
  const s = session(root, {
    id: "abc-123",
    transcript: Array.from({ length: 40 }, () => ({ role: "user", content: "x".repeat(400) })) as object,
    sessionMemory: "notes about the planning research",
    sessionMemoryTokens: 50_000,
    sessionMemoryInit: true,
    toolContext: {
      activePlan: "",
      planMode: true,
      requestApproval: async () => PLAN_CHOICES[1],
    } as object,
  });
  nextToolCall = planCall("1. Do the thing");

  await respond(s);

  assert.equal(s.sessionMemory, "", "notes describing a conversation that is gone were kept");
  assert.equal(s.sessionMemoryInit, false, "the notes cannot restart from scratch");
  assert.ok(
    (s.sessionMemoryTokens ?? 0) < 5_000,
    `the baseline still measures the old conversation (${s.sessionMemoryTokens})`,
  );
});


// ── a sub-agent must not retire its parent's plan ────────────────────────────

test("a sub-agent's turn does NOT mark the parent's plan complete", async () => {
  // A child forks the parent's tool context, so it inherits `activePlan` — and a child
  // runs the same `respond()` loop, which settles a finished plan when its turn ends.
  // The plan artifact is a file, shared by both, so the child retired the agreement its
  // parent was still in the middle of carrying out.
  const root = tempRoot();
  await savePlanArtifact(root, "1. The parent's plan", "lightning");

  const { forkSession } = await import("../memory/session.js");
  const parent = session(root, { id: "parent" });
  const child = forkSession(parent, "go and look at something");

  await respond(child);

  assert.ok(
    await loadPlanArtifact(root),
    "the sub-agent marked its parent's plan done while the parent was still working on it",
  );
});


// ── Nothing appears or runs behind an open decision ────────────────────────────

test("SENTINEL: a gated command is not shown as running until it is approved", async () => {
  // The defect: every call in a step was announced up front, so a command sat on screen
  // as "running" while its own permission prompt was still waiting for an answer.
  const root = tempRoot();
  const events: { type: string; phase?: string; id?: string }[] = [];
  let startsSeenWhenAsked = -1;
  const s = session(root, {
    id: "abc-123",
    toolContext: {
      activePlan: "",
      guarded: true,
      requestApproval: async (_q: string, options: string[]) => {
        startsSeenWhenAsked = events.filter((e) => e.type === "tool" && e.phase === "start" && e.id === "g1").length;
        return options[0]!; // approve
      },
    } as object,
  });
  nextToolCall = { id: "g1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "b.txt", content: "y" }) } };
  sendUnadvertised = true;
  await respond(s, { onEvent: (e) => events.push(e as never) });
  assert.equal(startsSeenWhenAsked, 0, "the command was announced before it was approved");
  const g1 = events.filter((e) => e.type === "tool" && e.id === "g1").map((e) => e.phase);
  assert.deepEqual(g1, ["start", "end"], "approved: it runs, then ends");
});

test("SENTINEL: a declined command still gets its row, announced with its result", async () => {
  const root = tempRoot();
  const events: { type: string; phase?: string; id?: string; summary?: string }[] = [];
  const s = session(root, {
    id: "abc-123",
    toolContext: {
      activePlan: "",
      guarded: true,
      requestApproval: async () => undefined, // declined
    } as object,
  });
  nextToolCall = { id: "g2", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node -e 0" }) } };
  sendUnadvertised = true;
  await respond(s, { onEvent: (e) => events.push(e as never) });
  const g2 = events.filter((e) => e.type === "tool" && e.id === "g2");
  assert.deepEqual(g2.map((e) => e.phase), ["start", "end"]);
  assert.match(String(g2[1]!.summary), /^declined /);
});

test("a question or a plan never runs alongside other calls", async () => {
  const { callIsConcurrencySafe } = await import("./engine.js");
  const { askUserTool } = await import("../tools/askUser.js");
  const { exitPlan } = await import("../tools/exitPlan.js");
  assert.equal(callIsConcurrencySafe(askUserTool, { question: "?", options: ["a", "b"] }), false);
  assert.equal(callIsConcurrencySafe(exitPlan, { plan: "x" }), false);
});
