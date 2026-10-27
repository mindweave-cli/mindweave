/**
 * process.test.ts — `mindweave -p` as a real process.
 *
 * run.test.ts covers the flow in-process. This covers what only a real process has: the launcher
 * routing `-p` away from the terminal program, stdin as a real pipe, streams that are not terminals,
 * and the exit status the shell sees. The model is still a scripted local server, and the child's
 * state folder is the test's own (testState.mjs), so it cannot find or use a real key.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allProviders } from "../drivers/registry.js";
import { listSessions } from "../memory/store.js";

const ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");
const MODEL = "gemini-3.7-flash";

let script: { text?: string; delayMs?: number }[] = [];
let bodies: string[] = [];
let server: Server;
let url = "";

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      bodies.push(raw);
      const reply = script.shift() ?? { text: "(script ran out)" };
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const SEP = String.fromCharCode(10, 10);
      const frames = [
        { choices: [{ delta: { content: reply.text ?? "" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
      ];
      for (const f of frames) res.write("data: " + JSON.stringify(f) + SEP);
      res.end("data: [DONE]" + SEP);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  script = [];
  bodies = [];
});

function project(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "mw-proc-")));
}

function env(withKey = true): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, MINDWEAVE_GEMINI_URL: url };
  for (const p of allProviders()) delete e[p.apiKeyEnv];
  if (withKey) e["GEMINI_API_KEY"] = "test-key";
  return e;
}

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

function mindweave(cwd: string, args: string[], opts: { stdin?: string | null; env?: NodeJS.ProcessEnv; killWhen?: () => boolean } = {}): Promise<Ran & { signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX, ENTRY, ...args], {
      cwd,
      env: opts.env ?? env(),
      stdio: [opts.stdin === null || opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (err += c));
    if (typeof opts.stdin === "string") child.stdin!.end(opts.stdin);
    // Signalled only once the run is really under way (the provider has the request), never during start-up,
    // where the default signal action would end the process before our handler exists.
    const watch = opts.killWhen ? setInterval(() => opts.killWhen!() && (clearInterval(watch), child.kill("SIGTERM")), 50) : undefined;
    const bail = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`mindweave did not finish. stdout so far: ${out.slice(0, 300)} stderr: ${err.slice(0, 300)}`));
    }, 60_000);
    child.on("close", (code, signal) => {
      clearTimeout(bail);
      if (watch) clearInterval(watch);
      resolve({ code, signal, out, err });
    });
  });
}

test("-p runs with no terminal at all: the answer alone on stdout, nothing on stderr, exit 0", async () => {
  script = [{ text: "pong" }];
  const r = await mindweave(project(), ["-p", "ping", "--model", MODEL]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "pong\n");
  assert.equal(r.err, "");
  assert.doesNotMatch(r.out + r.err, /\u001b/, "no terminal control sequences: the screen program was never started");
});

test("json from a real process is one parseable line", async () => {
  script = [{ text: "pong" }];
  const r = await mindweave(project(), ["-p", "ping", "--model", MODEL, "--output-format", "json"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.result, "pong");
  assert.equal(j.subtype, "success");
});

test("piped input reaches the model as context beside the typed task", async () => {
  script = [{ text: "reviewed" }];
  const r = await mindweave(project(), ["-p", "review this", "--model", MODEL], { stdin: "+a brand new line\n" });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "reviewed\n");
  assert.match(bodies[0]!, /review this/);
  assert.match(bodies[0]!, /\+a brand new line/);
});

test("piped input alone is the task", async () => {
  script = [{ text: "done" }];
  const r = await mindweave(project(), ["-p", "--model", MODEL], { stdin: "list the files" });
  assert.equal(r.code, 0, r.err);
  assert.match(bodies[0]!, /list the files/);
});

test("a typed task with stdin left open and silent does not hang: the first-byte grace ends", async () => {
  script = [{ text: "ok" }];
  // stdin is a pipe that is never written to or closed, as a CI runner or a parent process can leave it.
  const child = spawn(process.execPath, ["--import", TSX, ENTRY, "-p", "hi", "--model", MODEL], { cwd: project(), env: env(), stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const code = await new Promise<number | null>((resolve) => {
    const bail = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, 30_000);
    child.on("close", (c) => {
      clearTimeout(bail);
      resolve(c);
    });
  });
  assert.equal(code, 0, "it finished without stdin ever closing");
  assert.equal(out, "ok\n");
});

test("no task and no input: exit 2 and a sentence that says what to do", async () => {
  const r = await mindweave(project(), ["-p"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /nothing to do/);
  assert.equal(r.out, "", "nothing on stdout for a program to misread");
});

test("a mistyped flag is exit 2 naming the flag, and nothing runs", async () => {
  const r = await mindweave(project(), ["-p", "hi", "--mdoe", "architect"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown option: --mdoe/);
  assert.equal(bodies.length, 0);
});

test("no API key anywhere: exit 3, and the message names the variable to set", async () => {
  const r = await mindweave(project(), ["-p", "hi"], { env: env(false) });
  assert.equal(r.code, 3);
  assert.match(r.err, /no API key for/);
  assert.match(r.err, /_API_KEY/);
  assert.equal(bodies.length, 0);
});

test("the run is saved where the next one can continue it", async () => {
  const root = project();
  script = [{ text: "first" }, { text: "second" }];
  const a = JSON.parse((await mindweave(root, ["-p", "one", "--model", MODEL, "--output-format", "json"])).out);
  const b = JSON.parse((await mindweave(root, ["-p", "two", "--model", MODEL, "--continue", "--output-format", "json"])).out);
  assert.equal(b.session_id, a.session_id);
  assert.equal((await listSessions(root)).length, 1);
});

test("--help and --version still answer, and --help now describes -p", async () => {
  const help = await mindweave(project(), ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /mindweave -p "task"/);
  assert.match(help.out, /Exit codes: 0 done, 1 failed, 2 bad usage, 3 no API key, 4 stopped unfinished/);
  assert.equal((await mindweave(project(), ["--version"])).code, 0);
});

test("without -p and without a terminal, the old message and exit 1 are unchanged", async () => {
  const r = await mindweave(project(), []);
  assert.equal(r.code, 1);
  assert.match(r.err, /needs a terminal/);
});

test("SIGTERM stops the turn, saves the session and exits 143", { skip: process.platform === "win32" ? "Windows has no catchable SIGTERM" : false }, async () => {
  const root = project();
  script = [{ text: "too slow", delayMs: 20_000 }];
  const r = await mindweave(root, ["-p", "hi", "--model", MODEL, "--output-format", "json"], { killWhen: () => bodies.length > 0 });
  assert.equal(r.code, 143);
  assert.equal(JSON.parse(r.out).subtype, "interrupted");
  assert.equal((await listSessions(root)).length, 1);
});
