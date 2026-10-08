/**
 * hooks.test.ts — the user's own commands at five moments of a turn.
 *
 * Real hook scripts, run by real processes, through the real loop against a local provider.
 * What matters: a hook can refuse a call or a message, add a note to a result, say "not yet" to a
 * finishing reply, and add context at the start; one that hangs or crashes never wedges the turn;
 * and a hooks file that arrives inside a repository is never read.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretHook, matchesTool, parseHooks, runHook } from "./hooks.js";
import { respond } from "./engine.js";
import { createSession } from "../memory/session.js";
import { projectDir, stateRoot } from "../memory/store.js";
import { stopChassis } from "../alternator/lane.js";

// ── pure ────────────────────────────────────────────────────────────────────

test("a hooks file is parsed leniently; anything malformed is dropped, not thrown on", () => {
  const cfg = parseHooks(
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "run_command|edit", command: "node a.js", timeoutMs: 999_999_999 }, { command: "" }, "nope", { matcher: "x" }],
        Stop: [{ command: "npm test" }],
        Unknown: [{ command: "x" }],
      },
    }),
  );
  assert.deepEqual(Object.keys(cfg), ["PreToolUse", "Stop"]);
  assert.equal(cfg.PreToolUse!.length, 1);
  assert.ok(cfg.PreToolUse![0]!.timeoutMs! <= 10 * 60_000, "the time limit is capped");
  assert.deepEqual(parseHooks("not json"), {});
  assert.deepEqual(parseHooks('{"hooks": []}'), {});
});

test("a matcher is a tool name, several joined by |, or everything", () => {
  assert.equal(matchesTool(undefined, "edit"), true);
  assert.equal(matchesTool("*", "edit"), true);
  assert.equal(matchesTool("run_command|edit", "EDIT"), true);
  assert.equal(matchesTool("run_command|edit", "read_file"), false);
});

test("exit 2 blocks with stderr; JSON can block or add context; other codes are the hook's own problem", () => {
  assert.deepEqual(interpretHook(2, "", "no force pushes\n", false), { block: true, reason: "no force pushes", context: "", problem: null });
  const json = interpretHook(0, JSON.stringify({ decision: "block", reason: "tests are red", additionalContext: "see CI" }), "", false);
  assert.equal(json.block, true);
  assert.equal(json.reason, "tests are red");
  assert.equal(json.context, "see CI");
  assert.deepEqual(interpretHook(0, "plain context text\n", "", false), { block: false, reason: "", context: "plain context text", problem: null });
  assert.match(interpretHook(1, "", "boom", false).problem!, /exited with code 1: boom/);
  assert.equal(interpretHook(1, "", "boom", false).block, false, "a broken hook stops nothing");
  assert.match(interpretHook(null, "", "", true).problem!, /timed out/);
});

// ── real processes ───────────────────────────────────────────────────────────

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-hooks-")));
const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return `node "${path}"`;
};

test("a hook reads one JSON object on stdin and its exit code decides", async () => {
  const cmd = script("echo.js", `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);console.error("saw "+i.tool_name+" in "+i.hook_event_name);process.exit(2)})`);
  const out = await runHook({ command: cmd }, { tool_name: "run_command", tool_input: {} }, dir, "PreToolUse");
  assert.equal(out.block, true);
  assert.equal(out.reason, "saw run_command in PreToolUse");
});

test("a hook that hangs is stopped at its time limit, and one that cannot start is reported, neither wedges", async () => {
  const t0 = Date.now();
  const hung = await runHook({ command: script("hang.js", "setInterval(()=>{},1000)"), timeoutMs: 400 }, {}, dir, "Stop");
  assert.match(hung.problem ?? "", /timed out/);
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
  assert.equal(hung.block, false);

  const missing = await runHook({ command: "this-command-does-not-exist-xyz" }, {}, dir, "Stop");
  assert.equal(missing.block, false);
  assert.ok(missing.problem, "a command that fails to run is reported");
});

test("a hook does not see the provider keys Mindweave loaded", async () => {
  process.env["DEEPSEEK_API_KEY"] = "sk-FAKE-hook-key";
  try {
    const cmd = script("env.js", `console.log(process.env.DEEPSEEK_API_KEY ? "LEAKED" : "clean")`);
    const out = await runHook({ command: cmd }, {}, dir, "SessionStart");
    assert.equal(out.context, "clean");
  } finally {
    delete process.env["DEEPSEEK_API_KEY"];
  }
});

// ── through the loop ─────────────────────────────────────────────────────────

const SEP = String.fromCharCode(10, 10);
type Step = { tool?: { name: string; args: Record<string, unknown> }; text?: string };
let steps: Step[] = [];
let bodies: string[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const step = steps[bodies.length] ?? { text: "done" };
      bodies.push(body);
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = step.tool
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${bodies.length}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] } }] },
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

after(() => server.close());

/** A project with the user's hooks (in the STATE folder, where they belong) and a session in it. */
async function project(hooks: Record<string, unknown>) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-hookproj-")));
  mkdirSync(projectDir(root), { recursive: true });
  writeFileSync(join(projectDir(root), "hooks.json"), JSON.stringify({ hooks }));
  const session = await createSession(root);
  session.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  return { root, session };
}
const say = (session: Awaited<ReturnType<typeof project>>["session"], text: string) => session.transcript.push({ role: "user", content: text });
const toolOutputs = (session: Awaited<ReturnType<typeof project>>["session"]) => session.transcript.filter((e) => e.role === "tool").map((e) => e.content).join("\n");

test("PreToolUse refuses a call before it runs, and the model is told why", async () => {
  const { root, session } = await project({ PreToolUse: [{ matcher: "write_file", command: script("deny.js", `console.error("files are written by the build, not by you");process.exit(2)`) }] });
  steps = [{ tool: { name: "write_file", args: { path: "out.txt", content: "x" } } }, { text: "ok" }];
  bodies = [];
  say(session, "write out.txt");
  try {
    await respond(session, {});
    assert.equal(existsSync(join(root, "out.txt")), false, "the call ran despite the hook");
    assert.match(toolOutputs(session), /Blocked by a hook the user set up: files are written by the build/);
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("PostToolUse adds a note to the result the model reads", async () => {
  const { root, session } = await project({ PostToolUse: [{ matcher: "read_file", command: script("note.js", `console.log(JSON.stringify({additionalContext:"remember: this file is generated"}))`) }] });
  writeFileSync(join(root, "a.txt"), "hello\n");
  steps = [{ tool: { name: "read_file", args: { paths: ["a.txt"] } } }, { text: "ok" }];
  bodies = [];
  say(session, "read a.txt");
  try {
    await respond(session, {});
    assert.match(toolOutputs(session), /hello/);
    assert.match(toolOutputs(session), /\[A hook the user set up added: remember: this file is generated\]/);
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("a Stop hook can say 'not yet', up to three times, and then the turn finishes", async () => {
  const counter = join(dir, "stops.txt");
  writeFileSync(counter, "");
  const cmd = script("stop.js", `require("fs").appendFileSync(${JSON.stringify(counter)},"x");console.error("run the tests first");process.exit(2)`);
  const { session } = await project({ Stop: [{ command: cmd }] });
  steps = [{ text: "all done" }, { text: "still done" }, { text: "really done" }, { text: "finished" }, { text: "never reached" }];
  bodies = [];
  say(session, "do the thing");
  try {
    const reply = await respond(session, {});
    assert.equal(bodies.length, 4, "three sends back to work, then the fourth reply is accepted");
    assert.equal(reply, "finished");
    assert.equal(readCount(counter), 3, "the hook ran three times, not on the accepted reply");
    assert.ok(session.transcript.some((e) => e.role === "user" && e.content.includes("says not to finish yet: run the tests first")));
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});
const readCount = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").length : 0);

test("UserPromptSubmit can refuse a message before the model sees it", async () => {
  const { session } = await project({ UserPromptSubmit: [{ command: script("nope.js", `console.error("not on a Friday");process.exit(2)`) }] });
  steps = [{ text: "should not be asked" }];
  bodies = [];
  say(session, "deploy to production");
  try {
    const reply = await respond(session, {});
    assert.match(reply, /stopped this message: not on a Friday/);
    assert.equal(bodies.length, 0, "the model was asked anyway");
    assert.equal(session.transcript.some((e) => e.content === "deploy to production"), false);
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("SessionStart and UserPromptSubmit context reaches the model, SessionStart once", async () => {
  const { session } = await project({
    SessionStart: [{ command: script("start.js", `console.log("project note: use pnpm")`) }],
    UserPromptSubmit: [{ command: script("sub.js", `console.log("branch: main")`) }],
  });
  steps = [{ text: "first" }, { text: "second" }];
  bodies = [];
  say(session, "hello");
  try {
    await respond(session, {});
    say(session, "again");
    await respond(session, {});
    assert.ok(bodies[0]!.includes("project note: use pnpm") && bodies[0]!.includes("branch: main"));
    assert.ok(!bodies[1]!.slice(bodies[1]!.lastIndexOf("again")).includes("project note"), "SessionStart ran twice");
    const added = session.transcript.filter((e) => e.role === "user" && e.content.includes("[Added by hooks"));
    assert.equal(added.length, 2, "once with both, once with the prompt hook alone");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
});

test("a hooks file that arrives inside the repository is never read", async () => {
  const { root, session } = await project({});
  mkdirSync(join(root, ".mindweave"), { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  const planted = JSON.stringify({ hooks: { UserPromptSubmit: [{ command: script("planted.js", `console.error("planted hook ran");process.exit(2)`) }] } });
  writeFileSync(join(root, ".mindweave", "hooks.json"), planted);
  writeFileSync(join(root, "hooks.json"), planted);
  writeFileSync(join(root, ".claude", "settings.json"), planted);
  steps = [{ text: "hello" }];
  bodies = [];
  say(session, "hi");
  try {
    const reply = await respond(session, {});
    assert.equal(reply, "hello", "a planted hook ran");
    assert.equal(bodies.length, 1);
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
  }
  assert.ok(stateRoot().length > 0);
});

test("hooksOverview lists both files' hooks with their scope and where each file lives", async () => {
  const { hooksOverview } = await import("./hooks.js");
  const { writeFileSync, mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { projectDir, stateRoot } = await import("../memory/store.js");
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "hook-ov-"));
  const cwd = mkdtempSync(join(tmpdir(), "hook-ov-proj-"));
  mkdirSync(projectDir(cwd), { recursive: true });
  writeFileSync(join(stateRoot(), "hooks.json"), JSON.stringify({ hooks: { Stop: [{ command: "npm test --silent" }] } }));
  writeFileSync(join(projectDir(cwd), "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "run_command|edit", command: "node check.js" }] } }));
  const o = await hooksOverview(cwd);
  assert.deepEqual(o.rows, [
    { event: "Stop", matcher: "*", command: "npm test --silent", scope: "global" },
    { event: "PreToolUse", matcher: "run_command|edit", command: "node check.js", scope: "project" },
  ]);
  assert.equal(o.files.global, join(stateRoot(), "hooks.json"));
  assert.equal(o.files.project, join(projectDir(cwd), "hooks.json"));
  // Nothing configured is an empty list, not an error.
  assert.deepEqual((await hooksOverview(mkdtempSync(join(tmpdir(), "hook-ov-none-")))).rows.filter((r) => r.scope === "project"), []);
});
