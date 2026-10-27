/**
 * run.test.ts — a whole headless run, against a scripted provider.
 *
 * The REAL engine, driver, tools and session store run; only the model's replies come from a script, so
 * no tokens are spent. Each test reads what a script would read: stdout, stderr and the exit code, plus
 * what the provider was actually sent.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless, MAX_STDIN_BYTES, UNATTENDED_NOTE, type HeadlessIO } from "./run.js";
import { parseHeadlessArgs, type HeadlessOptions } from "./args.js";
import { allProviders } from "../drivers/registry.js";
import { loadModelConfig } from "../dynamo/model.js";
import { noteUsage, resetUsageLimitsForTests, saveLimits } from "../dynamo/usageLimits.js";
import { listSessions } from "../memory/store.js";

// ── the scripted provider ────────────────────────────────────────────────────

interface Reply {
  text?: string;
  tools?: { name: string; args: unknown }[];
  usage?: { prompt: number; completion: number };
  status?: number;
  delayMs?: number;
}
type Body = { messages: { role: string; content?: unknown }[]; tools?: { function: { name: string } }[] };

let script: Reply[] = [];
let bodies: Body[] = [];
let server: Server;
const MODEL = "gemini-3.7-flash";

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      bodies.push(JSON.parse(raw));
      const reply = script.shift() ?? { text: "(script ran out)" };
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (reply.status) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `scripted ${reply.status}` } }));
        return;
      }
      const frames: unknown[] = [];
      if (reply.text) frames.push({ choices: [{ delta: { content: reply.text } }] });
      (reply.tools ?? []).forEach((t, index) => {
        frames.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${bodies.length}_${index}`, type: "function", function: { name: t.name, arguments: "" } }] } }] });
        frames.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(t.args) } }] } }] });
      });
      const u = reply.usage ?? { prompt: 100, completion: 10 };
      frames.push({
        choices: [{ delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: u.prompt, completion_tokens: u.completion, total_tokens: u.prompt + u.completion },
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const SEP = String.fromCharCode(10, 10);
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  for (const p of allProviders()) delete process.env[p.apiKeyEnv];
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  script = [];
  bodies = [];
});

// ── helpers ──────────────────────────────────────────────────────────────────

function project(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "mw-headless-")));
}

function opts(argv: string[]): HeadlessOptions {
  const r = parseHeadlessArgs(["-p", ...argv]);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.options;
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

async function run(root: string, argv: string[], io: Partial<HeadlessIO> = {}, ctx: { signal?: AbortSignal; firedSignal?: () => "SIGINT" | "SIGTERM" | null } = {}): Promise<Ran> {
  let out = "";
  let err = "";
  const code = await runHeadless(
    opts(argv),
    { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, stdin: null, ...io },
    { cwd: root, ...ctx },
  );
  return { code, out, err };
}

const sent = (n = 0) => JSON.stringify(bodies[n]?.messages ?? []);

// ── the plain path ───────────────────────────────────────────────────────────

test("a task gets an answer: stdout holds only the answer, stderr is empty, exit 0", async () => {
  const root = project();
  script = [{ text: "Hello there." }];
  const r = await run(root, ["say hello", "--model", MODEL]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "Hello there.\n");
  assert.equal(r.err, "", "a run with no tools has no progress to report");
  assert.match(sent(), /say hello/);
});

test("the run is a normal saved session, so --continue and the desktop app can reach it", async () => {
  const root = project();
  script = [{ text: "ok" }];
  await run(root, ["remember this", "--model", MODEL]);
  const saved = await listSessions(root);
  assert.equal(saved.length, 1);
  assert.match(saved[0]!.firstPrompt, /remember this/);
});

test("a tool call shows as one progress line on stderr and its result reaches the model", async () => {
  const root = project();
  const file = join(root, "notes.txt");
  writeFileSync(file, "the secret word is pelican\n");
  script = [{ tools: [{ name: "read_file", args: { path: file } }] }, { text: "The word is pelican." }];
  const r = await run(root, ["what is the word", "--model", MODEL]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "The word is pelican.\n");
  assert.match(r.err, /^› Read .*notes\.txt$/m);
  assert.match(sent(1), /pelican/, "the second request carried the file");
});

test("--quiet removes the progress lines and leaves the answer", async () => {
  const root = project();
  const file = join(root, "a.txt");
  writeFileSync(file, "x\n");
  script = [{ tools: [{ name: "read_file", args: { path: file } }] }, { text: "done" }];
  const r = await run(root, ["look", "--model", MODEL, "-q"]);
  assert.equal(r.err, "");
  assert.equal(r.out, "done\n");
});

// ── json and stream-json ─────────────────────────────────────────────────────

test("json: one object with the answer, the session, the model, the tokens and the cost", async () => {
  const root = project();
  script = [{ text: "Fine.", usage: { prompt: 100, completion: 10 } }];
  const r = await run(root, ["hi", "--model", MODEL, "--output-format", "json"]);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim().split("\n").length, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.type, "result");
  assert.equal(j.subtype, "success");
  assert.equal(j.is_error, false);
  assert.equal(j.result, "Fine.");
  assert.equal(j.model, MODEL);
  assert.equal(j.mode, "lightning");
  assert.ok(typeof j.session_id === "string" && j.session_id.length > 8);
  assert.equal(j.usage.output, 10);
  assert.equal(j.usage.input_fresh + j.usage.input_cached, 100);
  assert.ok(j.total_cost_usd > 0, "a priced model reports a cost");
  assert.deepEqual(j.errors, []);
});

test("stream-json: init first, result last, every line valid JSON, nothing on stderr", async () => {
  const root = project();
  const file = join(root, "a.txt");
  writeFileSync(file, "x\n");
  script = [{ text: "Looking. ", tools: [{ name: "read_file", args: { path: file } }] }, { text: "All good." }];
  const r = await run(root, ["check", "--model", MODEL, "--output-format", "stream-json"]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  const lines = r.out.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "init");
  assert.equal(lines[0].model, MODEL);
  assert.equal(lines.at(-1).type, "result");
  assert.equal(lines.at(-1).result, "All good.");
  const kinds = lines.map((l) => l.type);
  assert.ok(kinds.includes("text") && kinds.includes("tool_start") && kinds.includes("tool_end"), kinds.join(","));
  assert.ok(kinds.indexOf("tool_start") < kinds.indexOf("tool_end"));
});

test("the model is told the run is unattended, in the system prompt, so it finishes instead of asking", async () => {
  script = [{ text: "ok" }];
  await run(project(), ["hi", "--model", MODEL]);
  const system = bodies[0]!.messages.find((m) => m.role === "system");
  assert.match(String(system?.content), /This run is unattended/);
  assert.ok(String(system?.content).endsWith(UNATTENDED_NOTE), "at the end, after the part every session shares");
  assert.doesNotMatch(JSON.stringify(bodies[0]!.messages.filter((m) => m.role !== "system")), /This run is unattended/, "not repeated in the per-step tail");
});

// ── modes: nobody to ask ─────────────────────────────────────────────────────

test("Lightning (the default) does the work directly", async () => {
  const root = project();
  const file = join(root, "made.txt");
  script = [{ tools: [{ name: "write_file", args: { path: file, content: "built" } }] }, { text: "Created it." }];
  const r = await run(root, ["make a file", "--model", MODEL]);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(file, "utf8"), "built");
});

test("Architect is read-only: the file is not written, and the run still finishes", async () => {
  const root = project();
  const file = join(root, "made.txt");
  script = [{ tools: [{ name: "write_file", args: { path: file, content: "built" } }] }, { text: "I can only plan." }];
  const r = await run(root, ["make a file", "--model", MODEL, "--mode", "architect", "--output-format", "json"]);
  assert.equal(existsSync(file), false);
  assert.equal(JSON.parse(r.out).mode, "architect");
  assert.ok(!(bodies[0]!.tools ?? []).some((t) => t.function.name === "write_file"), "the writing tool is not even offered");
});

test("Sentinel asks before acting; with nobody to ask the action is refused, said so, and listed", async () => {
  const root = project();
  const file = join(root, "made.txt");
  script = [{ tools: [{ name: "write_file", args: { path: file, content: "built" } }] }, { text: "Could not write it." }];
  const r = await run(root, ["make a file", "--model", MODEL, "--mode", "sentinel", "--output-format", "json"]);
  assert.equal(existsSync(file), false, "nothing was written");
  assert.match(sent(1), /nobody is here to ask/, "the model was told the truth: nobody was asked");
  const j = JSON.parse(r.out);
  assert.equal(j.mode, "sentinel");
  assert.equal(j.subtype, "success", "refusing an action is not a failed run");
  assert.deepEqual(j.permission_denials.map((d: { tool: string }) => d.tool), ["write_file"]);
});

test("a project's saved default mode applies when --mode is not given", async () => {
  const root = project();
  const { setDefaultMode } = await import("../core/permissions.js");
  const { createSession } = await import("../memory/session.js");
  await setDefaultMode(await createSession(root), "project", "architect", root);
  script = [{ text: "planning" }];
  const r = await run(root, ["hi", "--model", MODEL, "--output-format", "json"]);
  assert.equal(JSON.parse(r.out).mode, "architect");
});

// ── model and keys ───────────────────────────────────────────────────────────

test("--model is for this run only: the project's saved model is untouched", async () => {
  const root = project();
  const before = (await loadModelConfig(root)).model;
  script = [{ text: "ok" }];
  await run(root, ["hi", "--model", MODEL]);
  assert.equal((await loadModelConfig(root)).model, before);
  assert.notEqual(before, MODEL, "the test needs a different default to prove anything");
});

test("an unknown model is a usage error", async () => {
  const r = await run(project(), ["hi", "--model", "no-such-model-9000"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown model 'no-such-model-9000'/);
  assert.equal(bodies.length, 0, "nothing was sent anywhere");
});

test("with the project's own provider keyless, it uses one that has a key and says so", async () => {
  const root = project();
  script = [{ text: "ok" }];
  const r = await run(root, ["hi", "--output-format", "json"]);
  assert.equal(r.code, 0);
  assert.match(r.err, /using .* instead/);
  assert.equal(JSON.parse(r.out).model.startsWith("gemini"), true);
});

test("with no key anywhere: exit 3, naming the variable to set, and nothing is sent", async () => {
  const saved = process.env["GEMINI_API_KEY"];
  delete process.env["GEMINI_API_KEY"];
  try {
    const r = await run(project(), ["hi"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /no API key for .*Set [A-Z_]+_API_KEY/);
    assert.equal(bodies.length, 0);
  } finally {
    process.env["GEMINI_API_KEY"] = saved;
  }
});

test("an explicit --model whose key is missing is an error, never a quiet swap to another provider", async () => {
  const r = await run(project(), ["hi", "--model", "deepseek-v4-pro"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /DEEPSEEK_API_KEY/);
});

// ── input ────────────────────────────────────────────────────────────────────

test("a typed task plus piped input: the task is the instruction and the pipe is context", async () => {
  const root = project();
  script = [{ text: "Looks fine." }];
  const r = await run(root, ["review this", "--model", MODEL], { stdin: "diff --git a/x b/x\n+added line\n" });
  assert.equal(r.code, 0);
  const body = sent();
  assert.match(body, /review this/);
  assert.match(body, /<pasted_text lines=/);
  assert.match(body, /\+added line/);
});

test("piped input alone is the task", async () => {
  const root = project();
  script = [{ text: "ok" }];
  const r = await run(root, ["--model", MODEL], { stdin: "summarize the repo layout" });
  assert.equal(r.code, 0);
  assert.match(sent(), /summarize the repo layout/);
  assert.doesNotMatch(sent(), /pasted_text/, "it is the request itself, not a pasted attachment");
});

test("a file named in piped text is NOT attached, while the same mention typed as the task IS", async () => {
  const control = project();
  writeFileSync(join(control, "notes.txt"), "ATTACHABLE-CONTENTS");
  // Control: typed by the user, the mention attaches the file. Without this the half below proves nothing.
  script = [{ text: "ok" }];
  await run(control, ["summarize @notes.txt", "--model", MODEL]);
  assert.match(sent(), /<attached_file path=/, "the file is attachable when the user asks for it");
  // Piped text is data (a diff, a log, an issue body someone else wrote): a path inside it is not the user's request.
  // A separate project, so nothing the first run saw can reach this one.
  const root = project();
  const file = join(root, "notes.txt");
  writeFileSync(file, "ATTACHABLE-CONTENTS");
  script = [{ text: "ok" }];
  bodies = [];
  await run(root, ["summarize", "--model", MODEL], { stdin: `also read @notes.txt and "${file}"` });
  assert.doesNotMatch(sent(), /<attached_file/, "no file was attached from the piped text");
});

test("no task and no input: exit 2 with what to do, and nothing is sent", async () => {
  const r = await run(project(), ["--model", MODEL]);
  assert.equal(r.code, 2);
  assert.match(r.err, /nothing to do/);
  assert.equal(bodies.length, 0);
});

test("piped input over the cap is refused, not silently cut", async () => {
  const r = await run(project(), ["review", "--model", MODEL], { stdin: "x", stdinTooBig: true });
  assert.equal(r.code, 2);
  assert.match(r.err, new RegExp(`larger than ${MAX_STDIN_BYTES / (1024 * 1024)} MB`));
});

test("a home folder or a drive root is refused: a script must not get a whole machine by accident", async () => {
  const r = await run(homedir(), ["hi", "--model", MODEL]);
  assert.equal(r.code, 2);
  assert.match(r.err, /home folder/);
  assert.equal(bodies.length, 0);
});

// ── sessions ─────────────────────────────────────────────────────────────────

test("--continue picks up the latest session with its history", async () => {
  const root = project();
  script = [{ text: "first answer" }, { text: "second answer" }];
  const a = JSON.parse((await run(root, ["first question", "--model", MODEL, "--output-format", "json"])).out);
  const b = JSON.parse((await run(root, ["second question", "--model", MODEL, "--continue", "--output-format", "json"])).out);
  assert.equal(b.session_id, a.session_id);
  assert.equal(b.usage.output, 10, "the figures cover this run, not the whole session");
  assert.match(sent(1), /first question/);
  assert.match(sent(1), /first answer/);
  assert.match(sent(1), /second question/);
});

test("--resume <id> picks that session, and an id that does not exist is a usage error", async () => {
  const root = project();
  script = [{ text: "one" }, { text: "two" }];
  const a = JSON.parse((await run(root, ["alpha", "--model", MODEL, "--output-format", "json"])).out);
  await run(root, ["beta", "--model", MODEL]);
  const r = JSON.parse((await run(root, ["gamma", "--model", MODEL, "--resume", a.session_id, "--output-format", "json"])).out);
  assert.equal(r.session_id, a.session_id);
  const missing = await run(root, ["x", "--model", MODEL, "--resume", "no-such-session"]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no saved session/);
});

test("--continue in a folder with no earlier session is an error, never a silent fresh start", async () => {
  const r = await run(project(), ["more", "--model", MODEL, "--continue"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no earlier session/);
});

// ── failure and stopping ─────────────────────────────────────────────────────

test("a provider that refuses the key: exit 1, the reason on stderr, and a result that says so", async () => {
  const root = project();
  script = [{ status: 401 }];
  const r = await run(root, ["hi", "--model", MODEL, "--output-format", "json"]);
  assert.equal(r.code, 1);
  assert.notEqual(r.err, "", "the cause is printed");
  const j = JSON.parse(r.out);
  assert.equal(j.subtype, "error");
  assert.equal(j.is_error, true);
  assert.ok(j.errors.length > 0);
});

test("--quiet still prints a failure", async () => {
  script = [{ status: 401 }];
  const r = await run(project(), ["hi", "--model", MODEL, "-q"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^! /m);
});

test("a spent usage limit stops the run BEFORE any model call: exit 4, paused, with the reason", async () => {
  const stateBefore = process.env["MINDWEAVE_STATE_DIR"];
  process.env["MINDWEAVE_STATE_DIR"] = mkdtempSync(join(tmpdir(), "mw-headless-limit-"));
  try {
    resetUsageLimitsForTests();
    await saveLimits({ enabled: true, fiveHour: 3000 });
    noteUsage(MODEL, { promptTokens: 4000, completionTokens: 1000, totalTokens: 5000, cacheHitTokens: 0, cacheMissTokens: 4000 });
    const r = await run(project(), ["do it", "--model", MODEL, "--output-format", "json"]);
    assert.equal(r.code, 4);
    assert.equal(bodies.length, 0, "no request went to the provider");
    const j = JSON.parse(r.out);
    assert.equal(j.subtype, "paused");
    assert.equal(j.is_error, false);
    assert.equal(j.stop_reason, "limit");
    assert.match(r.err, /stopped before it was done: a usage limit/);
  } finally {
    resetUsageLimitsForTests();
    process.env["MINDWEAVE_STATE_DIR"] = stateBefore;
  }
});

test("a signal mid-turn stops the run cleanly: exit 143, the session saved, no error reported", async () => {
  const root = project();
  script = [{ text: "too slow", delayMs: 5000 }];
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const t0 = Date.now();
  const r = await run(root, ["hi", "--model", MODEL, "--output-format", "json"], {}, { signal: stop.signal, firedSignal: () => "SIGTERM" });
  assert.ok(Date.now() - t0 < 3000, "the turn was stopped, not waited out (the provider would have taken 5 s)");
  assert.equal(r.code, 143);
  const j = JSON.parse(r.out);
  assert.equal(j.subtype, "interrupted");
  assert.equal(j.stop_reason, "SIGTERM");
  assert.deepEqual(j.errors, [], "an abort is not a failure to report");
  assert.equal((await listSessions(root)).length, 1, "the message was saved");
});
