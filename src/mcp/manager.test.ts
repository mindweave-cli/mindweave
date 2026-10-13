/**
 * manager.test.ts — the pool, end to end, against real child processes.
 *
 * These run actual MCP servers (small node scripts) rather than mocks, because the
 * things worth proving are the things a mock would assume: that a server which refuses
 * to start does not take the session with it, that a dead server stops offering tools,
 * and that a tool failure comes back as a RESULT the model can read instead of an
 * exception that unwinds the turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpManager } from "./manager.js";
import { MAX_CONNECT_ATTEMPTS, RECONNECT_BACKOFF_MS, McpConnection, isAuthError } from "./connection.js";
import { RpcError } from "./transport/types.js";
import type { McpServerConfig } from "./config.js";

/**
 * A stdio MCP server. `legacy` speaks the pre-2026 handshake (no `server/discover`),
 * which is what most real servers still do.
 */
/**
 * Assert a server actually connected, quoting the server's own error if it did not.
 *
 * An assertion on the TOOL LIST alone reports an empty array and stops there, which
 * describes the symptom of a server that never started exactly as well as it describes
 * a genuine tools bug. The state and the error message are already carried on the
 * status; not reading them just throws away the diagnosis.
 */
function assertConnected(mgr: McpManager, name: string): void {
  const status = mgr.statuses().find((s) => s.name === name);
  assert.ok(status, `no status at all for server '${name}'`);
  assert.equal(
    status.state,
    "connected",
    `server '${name}' is ${status.state}${status.error ? ` — ${status.error}` : " with no error reported"}`,
  );
}

function serverScript(opts: { legacy?: boolean; failTool?: boolean } = {}): string {
  return `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "server/discover") {
      if (${opts.legacy ? "true" : "false"}) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }); continue; }
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersions: ["2026-07-28"], capabilities: {}, serverInfo: { name: "fake", version: "1.0.0" } } });
      continue;
    }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "old" } } });
      continue;
    }
    if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "peek", description: "read only", annotations: { readOnlyHint: true } }
      ] } });
      continue;
    }
    if (msg.method === "tools/call") {
      if (msg.params?.arguments?.kill) { process.exit(0); }
      if (${opts.failTool ? "true" : "false"}) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "tool exploded" } }); continue; }
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echoed:" + (msg.params?.arguments?.text ?? "") }] } });
      continue;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
}

/** Poll until `check` holds, so a test never depends on a fixed sleep. */
async function waitFor(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const stdio = (name: string, script: string): McpServerConfig => ({
  type: "stdio",
  name,
  command: process.execPath,
  args: ["-e", script],
});

test("a modern server connects, and its tools become ordinary tools", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript())]);
    const [status] = mgr.statuses();
    assert.equal(status!.state, "connected");
    assert.equal(status!.version, "2026-07-28");
    assert.equal(status!.legacy, false);
    assert.deepEqual(status!.serverInfo, { name: "fake", version: "1.0.0" });

    const names = mgr.toolSchemas().map((s) => s.function.name);
    assert.deepEqual(names, ["mcp__fake__echo", "mcp__fake__peek"]);

    const tool = mgr.asTool("mcp__fake__echo");
    assert.ok(tool);
    const result = await tool!.execute({ text: "hi" }, {} as never);
    // The server's text, wrapped as untrusted data (Phase 5) rather than returned bare.
    assert.match(result.output, /echoed:hi/);
    assert.match(result.output, /<mcp_result server="fake">/);
    assert.equal(result.isError, undefined);
  } finally {
    await mgr.dispose();
  }
});

test("a pre-stateless server works through the handshake fallback", async () => {
  // The case that covers most servers deployed today.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("old", serverScript({ legacy: true }))]);
    const [status] = mgr.statuses();
    assert.equal(status!.state, "connected");
    assert.equal(status!.version, "2025-06-18");
    assert.equal(status!.legacy, true);
    assert.equal(status!.toolCount, 2);
  } finally {
    await mgr.dispose();
  }
});

test("a server that cannot start is recorded, not thrown", async () => {
  // Best-effort is the whole contract: MCP is third-party code and must never be able
  // to stop the agent from running.
  const mgr = new McpManager();
  try {
    await mgr.start([{ type: "stdio", name: "broken", command: "definitely-not-a-real-binary-xyz", args: [] }]);
    const [status] = mgr.statuses();
    assert.equal(status!.state, "failed");
    assert.ok(status!.error);
    assert.deepEqual(mgr.toolSchemas(), []);
    assert.equal(mgr.asTool("mcp__broken__anything"), undefined);
  } finally {
    await mgr.dispose();
  }
});

test("one broken server does not cost the others their tools", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([
      { type: "stdio", name: "broken", command: "definitely-not-a-real-binary-xyz", args: [] },
      stdio("good", serverScript()),
    ]);
    const states = Object.fromEntries(mgr.statuses().map((s) => [s.name, s.state]));
    assert.equal(states.broken, "failed");
    assert.equal(states.good, "connected");
    assert.equal(mgr.toolCount(), 2);
  } finally {
    await mgr.dispose();
  }
});

test("a disabled server is listed but never connected", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([{ ...stdio("off", serverScript()), disabled: true }]);
    const [status] = mgr.statuses();
    assert.equal(status!.state, "disabled", "still visible, so /mcp can show it");
    assert.equal(mgr.toolCount(), 0);
  } finally {
    await mgr.dispose();
  }
});

test("a read-only turn is offered only the tools the server marked read-only", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript())]);
    // Check the CONNECTION before the tools. This test flaked once in a full suite run
    // — an empty tool list, in 662ms, far too fast to be a request timeout — and an
    // assertion on names alone cannot tell "the server connected and offered the wrong
    // tools" from "the server never came up". Those need opposite fixes, so the failure
    // has to say which it was. Reproduced in neither 8 isolated runs nor a memory
    // measurement (3.5GB free, 12 processes), so the next occurrence is the evidence.
    assertConnected(mgr, "fake");
    assert.deepEqual(
      mgr.toolSchemas(true).map((s) => s.function.name),
      ["mcp__fake__peek"],
    );
  } finally {
    await mgr.dispose();
  }
});

test("a failing tool returns an error RESULT, not an exception", async () => {
  // The model should see the failure and try something else, exactly as with a failed
  // shell command. Throwing here would unwind the turn instead.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript({ failTool: true }))]);
    const result = await mgr.asTool("mcp__fake__echo")!.execute({ text: "hi" }, {} as never);
    assert.equal(result.isError, true);
    assert.match(result.output, /tool exploded/);
  } finally {
    await mgr.dispose();
  }
});

test("a server that DIES mid-session stops offering tools", async () => {
  // Not dispose() — an actual process death, which is the case that matters and the
  // one a disposal test silently misses (disposal empties the pool anyway, so it
  // passes even when the connected-state check is gone).
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript())]);
    assert.equal(mgr.toolCount(), 2);

    // This tool kills the server without replying, so the call fails AND the transport
    // dies underneath us — exactly what a crashing server does.
    const result = await mgr.asTool("mcp__fake__echo")!.execute({ kill: true }, {} as never);
    assert.equal(result.isError, true, "the in-flight call fails rather than hanging");

    await waitFor(() => mgr.toolCount() === 0, "the dead server's tools to disappear");
    assert.equal(mgr.asTool("mcp__fake__echo"), undefined, "dispatching into a corpse must not be possible");
    assert.equal(mgr.statuses()[0]!.state, "pending", "a died server is revivable, not permanently failed");
  } finally {
    await mgr.dispose();
  }
});

test("a server named with dots is still addressable after normalization", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("acme.tools", serverScript())]);
    assert.ok(mgr.toolSchemas().some((s) => s.function.name === "mcp__acme_tools__echo"));
    assert.ok(mgr.asTool("mcp__acme_tools__echo"), "the normalized name must round-trip back to its server");
  } finally {
    await mgr.dispose();
  }
});

test("reconnect revives a server that was down", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([{ type: "stdio", name: "flaky", command: "definitely-not-a-real-binary-xyz", args: [] }]);
    assert.equal(mgr.statuses()[0]!.state, "failed");
    assert.equal(await mgr.reconnect("nope"), null, "an unknown server reports null rather than pretending");
    const status = await mgr.reconnect("flaky");
    assert.equal(status!.state, "failed", "still broken, but it did try again");
  } finally {
    await mgr.dispose();
  }
});

test("configFor returns the live config, for editing or for flipping disabled", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript())]);
    const config = mgr.configFor("fake");
    assert.equal(config?.type, "stdio");
    assert.equal(config?.name, "fake");
    assert.equal(mgr.configFor("no-such-server"), undefined, "unknown name reports undefined, not a throw");
  } finally {
    await mgr.dispose();
  }
});

test("removeServer stops the connection and drops it from statuses, not just from a file", async () => {
  // The gap this closes: removeServerFromConfig only ever edited mcp.json, so a removed
  // server's own comment said "it stays connected until this session ends" — Remove did
  // not actually stop anything running. This is the live half.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript())]);
    assertConnected(mgr, "fake");
    assert.equal(await mgr.removeServer("no-such-server"), false, "nothing to remove reports false");
    assert.equal(await mgr.removeServer("fake"), true);
    assert.equal(mgr.statuses().length, 0, "gone from the list, not just disconnected");
    assert.equal(mgr.toolCount(), 0, "its tools stop being offered immediately");
  } finally {
    await mgr.dispose();
  }
});

test("connect attempts are capped rather than retried forever", async () => {
  const connection = new McpConnection({ type: "stdio", name: "x", command: "definitely-not-a-real-binary-xyz", args: [] });
  for (let i = 0; i < MAX_CONNECT_ATTEMPTS + 3; i++) await connection.connect();
  assert.equal(connection.status().state, "failed");
  assert.ok(
    connection.status().attempts <= MAX_CONNECT_ATTEMPTS,
    `stopped at the cap instead of burning attempts (was ${connection.status().attempts})`,
  );
  await connection.close();
});

test("auth failures are classified apart from broken servers", () => {
  // `needs-auth` is a server waiting on the user; collapsing it into `failed` would
  // make the eventual auth flow look like an outage.
  assert.equal(isAuthError(new RpcError(-32001, "mcp http 401")), true);
  assert.equal(isAuthError(new RpcError(-32603, "mcp http 403 Forbidden")), true);
  assert.equal(isAuthError(new RpcError(-32603, "database is on fire")), false);
});

// ── Phase 2: lifecycle, notifications, and reconnect ────────────────────────────

/**
 * A server that can change its own tool list on demand. `grow` adds a tool and pushes
 * the change notification, which is what a real server does after (say) an auth step
 * unlocks more capability.
 */
const CHANGING_SERVER = `
let extra = false;
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "server/discover") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersions: ["2026-07-28"], capabilities: { tools: { listChanged: true } } } });
      continue;
    }
    if (msg.method === "subscriptions/listen") { send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }); continue; }
    if (msg.method === "tools/list") {
      const tools = [{ name: "base" }];
      if (extra) tools.push({ name: "bonus" });
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      continue;
    }
    if (msg.method === "tools/call" && msg.params?.name === "base") {
      extra = true;
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "grew" }] } });
      // Server-initiated: no id, nothing awaits it.
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      continue;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;

test("a tools/list_changed notification refreshes the catalog", async () => {
  // Without this the tool list is frozen at whatever the server said on connect, and a
  // server that gains tools mid-session may as well not have.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("changer", CHANGING_SERVER)]);
    assert.equal(mgr.toolCount(), 1);

    await mgr.asTool("mcp__changer__base")!.execute({}, {} as never);
    await waitFor(() => mgr.toolCount() === 2, "the catalog to pick up the new tool");
    assert.ok(mgr.asTool("mcp__changer__bonus"), "the newly-announced tool is dispatchable");
  } finally {
    await mgr.dispose();
  }
});

test("state changes are announced, so the UI can repaint", async () => {
  // Servers connect in the background; without this the /mcp view would only ever show
  // what was true when the last key was pressed.
  const mgr = new McpManager();
  let ticks = 0;
  try {
    mgr.setOnChange(() => ticks++);
    await mgr.start([stdio("fake", serverScript())]);
    assert.ok(ticks > 0, "connecting is a change worth painting");
    const before = ticks;
    await mgr.reconnect("fake");
    assert.ok(ticks > before, "so is reconnecting");
  } finally {
    await mgr.dispose();
  }
});

test("a died server is revived automatically", async () => {
  // The whole point of Phase 2: a crash should be a blip, not a permanent loss of the
  // server's tools with no explanation.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript())]);
    assert.equal(mgr.toolCount(), 2);

    await mgr.asTool("mcp__fake__echo")!.execute({ kill: true }, {} as never);
    await waitFor(() => mgr.toolCount() === 0, "the dead server to drop its tools");
    // The first backoff rung is 1s, so this is a real wait rather than a formality.
    await waitFor(() => mgr.statuses()[0]!.state === "connected", "the server to come back on its own", 8_000);
    assert.equal(mgr.toolCount(), 2, "and its tools with it");
  } finally {
    await mgr.dispose();
  }
});

test("automatic reconnect gives up rather than retrying forever", async () => {
  // A server that cannot come back does not come back on the tenth attempt, and quietly
  // burning attempts is how a session gets slow for a reason the user cannot see.
  const connection = new McpConnection({ type: "stdio", name: "x", command: "definitely-not-a-real-binary-xyz", args: [] });
  try {
    assert.ok(RECONNECT_BACKOFF_MS.length > 0);
    await connection.connect();
    assert.equal(connection.status().state, "failed");
    // Repeated manual connects must not exceed the cap either.
    for (let i = 0; i < 5; i++) await connection.connect();
    assert.ok(connection.status().attempts <= MAX_CONNECT_ATTEMPTS);
  } finally {
    await connection.close();
  }
});

test("close() stops a connection from reviving itself", async () => {
  // A disposed session must not leave timers resurrecting child processes behind it.
  const mgr = new McpManager();
  await mgr.start([stdio("fake", serverScript())]);
  await mgr.dispose();
  await new Promise((r) => setTimeout(r, 1_400)); // past the first backoff rung
  assert.equal(mgr.toolCount(), 0);
});

// ── Phase 3: context architecture ──────────────────────────────────────────────

test("the catalog serializes identically when nothing changed", async () => {
  // Tool schemas render BEFORE the providers' cache breakpoint, so the exact bytes are
  // the cached prefix. Two reads of an unchanged catalog differing by so much as key
  // order would mean paying for a fresh prompt every turn.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("b", serverScript()), stdio("a", serverScript())]);
    const first = JSON.stringify(mgr.snapshot().exposedSchemas());
    const second = JSON.stringify(mgr.snapshot().exposedSchemas());
    assert.equal(first, second);
    // And the order is by server, not by whichever process finished connecting first.
    assert.deepEqual(
      mgr.snapshot().exposedSchemas().map((s) => s.function.name),
      ["mcp__a__echo", "mcp__a__peek", "mcp__b__echo", "mcp__b__peek"],
    );
  } finally {
    await mgr.dispose();
  }
});

test("a snapshot keeps offering what it advertised, even after the server dies", async () => {
  // The bug this exists to stop: the model is told it has a tool, the server dies
  // mid-turn, and dispatch then refuses a tool we had just offered. Contradicting
  // ourselves is worse than failing honestly.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript())]);
    const turn = mgr.snapshot();
    assert.equal(turn.toolCount, 2);

    await mgr.asTool("mcp__fake__echo")!.execute({ kill: true }, {} as never);
    await waitFor(() => mgr.toolCount() === 0, "the server to be gone");

    // Live lookup correctly reports nothing…
    assert.equal(mgr.asTool("mcp__fake__echo"), undefined);
    // …but the turn that already advertised it can still dispatch. The call finds the
    // server down and brings it back, as Claude Code's does, instead of failing a call
    // against a server that is one restart away from working.
    const tool = turn.asTool("mcp__fake__echo");
    assert.ok(tool, "the snapshot must not retract a tool mid-turn");
    const result = await tool!.execute({ text: "hi" }, {} as never);
    assert.notEqual(result.isError, true, `the call must revive the server: ${result.output}`);
    assert.match(result.output, /hi/);
  } finally {
    await mgr.dispose();
  }
});

test("a snapshot is frozen against a mid-turn catalog change", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("changer", CHANGING_SERVER)]);
    const turn = mgr.snapshot();
    assert.equal(turn.toolCount, 1);

    await mgr.asTool("mcp__changer__base")!.execute({}, {} as never);
    await waitFor(() => mgr.toolCount() === 2, "the live catalog to grow");

    // The live pool grew; the turn's advertised list did not, because the model was
    // never told about the new tool and must not be surprised by it mid-turn.
    assert.equal(turn.exposedSchemas().length, 1);
    assert.equal(mgr.snapshot().toolCount, 2, "the NEXT turn picks it up");
  } finally {
    await mgr.dispose();
  }
});

test("the catalog's token cost is reported, so compaction can see it", async () => {
  // The bars measure the transcript only. Without this correction a large catalog makes
  // every threshold fire that much too late.
  const mgr = new McpManager();
  try {
    assert.equal(mgr.estimatedTokens(), 0, "no servers, no cost");
    await mgr.start([stdio("fake", serverScript())]);
    assert.ok(mgr.estimatedTokens() > 0, "a real catalog has a real cost");
    assert.equal(mgr.estimatedTokens(), mgr.snapshot().tokens());
  } finally {
    await mgr.dispose();
  }
});

// ── Phase 4: deferred tool pool ────────────────────────────────────────────────

/** A server advertising `count` tools, to push a catalog past the deferral threshold. */
function bigServerScript(count: number): string {
  return serverScript().replace(
    /if \(msg\.method === "tools\/list"\) \{[\s\S]*?continue;\n    \}/,
    `if (msg.method === "tools/list") {
      const tools = [];
      for (let i = 0; i < ${count}; i++) tools.push({ name: "tool_" + i, description: "does thing " + i });
      tools.push({ name: "create_issue", description: "Open a new issue" });
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      continue;
    }`,
  );
}

test("a small catalog is advertised in full, with nothing deferred", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("fake", serverScript())]);
    const turn = mgr.snapshot();
    assert.equal(turn.deferred, false);
    assert.equal(turn.exposedSchemas().length, 2, "both tools visible without searching");
  } finally {
    await mgr.dispose();
  }
});

test("a large catalog is held back until searched", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("big", bigServerScript(40))]);
    const turn = mgr.snapshot();
    assert.equal(turn.deferred, true);
    assert.equal(turn.toolCount, 41, "the catalog is all there…");
    assert.equal(turn.exposedSchemas().length, 0, "…but none of it is advertised yet");
    // The whole point: the model is not asked to choose among 41 tools.
    assert.equal(turn.tokens(), 0, "and none of it is billed");
  } finally {
    await mgr.dispose();
  }
});

test("searching activates a tool, and it is callable from the next step", async () => {
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("big", bigServerScript(40))]);
    const turn = mgr.snapshot();
    const found = mgr.searchCatalogTools("create issue");
    assert.ok(
      found.some((d: { name: string }) => d.name === "create_issue"),
      `found ${found.map((d: { name: string }) => d.name).join(", ")}`,
    );

    // The advertised list does NOT move — that is what keeps the cached prefix intact.
    // The tool is callable because dispatch resolves against the catalog, and because
    // the search result handed the model its full schema.
    assert.equal(turn.exposedSchemas().length, 0, "a search must not change the advertised list");
    assert.ok(turn.asTool("mcp__big__create_issue"), "a searched tool must be callable immediately");
  } finally {
    await mgr.dispose();
  }
});

test("searching leaves the advertised list byte-identical", async () => {
  // The regression this guards is the expensive one. Advertising a found tool changes
  // the `tools` array, and the provider hashes that array as the head of its cached
  // prefix — so one search re-billed the system prompt and the whole conversation too.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("big", bigServerScript(40))]);
    const before = JSON.stringify(mgr.snapshot().exposedSchemas());
    mgr.searchCatalogTools("create issue");
    assert.equal(JSON.stringify(mgr.snapshot().exposedSchemas()), before, "the search moved the tool list");
  } finally {
    await mgr.dispose();
  }
});

test("a deferred tool the model names correctly is still callable", async () => {
  // Wider than the advertised list on purpose: refusing a tool the model named
  // correctly, because it skipped the search, is a worse failure than letting it run.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("big", bigServerScript(40))]);
    const turn = mgr.snapshot();
    assert.equal(turn.exposedSchemas().length, 0);
    assert.ok(turn.asTool("mcp__big__create_issue"), "guessed-but-correct names must work");
    assert.equal(turn.asTool("mcp__big__no_such_tool"), undefined);
  } finally {
    await mgr.dispose();
  }
});

test("a deferred catalog is not billed to the compaction budget", async () => {
  // Counting tools the model never receives would make every threshold fire early.
  const mgr = new McpManager();
  try {
    await mgr.start([stdio("big", bigServerScript(40))]);
    assert.equal(mgr.estimatedTokens(), 0, "hidden tools cost nothing");
    mgr.searchCatalogTools("create issue");
    assert.equal(mgr.estimatedTokens(), 0, "and searching does not start sending them either");
  } finally {
    await mgr.dispose();
  }
});

// ── The "not connected" loop (2026-10-12) ─────────────────────────────────────────────
// An agent added a server, then every call it made said "not connected" while the server
// was healthy. The turn's snapshot had bound each tool to the connection object that
// existed when the turn began; the agent's own enable/disable/add replaced that object, so
// the tools pointed at a closed connection for the rest of the turn, and "restarting" the
// server only made it certain. Claude Code resolves the connection when the call runs.

test("a tool offered before its server was REPLACED still works (the same turn)", async () => {
  const mgr = new McpManager();
  try {
    const config = stdio("fake", serverScript());
    await mgr.addServer(config);
    const turn = mgr.snapshot();
    const before = await turn.asTool("mcp__fake__echo")!.execute({ text: "one" }, {} as never);
    assert.match(before.output, /echoed:one/);

    // What enable / disable / re-add do: close the connection and build another.
    await mgr.addServer({ ...config, disabled: true });
    await mgr.addServer(config);
    assertConnected(mgr, "fake");

    const after = await turn.asTool("mcp__fake__echo")!.execute({ text: "two" }, {} as never);
    assert.notEqual(after.isError, true, `the old snapshot must reach the new connection: ${after.output}`);
    assert.match(after.output, /echoed:two/);
  } finally {
    await mgr.dispose();
  }
});

test("a server added AFTER the turn's snapshot is callable in that turn", async () => {
  const mgr = new McpManager();
  try {
    const turn = mgr.snapshot(); // nothing connected yet
    assert.equal(turn.asTool("mcp__late__echo"), undefined);
    await mgr.addServer(stdio("late", serverScript()));
    const tool = turn.asTool("mcp__late__echo");
    assert.ok(tool, "a tool that exists must not be 'no such tool' because the turn began first");
    assert.match((await tool!.execute({ text: "hi" }, {} as never)).output, /echoed:hi/);
  } finally {
    await mgr.dispose();
  }
});

test("a call to a server that was REMOVED says so instead of 'not connected'", async () => {
  const mgr = new McpManager();
  try {
    await mgr.addServer(stdio("fake", serverScript()));
    const tool = mgr.snapshot().asTool("mcp__fake__echo")!;
    await mgr.removeServer("fake");
    const r = await tool.execute({ text: "hi" }, {} as never);
    assert.equal(r.isError, true);
    assert.match(r.output, /not configured any more/);
    assert.doesNotMatch(r.output, /is not connected/);
  } finally {
    await mgr.dispose();
  }
});

test("a down server's error says why and names the way out (status, reconnect)", async () => {
  const conn = new McpConnection({ type: "stdio", name: "rea", command: "definitely-not-a-real-binary-xyz", args: [] });
  await conn.connect();
  const message = conn.notRunningMessage();
  assert.match(message, /'rea' is not running \(failed/);
  assert.match(message, /status/);
  assert.match(message, /reconnect/);
  assert.match(message, /do not disable, enable or remove/);
  await conn.close();
});

test("the manager's revision moves when a server comes, goes or is replaced", async () => {
  const mgr = new McpManager();
  try {
    const r0 = mgr.revision();
    await mgr.addServer(stdio("fake", serverScript()));
    const r1 = mgr.revision();
    assert.ok(r1 > r0, "adding a server must move it");
    await mgr.removeServer("fake");
    assert.ok(mgr.revision() > r1, "removing one must too");
  } finally {
    await mgr.dispose();
  }
});

test("a tool call is not held to the 30 second protocol limit", async () => {
  const { toolTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS } = await import("./transport/types.js");
  assert.ok(toolTimeoutMs() > DEFAULT_REQUEST_TIMEOUT_MS * 5, "a slow tool (analysing a binary) must be allowed to run");
  const saved = process.env.MINDWEAVE_MCP_TOOL_TIMEOUT_MS;
  try {
    process.env.MINDWEAVE_MCP_TOOL_TIMEOUT_MS = "45000";
    assert.equal(toolTimeoutMs(), 45_000);
    process.env.MINDWEAVE_MCP_TOOL_TIMEOUT_MS = "garbage";
    assert.ok(toolTimeoutMs() > DEFAULT_REQUEST_TIMEOUT_MS);
  } finally {
    if (saved === undefined) delete process.env.MINDWEAVE_MCP_TOOL_TIMEOUT_MS;
    else process.env.MINDWEAVE_MCP_TOOL_TIMEOUT_MS = saved;
  }
});

test("Esc reaches a tool call that is waiting on a slow server", async () => {
  // The turn awaits the tool, and a tool that ignored the abort signal left the whole
  // session stuck (no way to stop it) until the server answered or the timeout ran out.
  const script = `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === "server/discover") { send({ jsonrpc: "2.0", id: m.id, result: { protocolVersions: ["2026-07-28"], capabilities: {} } }); continue; }
    if (m.method === "tools/list") { send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "slow" }] } }); continue; }
    if (m.method === "tools/call") continue; // never answers
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
  }
});`;
  const mgr = new McpManager();
  try {
    await mgr.addServer(stdio("slowpoke", script));
    assertConnected(mgr, "slowpoke");
    const controller = new AbortController();
    const started = Date.now();
    const run = mgr.asTool("mcp__slowpoke__slow")!.execute({}, { abortSignal: controller.signal } as never);
    setTimeout(() => controller.abort(), 150);
    const result = await run;
    assert.ok(Date.now() - started < 5_000, "Esc must not wait out the tool");
    assert.equal(result.isError, true);
    assert.match(result.output, /cancelled/);
    // And the server is still usable afterwards: an abort is not a crash.
    assert.equal(mgr.statuses()[0]!.state, "connected");
  } finally {
    await mgr.dispose();
  }
});
