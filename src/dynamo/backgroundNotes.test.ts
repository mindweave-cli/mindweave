/**
 * backgroundNotes.test.ts — a finished background shell is announced ONCE.
 *
 * The bug this pins was found by reading a real 293-entry session. One `cargo check`
 * exited 101; the model then spent 19 of the next 37 steps re-explaining that same
 * finished command, while doing unrelated work in between. It was not looping — 71 of
 * its 71 commands were distinct — it was answering the same news over and over because
 * the harness kept re-delivering it.
 *
 * The cause was consumer-side. `drainEvents()` is carefully one-shot at the PRODUCER, so
 * the event was only ever produced once; but the drained array was captured before the
 * step loop and re-attached to the END of every request inside it. A message sitting last
 * in the conversation reads as "the user just said this" — every step, forever.
 *
 * What makes this testable is POSITION, not count: both before and after the fix a given
 * request contains the note once. The difference is whether it stays pinned to the end.
 * So these assertions are about where it sits on the second and later calls of one turn,
 * which is the only place the defect was ever visible.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundEventNote, respond } from "./engine.js";
import { BackgroundShells, type ShellInfo } from "../tools/backgroundShells.js";
import type { Session } from "../memory/types.js";

let requests: { messages: { role: string; content?: string }[] }[] = [];
let toolRounds = 0;
/** Held before each reply, so calls within one turn land at measurably different times. */
let replyDelayMs = 0;
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (replyDelayMs > 0) await new Promise((r) => setTimeout(r, replyDelayMs));
      try {
        requests.push(JSON.parse(body));
      } catch {
        requests.push({ messages: [] });
      }
      // A harmlessly-failing tool call for the first `toolRounds` rounds, then an answer.
      // What a round needs to contribute here is a well-formed tool RESULT, so the turn
      // takes another step; whether the tool succeeded is irrelevant.
      const call = toolRounds-- > 0;
      const frames = call
        ? [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "not_a_real_tool", arguments: "" } }],
                  },
                },
              ],
            },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
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
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${port}`;
});

after(() => void server.close());

const NODE = process.execPath;
const DETACH = process.platform !== "win32";

function session(shells: BackgroundShells): Session {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-bgnote-")));
  return {
    cwd: root,
    transcript: [{ role: "user", content: "go" }],
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [], planMode: false, backgroundShells: shells },
  } as unknown as Session;
}

/** Run a command to completion in the background, so a real event is pending. */
async function finishedShell(): Promise<BackgroundShells> {
  const mgr = new BackgroundShells();
  const child = spawn(NODE, ["-e", "console.log('BUILD_OUTPUT'); process.exit(101)"], { detached: DETACH });
  mgr.adopt(child, { command: "cargo check", cwd: process.cwd() });
  const start = Date.now();
  while (mgr.list()[0]!.status === "running") {
    if (Date.now() - start > 5000) throw new Error("the shell never finished");
    await new Promise((r) => setTimeout(r, 20));
  }
  return mgr;
}

/** Every message of a request, as `role:content`, so position is visible. */
function shape(request: { messages: { role: string; content?: string }[] }): string[] {
  return request.messages.map((m) => `${m.role}:${(m.content ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
}

const isNote = (m: { role: string; content?: string }): boolean =>
  m.role === "user" && (m.content ?? "").includes("Background shell #");

test("the note is delivered once and does not stay pinned to the end of every call", async () => {
  requests = [];
  toolRounds = 3;
  const mgr = await finishedShell();
  const s = session(mgr);

  await respond(s, {});

  assert.ok(requests.length >= 3, `expected several model calls, saw ${requests.length}`);

  // It reached the model at all.
  const carrying = requests.filter((r) => r.messages.some(isNote));
  assert.ok(carrying.length > 0, "the finished shell was never reported to the model");

  // THE REGRESSION: on every call after the one that introduced it, the note must have
  // conversation after it — the assistant's reply and the tool result. Pinned last on
  // each call is what made the model answer it again and again.
  for (let i = 1; i < requests.length; i++) {
    const msgs = requests[i]!.messages;
    const at = msgs.findIndex(isNote);
    if (at === -1) continue;
    assert.ok(
      at < msgs.length - 1,
      `call ${i}: the background note is the LAST message again — it will read as fresh news.\n${shape(requests[i]!).join("\n")}`,
    );
  }

  // And it is never duplicated within one call.
  for (const [i, r] of requests.entries()) {
    const count = r.messages.filter(isNote).length;
    assert.ok(count <= 1, `call ${i} carried the same background note ${count} times`);
  }

  mgr.dispose(true);
});

test("it becomes part of the conversation, not a per-request attachment", async () => {
  // Pushing it into the transcript is what makes delivery exactly-once at the consumer
  // as well as the producer: it is carried forward like any other message instead of
  // being re-attached, and it survives for the model to refer back to.
  requests = [];
  toolRounds = 2;
  const mgr = await finishedShell();
  const s = session(mgr);

  await respond(s, {});

  const inTranscript = s.transcript.filter(
    (e) => e.role === "user" && typeof e.content === "string" && e.content.includes("Background shell #"),
  );
  assert.equal(inTranscript.length, 1, "the note should be exactly one transcript entry");
  assert.equal(
    (inTranscript[0] as { synthetic?: boolean }).synthetic,
    true,
    "it is harness-generated, so it must be marked synthetic like the ripple note",
  );
  assert.match(String(inTranscript[0]!.content), /BUILD_OUTPUT/, "the output tail rode along with it");

  mgr.dispose(true);
});

test("a turn with nothing in the background adds no notes at all", async () => {
  requests = [];
  toolRounds = 1;
  const mgr = new BackgroundShells();
  const s = session(mgr);

  await respond(s, {});

  assert.equal(
    s.transcript.filter((e) => e.role === "user" && String(e.content).includes("Background shell #")).length,
    0,
    "a quiet session must not grow synthetic entries",
  );
  mgr.dispose(true);
});

// ── What the note says about who ended it ─────────────────────────────────────

function ended(over: Partial<ShellInfo>): ShellInfo {
  return {
    id: 5,
    command: "npx electron out/main/index.js",
    cwd: "C:\app",
    status: "killed",
    exitCode: null,
    startedAt: 0,
    finishedAt: 1,
    ready: true,
    notify: "on_failure",
    ...over,
  } as ShellInfo;
}

test("the agent's own kill_shell is not reported back as the user closing the app", () => {
  // Found in a real session: the agent killed its app to restart it, and was then told
  // "this is the user stopping their own app", blaming the user for its own action.
  const note = backgroundEventNote({ info: ended({ stoppedBy: "agent" }), kind: "ended", tail: "", wake: false });
  assert.equal(note, null);
});

test("a stop the user made is still reported as theirs", () => {
  const note = backgroundEventNote({ info: ended({ stoppedBy: "user" }), kind: "ended", tail: "", wake: false });
  assert.match(note ?? "", /the user stopping their own app/);
});

test("an app that exited on its own after starting is only PROBABLY the user", () => {
  const note = backgroundEventNote({ info: ended({ status: "exited", exitCode: 0 }), kind: "ended", tail: "", wake: false });
  assert.match(note ?? "", /most likely the user/);
});

test("a runaway Mindweave stopped is reported as that, with its output, not as a user close", () => {
  const note = backgroundEventNote({ info: ended({ stoppedBy: "system" }), kind: "ended", tail: "spam spam", wake: false });
  assert.match(note ?? "", /stopped by Mindweave/);
  assert.match(note ?? "", /spam spam/);
  assert.doesNotMatch(note ?? "", /user stopping/);
});

test("the running note does not invite describing a window nobody looked at", () => {
  const note = backgroundEventNote({ info: ended({ status: "running", finishedAt: null }), kind: "ready", tail: "", wake: true });
  assert.match(note ?? "", /unless you have actually looked/);
});

test("each call in a turn is logged with its own time, not the time the turn was saved", async () => {
  // Real sessions: 145 calls carried 4 distinct timestamps, because every call was stamped
  // when the turn was saved. The log could not show where a long turn spent its time.
  requests = [];
  toolRounds = 3;
  replyDelayMs = 25;
  const mgr = new BackgroundShells();
  const s = session(mgr);
  try {
    await respond(s, {});
  } finally {
    replyDelayMs = 0;
    mgr.dispose(true);
  }
  const times = (s.callLog ?? []).map((c) => c.at);
  assert.ok(times.length >= 4, `expected a call record per model call, saw ${times.length}`);
  assert.equal(new Set(times).size, times.length, `calls share timestamps: ${times.join(", ")}`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! > times[i - 1]!, "call times are out of order");
});

test("an app that failed to start while the agent was checking its own work is not handed back as a question", () => {
  // Real session: the agent launched the app it was building, the launch failed, and the
  // note told it to "offer to fix it". It stopped and asked, and the user replied
  // "why would you stop an unfinished work?".
  const note = backgroundEventNote({
    info: ended({ status: "exited", exitCode: 1, ready: false }),
    kind: "ended",
    tail: "",
    wake: true,
  });
  assert.match(note ?? "", /part of that work/);
  assert.match(note ?? "", /do not restart it again without changing something/);
});

// ── The working directory each turn starts in ────────────────────────────────


test("a turn that starts back at the root says where the previous turn had moved to", async () => {
  // Real session: the agent cd-ed into a test folder, the next turn started at the root
  // without saying so, and `cargo run` failed with "could not find Cargo.toml".
  requests = [];
  toolRounds = 0;
  const mgr = new BackgroundShells();
  const s = session(mgr);
  const sub = join(s.cwd, "Testings", "gpu-present");
  mkdirSync(sub, { recursive: true });
  s.toolContext.cwd = sub;
  try {
    await respond(s, {});
  } finally {
    mgr.dispose(true);
  }
  const tail = requests[0]!.messages.at(-1)?.content ?? "";
  assert.match(tail, /previous turn had moved into Testings[\/]gpu-present/);
  assert.match(tail, /each turn starts back at the root/);
  assert.equal(s.toolContext.cwd, s.cwd);
});

test("a turn that was already at the root says nothing about it", async () => {
  requests = [];
  toolRounds = 0;
  const mgr = new BackgroundShells();
  const s = session(mgr);
  try {
    await respond(s, {});
  } finally {
    mgr.dispose(true);
  }
  const all = requests[0]!.messages.map((m) => m.content ?? "").join("\n");
  assert.doesNotMatch(all, /previous turn had moved into/);
});
