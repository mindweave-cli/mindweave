/**
 * quietFailures.test.ts — a failure that is repeated is not quiet any more.
 *
 * A "quiet" failure draws no red row: it is a correction the model makes by itself. Seen as: asked to remove a rule, the agent
 * failed four times in a row with the same answer, every attempt was hidden, and when the session was opened again the person had no
 * trace of what had been tried. The second quiet failure of the same tool in a turn is now drawn, and kept.
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
type Step = { tool?: { name: string; args: Record<string, unknown> }; text?: string };
let steps: Step[] = [];
let seen = 0;
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const step = steps[seen] ?? { text: "done" };
      seen++;
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

test("the first quiet failure is hidden as before; the second and later ones are drawn and kept", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-quiet-")));
  mkdirSync(projectDir(root), { recursive: true });
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  (session.toolContext.activatedTools ??= new Set()).add("governor");
  // An empty `value` is a quiet failure of that tool, three times over.
  const bad = { name: "governor", args: { action: "remember_rule", value: "" } };
  steps = [{ tool: bad }, { tool: bad }, { tool: bad }, { text: "I could not do that." }];
  seen = 0;
  session.transcript.push({ role: "user", content: "remember a rule" });
  const ends: Array<{ error: boolean; quiet: boolean }> = [];
  try {
    await respond(session, {
      onEvent: (e) => {
        if (e.type === "tool" && e.phase === "end" && e.name === "governor") ends.push({ error: e.error ?? false, quiet: (e as { quiet?: boolean }).quiet === true });
      },
    });
    assert.deepEqual(ends, [
      { error: true, quiet: true },
      { error: true, quiet: false },
      { error: true, quiet: false },
    ]);
    const kept = (session.transcript as Array<{ role: string; quiet?: boolean }>).filter((e) => e.role === "tool").map((e) => e.quiet === true);
    assert.deepEqual(kept, [true, false, false], "what is saved says the same, so it comes back when the session is opened again");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("a success in between starts the count again", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-quiet-")));
  mkdirSync(projectDir(root), { recursive: true });
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  (session.toolContext.activatedTools ??= new Set()).add("governor");
  const bad = { name: "governor", args: { action: "remember_rule", value: "" } };
  const good = { name: "governor", args: { action: "remember_rule", value: "Use tabs, not spaces", name: "tabs" } };
  // Saving a rule asks the person; here they agree, so this call succeeds.
  session.toolContext.requestApproval = async () => "Yes";
  steps = [{ tool: bad }, { tool: good }, { tool: bad }, { text: "ok" }];
  seen = 0;
  session.transcript.push({ role: "user", content: "remember some rules" });
  const ends: boolean[] = [];
  try {
    await respond(session, {
      onEvent: (e) => {
        if (e.type === "tool" && e.phase === "end" && e.name === "governor") ends.push((e as { quiet?: boolean }).quiet === true);
      },
    });
    assert.deepEqual(ends, [true, false, true], "two failures with a success between are not a loop");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});
