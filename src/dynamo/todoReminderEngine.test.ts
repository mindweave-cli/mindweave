/**
 * todoReminderEngine.test.ts — a real session with an open task list that nobody updates gets the
 * reminder line in a later request, and only once.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";
import { TODO_QUIET_ROUNDS } from "./todoReminder.js";

const ROUNDS = TODO_QUIET_ROUNDS + 2;
let bodies: string[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      const n = bodies.length;
      const frames =
        n <= ROUNDS
          ? [
              { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }] } }] },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage },
            ]
          : [{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      const SEP = String.fromCharCode(10, 10);
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
});

test("an open task list left alone for a run of rounds gets one reminder", async () => {
  bodies = [];
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-todorem-")));
  writeFileSync(join(root, "a.txt"), "hello\n");
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.toolContext.todos = [{ content: "Finish the parser", activeForm: "Finishing the parser", status: "in_progress" }];
  session.transcript.push({ role: "user", content: "read a.txt a lot" });
  try {
    await respond(session, {});
    const withReminder = bodies.filter((b) => b.includes("Reminder: your task list has not been updated"));
    assert.ok(withReminder.length > 0, "the reminder never reached the model");
    const lines = session.transcript.filter((e) => e.role === "user" && e.content.includes("Reminder: your task list"));
    assert.equal(lines.length, 1, "once per quiet run");
    assert.match(lines[0]!.content, /Finish the parser/);
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* temp folder */
    }
  }
});
