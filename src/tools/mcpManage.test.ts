/**
 * mcpManage.test.ts — enable, disable, status and reconnect on a server that is already
 * configured.
 *
 * Written after an agent looped nine times on "not connected": `enable` always answered
 * "Its tools are available again" whatever happened, it had no way to ask WHY a server was
 * down, and the only restart it knew (disable, then enable) replaced the very connection
 * its tools were using. These pin the honest answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpServer } from "./mcpAdd.js";
import { McpManager } from "../mcp/manager.js";
import type { ToolContext } from "./types.js";

const GOOD_SERVER = [
  'let b="";const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",c=>{b+=c;let n;while((n=b.indexOf("\\n"))>=0){const l=b.slice(0,n);b=b.slice(n+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;',
  'if(m.method==="server/discover"){send({jsonrpc:"2.0",id:m.id,result:{protocolVersions:["2026-07-28"],capabilities:{}}});continue;}',
  'if(m.method==="tools/list"){send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"ping"}]}});continue;}',
  'if(m.method==="tools/call"){send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"pong"}]}});continue;}',
  'send({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found"}});}});',
].join("\n");

function ctxFor(cwd: string, mcp: McpManager, answer: "yes" | "no" = "yes"): ToolContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    cwd,
    asked,
    mcp,
    requestApproval: async (q: string, options: string[]) => {
      asked.push(q);
      return answer === "yes" ? options[0]! : options[1]!;
    },
  } as unknown as ToolContext & { asked: string[] };
}

async function withServer(run: (mgr: McpManager, cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "mw-mcpmanage-"));
  const mgr = new McpManager();
  try {
    const r = await mcpServer.execute(
      { name: "live", command: process.execPath, args: ["-e", GOOD_SERVER] },
      ctxFor(cwd, mgr),
    );
    assert.match(r.output, /connected with 1 tool/);
    await run(mgr, cwd);
  } finally {
    await mgr.dispose();
  }
}

test("enabling a server that is already up changes nothing and asks nothing", async () => {
  await withServer(async (mgr, cwd) => {
    const ctx = ctxFor(cwd, mgr);
    const r = await mcpServer.execute({ action: "enable", name: "live" }, ctx);
    assert.equal(ctx.asked.length, 0, "no question for a no-op");
    assert.match(r.output, /already enabled and connected with 1 tools/);
    assert.notEqual(r.isError, true);
    assert.equal(mgr.statuses()[0]!.state, "connected", "and the healthy connection was not torn down");
  });
});

test("disabling a server that is already disabled changes nothing and asks nothing", async () => {
  await withServer(async (mgr, cwd) => {
    await mcpServer.execute({ action: "disable", name: "live" }, ctxFor(cwd, mgr));
    const ctx = ctxFor(cwd, mgr);
    const r = await mcpServer.execute({ action: "disable", name: "live" }, ctx);
    assert.equal(ctx.asked.length, 0);
    assert.match(r.output, /already disabled/);
  });
});

test("enabling a server that does NOT start reports the failure, not 'available again'", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mw-mcpmanage-"));
  const mgr = new McpManager();
  try {
    await mcpServer.execute({ name: "broken", command: "definitely-not-a-real-binary-xyz" }, ctxFor(cwd, mgr));
    // Disable then enable, the way an agent restarts a server.
    await mcpServer.execute({ action: "disable", name: "broken" }, ctxFor(cwd, mgr));
    const r = await mcpServer.execute({ action: "enable", name: "broken" }, ctxFor(cwd, mgr));
    assert.equal(r.isError, true);
    assert.match(r.output, /did not connect: failed/);
    assert.match(r.output, /reconnect/);
    assert.doesNotMatch(r.output, /available again/);
  } finally {
    await mgr.dispose();
  }
});

test("status needs no name and no question, and shows the reason a server is down", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mw-mcpmanage-"));
  const mgr = new McpManager();
  try {
    await mcpServer.execute({ name: "broken", command: "definitely-not-a-real-binary-xyz" }, ctxFor(cwd, mgr));
    const ctx = ctxFor(cwd, mgr);
    const r = await mcpServer.execute({ action: "status" }, ctx);
    assert.equal(ctx.asked.length, 0, "reading state is not a question");
    assert.match(r.output, /broken: failed/);
    assert.match(r.output, /error: /, "the reason has to be in the answer");
    assert.notEqual(r.isError, true);

    const missing = await mcpServer.execute({ action: "status", name: "nope" }, ctx);
    assert.equal(missing.isError, true);
  } finally {
    await mgr.dispose();
  }
});

test("reconnect restarts a server without a question and without touching the config", async () => {
  await withServer(async (mgr, cwd) => {
    const ctx = ctxFor(cwd, mgr, "no"); // would refuse anything that asked
    const r = await mcpServer.execute({ action: "reconnect", name: "live" }, ctx);
    assert.equal(ctx.asked.length, 0);
    assert.match(r.output, /Reconnected 'live' with 1 tool/);
    assert.notEqual(r.isError, true);
    assert.equal(mgr.statuses()[0]!.state, "connected");
  });
});

test("reconnect on a disabled or unknown server says what to do instead", async () => {
  await withServer(async (mgr, cwd) => {
    const unknown = await mcpServer.execute({ action: "reconnect", name: "nope" }, ctxFor(cwd, mgr));
    assert.equal(unknown.isError, true);
    await mcpServer.execute({ action: "disable", name: "live" }, ctxFor(cwd, mgr));
    const off = await mcpServer.execute({ action: "reconnect", name: "live" }, ctxFor(cwd, mgr));
    assert.equal(off.isError, true);
    assert.match(off.output, /disabled/);
  });
});

test("the tool description tells the agent not to restart a server by disabling it", () => {
  assert.match(mcpServer.description, /do NOT disable, enable, remove or re-add/);
  assert.match(mcpServer.description, /status/);
  assert.match(mcpServer.description, /reconnect/);
});
