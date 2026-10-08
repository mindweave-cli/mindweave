/**
 * truncationRecovery.test.ts — a reply cut off at the output limit is carried on.
 *
 * It used to end the turn and wait for the person to type "continue". Now what arrived is
 * kept and the model is asked to resume directly, up to three times a turn.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TRUNCATION_RECOVERIES, TRUNCATION_NUDGE, respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";

const SEP = String.fromCharCode(10, 10);
/** Per request, what the provider does: cut the reply off, or finish it. */
let script: ("cut" | "finish")[] = [];
let requests: string[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const mode = script[requests.length] ?? "finish";
      requests.push(body);
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const text = mode === "cut" ? `part ${requests.length} of the answer, cut off mid-sen` : "and that is the end of it.";
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + SEP);
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: mode === "cut" ? "length" : "stop" }], usage }) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

async function turn() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-trunc-")));
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  session.transcript.push({ role: "user", content: "write the long answer" });
  const activity: string[] = [];
  try {
    const reply = await respond(session, { onActivity: (line) => activity.push(line) });
    return { reply, session, activity };
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
}

test("a cut-off reply is carried on, and what arrived is kept", async () => {
  script = ["cut", "cut", "finish"];
  requests = [];
  const { reply, session, activity } = await turn();
  assert.equal(requests.length, 3);
  assert.equal(reply, "and that is the end of it.");
  const said = session.transcript.filter((e) => e.role === "assistant").map((e) => e.content);
  assert.ok(said[0]!.startsWith("part 1") && said[1]!.startsWith("part 2"), `the cut parts were not kept: ${JSON.stringify(said)}`);
  assert.ok(session.transcript.some((e) => e.role === "user" && e.content === TRUNCATION_NUDGE));
  assert.ok(requests[2]!.includes("Resume directly"), "the model was not told to resume");
  assert.equal(activity.filter((a) => /output limit/.test(a)).length, 2);
});

test("after three recoveries in one turn it pauses for the person, as it always did", async () => {
  script = ["cut", "cut", "cut", "cut", "cut"];
  requests = [];
  const { reply } = await turn();
  assert.equal(requests.length, MAX_TRUNCATION_RECOVERIES + 1);
  assert.match(reply, /Paused/);
  assert.match(reply, /output limit/);
});
