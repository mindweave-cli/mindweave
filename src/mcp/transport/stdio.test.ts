/**
 * stdio.test.ts — framing against a real child process.
 *
 * The framing is the part that fails silently: MCP uses newline-delimited JSON while
 * the language servers elsewhere in this codebase use LSP `Content-Length` headers, and
 * getting it wrong produces a hang rather than an error. So the line splitter is tested
 * as a pure function against the ugly cases a pipe actually delivers, and the transport
 * is then driven end-to-end against a small node script standing in for a server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcError } from "./types.js";
import { StdioTransport, drainLines, frame, quoteForCmd, windowsCommandLine, windowsNeedsShell } from "./stdio.js";

test("a frame ends with a newline, or the server waits forever", () => {
  assert.equal(frame({ a: 1 }), '{"a":1}\n');
});

test("drainLines handles the shapes a pipe actually delivers", () => {
  // Several messages in one chunk.
  assert.deepEqual(drainLines('{"a":1}\n{"b":2}\n'), { lines: ['{"a":1}', '{"b":2}'], rest: "" });
  // A message split across chunks: the remainder must be kept, not dropped.
  assert.deepEqual(drainLines('{"a":1}\n{"b":'), { lines: ['{"a":1}'], rest: '{"b":' });
  // Blank lines are noise.
  assert.deepEqual(drainLines("\n\n"), { lines: [], rest: "" });
  assert.deepEqual(drainLines(""), { lines: [], rest: "" });
});

test("bare launcher names need a shell on Windows, real executables do not", () => {
  // `npx` is the one that matters: it is how nearly every MCP server in the wild is
  // configured, it exists only as `npx.cmd`, and `spawn` does not apply PATHEXT.
  assert.equal(windowsNeedsShell("npx"), true);
  assert.equal(windowsNeedsShell("npx.cmd"), true);
  assert.equal(windowsNeedsShell("uvx"), true);
  assert.equal(windowsNeedsShell("server.bat"), true);
  assert.equal(windowsNeedsShell("node.exe"), false);
  assert.equal(windowsNeedsShell(String.raw`C:\Program Files\nodejs\node.exe`), false);
});

test("cmd quoting keeps an argument with a space in one piece", () => {
  // The old code joined args with a plain space, so this argument silently became two.
  assert.equal(quoteForCmd(String.raw`C:\Program Files\x`), '"C:\\Program Files\\x"');
  assert.equal(quoteForCmd("-y"), "-y");
  assert.equal(quoteForCmd("@scope/server"), "@scope/server");
  assert.equal(quoteForCmd(""), '""');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
  assert.equal(
    windowsCommandLine("npx", ["-y", "@scope/server", String.raw`C:\Program Files\root`]),
    'npx -y @scope/server "C:\\Program Files\\root"',
  );
});

test("a PATHEXT-only launcher starts and speaks, rather than dying with ENOENT", { skip: process.platform !== "win32" }, async () => {
  // The regression this guards is the whole Windows story: a server configured the
  // ordinary way (`"command": "npx"`) could not start at all. Driven through a `.cmd`
  // shim on PATH so it exercises the real resolution path, not a spelled-out extension.
  const dir = await fs.mkdtemp(join(tmpdir(), "mindweave-mcp-shim-"));
  const script = join(dir, "server.js");
  await fs.writeFile(script, FAKE_SERVER, "utf8");
  await fs.writeFile(join(dir, "fakemcp.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");

  const t = new StdioTransport({
    command: "fakemcp", // no extension, no path — exactly how npx is configured
    timeoutMs: 10_000,
    env: { PATH: `${dir};${process.env.PATH ?? ""}` },
  });
  try {
    const result = (await t.request("tools/list")) as { echoed: string };
    assert.equal(result.echoed, "tools/list");
  } finally {
    await t.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A minimal MCP-shaped server: echoes a result, errors on `boom`, prints a banner. */
const FAKE_SERVER = `
process.stdout.write("starting up, not JSON\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "notify_only") { process.stderr.write("got notify\\n"); continue; }
    if (msg.method === "boom") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method, params: msg.params ?? null } }) + "\\n");
  }
});
`;

function connect(): StdioTransport {
  return new StdioTransport({ command: process.execPath, args: ["-e", FAKE_SERVER], timeoutMs: 5_000 });
}

test("a request round-trips, and stdout noise is ignored", async () => {
  const t = connect();
  try {
    // The server prints a non-JSON banner first. Servers really do this, and treating
    // it as fatal would break them all.
    const result = (await t.request("tools/list", { a: 1 })) as { echoed: string; params: unknown };
    assert.equal(result.echoed, "tools/list");
    assert.deepEqual(result.params, { a: 1 });
  } finally {
    await t.close();
  }
});

test("concurrent requests resolve to their OWN replies", async () => {
  const t = connect();
  try {
    const [a, b, c] = await Promise.all([t.request("one"), t.request("two"), t.request("three")]);
    assert.equal((a as { echoed: string }).echoed, "one");
    assert.equal((b as { echoed: string }).echoed, "two");
    assert.equal((c as { echoed: string }).echoed, "three");
  } finally {
    await t.close();
  }
});

test("a JSON-RPC error rejects with its code intact", async () => {
  const t = connect();
  try {
    // The code is what `discover.ts` reads to decide a server is pre-stateless, so it
    // has to survive the transport rather than being flattened into a message.
    await assert.rejects(() => t.request("boom"), (e: unknown) => e instanceof RpcError && e.code === -32601);
  } finally {
    await t.close();
  }
});

test("a request times out instead of wedging the turn", async () => {
  // A server that accepts input and never answers. Without the timeout this hangs the
  // agent, which is worse than any error.
  const t = new StdioTransport({
    command: process.execPath,
    args: ["-e", "process.stdin.resume();"],
    timeoutMs: 150,
  });
  try {
    await assert.rejects(() => t.request("tools/list"), /timeout/);
  } finally {
    await t.close();
  }
});

test("a command that does not exist fails cleanly and reports closed", async () => {
  const t = new StdioTransport({ command: "definitely-not-a-real-binary-xyz", timeoutMs: 2_000 });
  await assert.rejects(() => t.request("tools/list"));
  await t.closed; // resolves rather than hanging
  await t.close();
});

test("a dead server fails in-flight requests instead of leaving them pending", async () => {
  const t = new StdioTransport({ command: process.execPath, args: ["-e", "process.exit(0);"], timeoutMs: 5_000 });
  await assert.rejects(() => t.request("tools/list"), /exited|closed|start/);
  await t.close();
});

test("requests after close are refused, not silently dropped", async () => {
  const t = connect();
  await t.close();
  await assert.rejects(() => t.request("tools/list"), /closed/);
});

test("a per-request limit overrides the transport default", async () => {
  // Tool calls get a long limit while the protocol's own requests keep the short one.
  const t = new StdioTransport({ command: process.execPath, args: ["-e", "process.stdin.resume();"], timeoutMs: 60_000 });
  try {
    await assert.rejects(() => t.request("tools/call", undefined, undefined, 120), /timeout after 120ms/);
  } finally {
    await t.close();
  }
});

test("aborting a request rejects it at once and tells the server to stop", async () => {
  // Esc has to reach a tool call that is minutes into slow work. The server here never
  // answers, so the only way out is the abort.
  const t = new StdioTransport({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', (d) => process.stderr.write(d)); process.stdin.resume();"],
    timeoutMs: 60_000,
  });
  try {
    const controller = new AbortController();
    const started = Date.now();
    const pending = t.request("tools/call", { name: "slow" }, undefined, 60_000, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(() => pending, (e: Error & { code?: number }) => e.code === -32800 && /cancelled/.test(e.message));
    assert.ok(Date.now() - started < 3_000, "it must not wait for the server or the timeout");
    // The server was told which request to drop.
    for (let i = 0; i < 50 && !/notifications\/cancelled/.test(t.stderr()); i++) await new Promise((r) => setTimeout(r, 40));
    assert.match(t.stderr(), /notifications\/cancelled/);
    assert.match(t.stderr(), /"requestId":1/);
  } finally {
    await t.close();
  }
});

test("a request whose signal is already aborted never goes out", async () => {
  const t = new StdioTransport({ command: process.execPath, args: ["-e", "process.stdin.resume();"], timeoutMs: 5_000 });
  try {
    await assert.rejects(() => t.request("tools/call", undefined, undefined, undefined, AbortSignal.abort()), /cancelled/);
  } finally {
    await t.close();
  }
});
