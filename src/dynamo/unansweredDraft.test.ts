/**
 * unansweredDraft.test.ts — a turn that ends after the verify gate set the model's reply aside.
 *
 * The real loop against a local provider. The model edits a file and answers; the gate sends it back to check its work; the
 * model's next call never comes back and the person presses Esc. What was on screen and what is saved must agree: the reply is
 * shown, saved last, and the gate's instruction is not left in the conversation.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { projectDir } from "../memory/store.js";
import { stopChassis } from "../alternator/lane.js";

const SEP = String.fromCharCode(10, 10);
type Step = { tool?: { name: string; args: Record<string, unknown> }; text?: string; hang?: boolean };
let steps: Step[] = [];
let seen = 0;
let server: Server;
const waiting: Array<() => void> = [];

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const step = steps[seen] ?? { text: "done" };
      seen++;
      if (step.hang) {
        // The model's next call never answers; the test stops the turn instead.
        waiting.splice(0).forEach((w) => w());
        res.on("close", () => {});
        return;
      }
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = step.tool
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${seen}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
          ]
        : [{ choices: [{ delta: { content: step.text ?? "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }];
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

/** One finished turn against the fake provider: what the person read, what was saved, and how many calls the model got. */
async function run(script: Step[]) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-draft-")));
  mkdirSync(projectDir(root), { recursive: true });
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  steps = script;
  seen = 0;
  session.transcript.push({ role: "user", content: "build it" });
  const events: Array<{ type: string; delta?: string }> = [];
  try {
    const reply = await respond(session, { onEvent: (e) => events.push(e as { type: string; delta?: string }) });
    // What is on screen is the text since the last reset, the way the front ends draw it.
    const reset = events.map((e) => e.type).lastIndexOf("replyReset");
    const shown = events.slice(reset + 1).filter((e) => e.type === "text").map((e) => e.delta).join("");
    const transcript = session.transcript as Array<{ role: string; content?: string; synthetic?: boolean }>;
    return { reply, shown, transcript, calls: seen };
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
}

const write: Step = { tool: { name: "write_file", args: { path: "out.js", content: "x" } } };
const check: Step = { tool: { name: "run_command", args: { command: "node --version" } } };
const REPORT = "movies.html is in place: 74 titles, genre filters, a search box and the same Sort picker as Music CDs.";

test("a check that really ran means no nudge, and a long report reaches the person whole", async () => {
  const page = Array.from({ length: 30 }, (_, i) => `- Part ${i} of what was built.`).join("\n");
  const r = await run([write, check, { text: page }]);
  assert.equal(r.calls, 3, "nothing sent it back, neither for the check nor for the length");
  assert.equal(r.reply, page);
  assert.equal(r.shown, page);
});

test("a check made before the last edit does not cover it", async () => {
  const r = await run([check, write, { text: REPORT }, check, { text: REPORT }]);
  assert.equal(r.calls, 5, "sent back once");
});

test("answering the nudge with an excuse leaves the person with what was built", async () => {
  const r = await run([write, { text: REPORT }, { text: "No build or test suite applies here." }]);
  assert.equal(r.calls, 3);
  assert.equal(r.reply, REPORT);
  assert.equal(r.shown, REPORT, "on screen");
  assert.equal(r.transcript[r.transcript.length - 1]!.content, REPORT, "and saved");
  assert.ok(!r.transcript.some((e) => e.synthetic), "the instruction is not left behind");
  assert.ok(!r.transcript.some((e) => /No build or test suite/.test(e.content ?? "")), "the excuse is not kept either");
});

test("a real check after the nudge adds to the report instead of replacing it", async () => {
  const r = await run([write, { text: REPORT }, check, { text: "It runs." }]);
  assert.equal(r.reply, `${REPORT}\n\nIt runs.`);
  assert.equal(r.shown, r.reply);
});

test("a rewrite written after the nudge is taken as it is", async () => {
  const rewrite = "The Movies page is at movies.html, with 74 titles, genre filters, search, and the Sort picker.";
  const r = await run([write, { text: REPORT }, check, { text: rewrite }]);
  assert.equal(r.reply, rewrite);
  assert.equal(r.shown, rewrite);
});

test("edits that failed or never ran are not counted as changes made one at a time", async () => {
  const miss = (n: number): Step => ({ tool: { name: "edit", args: { path: "out.js", edits: [{ old_string: `missing ${n}`, new_string: "y" }] } } });
  const r = await run([write, miss(1), miss(2), miss(3), check, { text: REPORT }]);
  assert.ok(!r.transcript.some((e) => e.synthetic && /separate one-edit calls/.test(e.content ?? "")), "the nudge fired for edits that changed nothing");
});

test("a reply set aside by the verify gate is shown and kept last when the turn is stopped before the model answers again", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-draft-")));
  mkdirSync(projectDir(root), { recursive: true });
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  steps = [{ tool: { name: "write_file", args: { path: "out.js", content: "x" } } }, { text: "All done. The app passes." }, { hang: true }];
  seen = 0;
  session.transcript.push({ role: "user", content: "write out.js" });
  const stop = new AbortController();
  const events: Array<{ type: string; delta?: string }> = [];
  const hung = new Promise<void>((r) => waiting.push(r));
  void hung.then(() => stop.abort());
  try {
    await respond(session, { signal: stop.signal, onEvent: (e) => events.push(e as { type: string; delta?: string }) }).catch(() => undefined);
    assert.equal(seen, 3, "the gate sent the model back and its next call was made");
    const t = session.transcript as Array<{ role: string; content?: string; synthetic?: boolean }>;
    assert.ok(!t.some((e) => e.synthetic), "the gate's instruction is not left behind");
    const last = t[t.length - 1]!;
    assert.equal(last.role, "assistant");
    assert.match(last.content ?? "", /All done\. The app passes\./, "the reply is the last thing saved");
    assert.equal(t.filter((e) => e.role === "assistant" && /All done/.test(e.content ?? "")).length, 1, "and only once");
    const resets = events.findIndex((e) => e.type === "replyReset");
    const shownAfter = events.slice(resets + 1).filter((e) => e.type === "text" && /All done/.test(e.delta ?? ""));
    assert.equal(shownAfter.length, 1, "the screen is told to show it, after it was dropped");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});
