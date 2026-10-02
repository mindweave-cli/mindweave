/**
 * summaryHistory.test.ts — a compaction summary stops giving orders once the user speaks.
 *
 * The summary ends in a hand-off "Next Step" and sits at the top of every request. A
 * session showed what that does to a model that weighs it badly against the newest
 * message: asked "what should we do next?" three times, it answered with the summary's
 * next step ("report the test result and ask what they want next") three times. So the
 * summary is sent as background, without the next step, once the user has written
 * after it. These tests pin the rule, the rewrite, and that it is what reaches the wire.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summaryForWire, summaryIsHistory, spliceSummary, SUMMARY_REQUEST } from "./compaction.js";
import { respond } from "../dynamo/engine.js";
import type { Entry, Session } from "./types.js";

const SUMMARY = `[Earlier conversation summarized to save context. Continue as if the break never happened — do not acknowledge the summary or recap it.]

<summary>
1. **Primary Request & Intent**
   - Test the playtime tracker without opening a game.

8. **Current Work**
   - Playtime tracker test finished; probe data removed.

9. **Next Step**
   - Report the playtime test result to the user and ask what they want next.
</summary>`;

const at = 1_000;
const summary: Entry = { role: "summary", content: SUMMARY, ts: at };

// ── the rule ──────────────────────────────────────────────────────────────────
test("a summary nobody has answered since is still the hand-off", () => {
  assert.equal(summaryIsHistory(summary, []), false);
  // The kept tail: older than the summary, so it was already accounted for.
  assert.equal(summaryIsHistory(summary, [{ role: "user", content: "older", ts: at - 5 }]), false);
  // Engine nudges continue the same work; they are not the user changing the subject.
  assert.equal(summaryIsHistory(summary, [{ role: "user", content: "continue", synthetic: true, ts: at + 5 }]), false);
});

test("once the user writes after it, the summary is history", () => {
  assert.equal(summaryIsHistory(summary, [{ role: "user", content: "what next?", ts: at + 5 }]), true);
  // Not saved yet, so not stamped yet: that can only be newer than the summary.
  assert.equal(summaryIsHistory(summary, [{ role: "user", content: "what next?" }]), true);
});

test("an unstamped summary (older sessions) goes by the conversation's shape", () => {
  const old: Entry = { role: "summary", content: SUMMARY };
  const reply = (content: string): Entry => ({ role: "assistant", content });
  const user = (content: string): Entry => ({ role: "user", content });
  // The exact shape of the session that showed the bug.
  assert.equal(
    summaryIsHistory(old, [user("continue just this task"), reply("(interrupted)"), user("are we here?"), reply("Test done."), user("what next?")]),
    true,
  );
  // An interruption is not an answer, and a tool round is not a finished one.
  assert.equal(summaryIsHistory(old, [reply("(interrupted)"), user("are we here?")]), false);
  assert.equal(
    summaryIsHistory(old, [{ role: "assistant", content: "checking", toolCalls: [{ id: "1", name: "x", arguments: "{}" }] }, user("hm")]),
    false,
  );
});

test("compaction stamps the summary it makes", () => {
  const out = spliceSummary([{ role: "user", content: "hi" }], "1. a\n2. b", 0, 4242);
  assert.equal(out[0]!.ts, 4242);
});

// ── the rewrite ───────────────────────────────────────────────────────────────
test("while it is the hand-off, it is sent untouched", () => {
  assert.equal(summaryForWire(SUMMARY, false), SUMMARY);
});

test("as history it loses the next step and the order to continue, and keeps the record", () => {
  const sent = summaryForWire(SUMMARY, true);
  assert.doesNotMatch(sent, /Next Step/);
  assert.doesNotMatch(sent, /Report the playtime test result/);
  assert.doesNotMatch(sent, /Continue as if the break/);
  assert.match(sent, /answer the user's newest message/);
  assert.match(sent, /Current Work[\s\S]*probe data removed/, "the record of what happened stays");
  assert.match(sent, /<\/summary>$/);
});

test("the next step is found however the model wrote its heading", () => {
  for (const heading of ["9. Next Step", "## 9. Next Step", "9) **Optional Next Step**", "### 9. **Next Step:**"]) {
    const text = `[Earlier conversation compacted.]\n\n8. Current Work\n- done\n\n${heading}\n- do the old thing again\n`;
    const sent = summaryForWire(text, true);
    assert.doesNotMatch(sent, /old thing/, heading);
    assert.match(sent, /Current Work/, heading);
  }
});

test("the summarizer is told a finished task has no next step", () => {
  assert.match(SUMMARY_REQUEST, /If the last task was finished/);
  assert.match(SUMMARY_REQUEST, /most recent explicit request/);
});

// ── on the wire ───────────────────────────────────────────────────────────────
let requests: { messages: { role: string; content?: string }[] }[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const SEP = String.fromCharCode(10, 10);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + SEP);
      res.write(
        "data: " +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }) +
          SEP,
      );
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => void server.close());

function session(transcript: Entry[]): Session {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-sumhist-")));
  return {
    cwd: root,
    transcript,
    modelConfig: { model: "gemini-3.7-flash" },
    governance: { rules: [], skills: [], forbidden: { patterns: [], root } },
    toolContext: { cwd: root, roots: [root], reads: new Map(), todos: [], planMode: false },
  } as unknown as Session;
}

test("the request carries the summary as history once the user has asked something new", async () => {
  requests = [];
  await respond(
    session([
      { ...summary },
      { role: "assistant", content: "Test done.", ts: at + 1 },
      { role: "user", content: "what should we do next? what do you suggest?", ts: at + 2 },
    ]),
  );
  const wire = requests[0]!.messages.map((m) => m.content ?? "").join("\n");
  assert.doesNotMatch(wire, /Report the playtime test result/, "the stale next step reached the model");
  assert.match(wire, /answer the user's newest message/);
  assert.match(wire, /what should we do next/);
});

test("a turn resuming straight across the break still gets the next step", async () => {
  requests = [];
  await respond(session([{ ...summary }, { role: "user", content: "continue", synthetic: true, ts: at + 1 }]));
  const wire = requests[0]!.messages.map((m) => m.content ?? "").join("\n");
  assert.match(wire, /Report the playtime test result/);
});
