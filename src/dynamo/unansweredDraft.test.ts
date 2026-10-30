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
