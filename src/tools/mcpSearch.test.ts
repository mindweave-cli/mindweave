/**
 * mcpSearch.test.ts — the door into a deferred catalog.
 *
 * The failure this guards is subtle: whatever the tool says back, the model has to draw
 * the right conclusion from it. A message that reads as "that failed" makes a model stop
 * searching and start guessing, which is exactly what the deferred pool exists to avoid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findTools } from "./mcpSearch.js";
import { toolSchemas } from "./registry.js";
import { McpManager } from "../mcp/manager.js";
import type { ToolContext } from "./types.js";

const ctxWith = (mcp?: McpManager): ToolContext => ({ mcp }) as unknown as ToolContext;

function fakeServer(count: number): string {
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
    if (msg.method === "server/discover") { send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersions: ["2026-07-28"], capabilities: {} } }); continue; }
    if (msg.method === "tools/list") {
      const tools = [];
      for (let i = 0; i < ${count}; i++) tools.push({ name: "tool_" + i, description: "does thing " + i });
      tools.push({ name: "create_issue", description: "Open a new issue" });
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      continue;
    }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
}

async function poolOf(count: number): Promise<McpManager> {
  const mgr = new McpManager();
  await mgr.start([{ type: "stdio", name: "big", command: process.execPath, args: ["-e", fakeServer(count)] }]);
  return mgr;
}

test("the tool is read-only and always present", () => {
  assert.equal(findTools.readOnly, true);
  assert.equal(findTools.name, "find_tools");
});

test("with no servers it says so plainly and points back to built-ins", async () => {
  const r = await findTools.execute({ query: "github" }, ctxWith());
  assert.equal(r.isError, undefined, "no servers is a normal answer, not an error");
  assert.match(r.output, /No MCP servers/);
});

test("searching a native tool ACTIVATES it, so it becomes advertised and callable", async () => {
  // The whole point of the fix: a strict function-calling model can only call a tool that
  // is in the request's tools array. find_tools must record what it surfaced so the tool
  // is added there — a schema shown only in the result is not enough.
  const ctx = { activatedTools: new Set<string>() } as unknown as ToolContext;
  const r = await findTools.execute({ query: "screenshot" }, ctx);
  assert.match(r.output, /screenshot/, "the search must surface the tool");
  assert.ok(ctx.activatedTools!.has("screenshot"), "find_tools must activate the surfaced native tool");

  // End to end: the very next tool list the engine builds with this ctx must now include
  // screenshot, so the model can actually emit the call it was told it could make.
  const names = (toolSchemas({ ctx }) as { name?: string; function?: { name?: string } }[]).map((s) => s.name ?? s.function?.name ?? "");
  assert.ok(names.includes("screenshot"), "a searched tool must be advertised on the next request, or it is callable in name only");
});

test("when nothing is deferred it tells the model not to bother", async () => {
  // Returning a result list here would teach the model it must search before calling
  // tools that are already sitting in its tool list.
  const mgr = await poolOf(2);
  try {
    const r = await findTools.execute({ query: "create issue" }, ctxWith(mgr));
    assert.match(r.output, /already loaded/);
    assert.match(r.output, /don't need this tool/);
  } finally {
    await mgr.dispose();
  }
});

test("a match is handed over callable, without touching the advertised list", async () => {
  const mgr = await poolOf(40);
  try {
    const before = JSON.stringify(mgr.snapshot().exposedSchemas());
    const r = await findTools.execute({ query: "create issue" }, ctxWith(mgr));
    assert.equal(r.isError, undefined);
    assert.match(r.output, /mcp__big__create_issue/, "the name the model must call");
    assert.match(r.output, /<function>/, "the schema has to come with it, or the name is unusable");

    // And the expensive half must NOT have happened. Advertising the match changes the
    // bytes the provider hashes, so the next request re-bills the entire cached prefix.
    assert.equal(JSON.stringify(mgr.snapshot().exposedSchemas()), before, "the search moved the tool list");
    assert.ok(mgr.snapshot().asTool("mcp__big__create_issue"), "and it must still be callable");
  } finally {
    await mgr.dispose();
  }
});

test("a miss is honest and tells the model to stop guessing", async () => {
  const mgr = await poolOf(40);
  try {
    const r = await findTools.execute({ query: "kubernetes" }, ctxWith(mgr));
    assert.equal(r.isError, undefined, "a miss is information, not a failure");
    assert.match(r.output, /No MCP tool matches/);
    // The important half: what to do next.
    assert.match(r.output, /solve it another way rather than guessing/);
  } finally {
    await mgr.dispose();
  }
});

test("a search cut off at the cap says so instead of looking exhaustive", async () => {
  // Search is the ONLY door to a deferred catalog. A model handed 8 of 41 tools with no
  // hint of the rest concludes the other 33 do not exist — and because they were never
  // returned they were never activated either, so nothing else can reveal them.
  const mgr = await poolOf(40);
  try {
    const r = await findTools.execute({ query: "big" }, ctxWith(mgr)); // bare server name
    assert.match(r.output, /top 8/, "a capped result must not read as the whole list");
    assert.match(r.output, /search again with a narrower term/);
    assert.ok(findTools.description.includes("at most 8 tools"), "the cap belongs in the description too");
  } finally {
    await mgr.dispose();
  }
});

test("a search that fits under the cap does NOT claim there is more", async () => {
  // The other half: warning every time would train the model to ignore it.
  const mgr = await poolOf(40);
  try {
    const r = await findTools.execute({ query: "create issue" }, ctxWith(mgr));
    assert.doesNotMatch(r.output, /top 8/);
  } finally {
    await mgr.dispose();
  }
});

test("an empty query is refused rather than matching everything", async () => {
  const r = await findTools.execute({ query: "  " }, ctxWith());
  assert.equal(r.isError, true);
});

test("loading a tool is never shown: every result is quiet, found or not", async () => {
  const ctx = { cwd: process.cwd(), reads: new Map(), todos: [] } as unknown as ToolContext;
  const found = await findTools.execute({ query: "screenshot" }, ctx);
  assert.equal(found.quiet, true);
  assert.match(found.output, /screenshot/, "the model still gets the schema");
  const none = await findTools.execute({ query: "zzzz-no-such-capability" }, ctx);
  assert.equal(none.quiet, true);
});
