/**
 * mcpAdd.test.ts — adding a server by asking for it.
 *
 * This tool writes a config that spawns a process on every future session, usually with
 * a credential attached. So the tests are mostly about the gate: it must ask, it must
 * refuse when it cannot ask, and a decline must leave nothing behind on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpServer } from "./mcpAdd.js";
import { McpManager } from "../mcp/manager.js";
import { projectConfigPath, parseMcpConfig } from "../mcp/config.js";
import type { ToolContext } from "./types.js";

function ctxIn(cwd: string, answer?: string, mcp?: McpManager): ToolContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    cwd,
    asked,
    mcp,
    ...(answer
      ? {
          requestApproval: async (q: string, options: string[]) => {
            asked.push(q);
            return answer === "yes" ? options[0]! : options[1]!;
          },
        }
      : {}),
  } as unknown as ToolContext & { asked: string[] };
}

const project = () => mkdtempSync(join(tmpdir(), "mw-mcpadd-"));

test("it ASKS before writing anything", async () => {
  const cwd = project();
  const ctx = ctxIn(cwd, "yes");
  const r = await mcpServer.execute({ name: "github", command: "npx", args: ["-y", "pkg"] }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(ctx.asked.length, 1);
  // The question has to say what will actually happen, not just "add a server?".
  assert.match(ctx.asked[0]!, /npx -y pkg/);
  assert.match(ctx.asked[0]!, /every session/);

  const loaded = parseMcpConfig(await fs.readFile(projectConfigPath(cwd), "utf8"));
  assert.deepEqual(loaded.map((c) => c.name), ["github"]);
});

test("replacing an existing server SAYS so before asking, not afterwards", async () => {
  // "Add this server?" answered yes must not quietly overwrite a working integration
  // the user already set up. The code knew it was a replacement — it just reported it
  // once the write had happened.
  const cwd = project();
  const ctx = ctxIn(cwd, "yes");
  await mcpServer.execute({ name: "github", command: "npx", args: ["-y", "old"] }, ctx);
  assert.doesNotMatch(ctx.asked[0]!, /REPLACE/, "the first add is not a replacement");

  await mcpServer.execute({ name: "github", command: "npx", args: ["-y", "new"] }, ctx);
  assert.match(ctx.asked[1]!, /REPLACE the existing MCP server 'github'/);

  const loaded = parseMcpConfig(await fs.readFile(projectConfigPath(cwd), "utf8"));
  assert.equal(loaded.length, 1, "still one server, now the new one");
});

test("the credential PROMPT names the keys and never the values", async () => {
  // The thing that makes this ask-first-worthy is precisely what the question hid.
  // Showing a value would also write the secret into the saved transcript, so keys
  // only — the same line the rest of the codebase draws between naming and printing.
  const cwd = project();
  const ctx = ctxIn(cwd, "yes");
  await mcpServer.execute(
    { name: "gh", command: "npx", env: { GITHUB_TOKEN: "ghp_supersecret_value" } },
    ctx,
  );
  assert.match(ctx.asked[0]!, /GITHUB_TOKEN/, "the user must know a credential is being stored");
  assert.doesNotMatch(ctx.asked[0]!, /ghp_supersecret_value/, "the secret must not reach the screen");
  assert.match(ctx.asked[0]!, /plain text/);
});

test("a server with no credentials does not mention storing any", async () => {
  const cwd = project();
  const ctx = ctxIn(cwd, "yes");
  await mcpServer.execute({ name: "plain", command: "npx" }, ctx);
  assert.doesNotMatch(ctx.asked[0]!, /plain text/);
});

test("env values are stored verbatim, and the description says they are not expanded", async () => {
  // MEASURED: nothing in the MCP layer expands $VAR, and the transport merges the
  // configured env over the inherited one. The old description told the model to
  // "reference an environment variable" and showed "$GITHUB_TOKEN", which reaches the
  // server as those literal characters and fails as a bad credential.
  const cwd = project();
  await mcpServer.execute(
    { name: "gh", command: "npx", env: { TOKEN: "$FROM_SHELL" } },
    ctxIn(cwd, "yes"),
  );
  const raw = JSON.parse(await fs.readFile(projectConfigPath(cwd), "utf8"));
  assert.equal(raw.mcpServers.gh.env.TOKEN, "$FROM_SHELL", "stored verbatim — nothing expands it");
  assert.match(mcpServer.description, /NOT expanded/);
  assert.match(mcpServer.description, /inherits the user's whole environment/);
});

test("a flag-shaped name is rejected where the cause is knowable", async () => {
  const cwd = project();
  const r = await mcpServer.execute({ name: "--global", command: "npx" }, ctxIn(cwd, "yes"));
  assert.equal(r.isError, true);
  assert.match(r.output, /starts with a dash/);
});

test("declining writes NOTHING", async () => {
  const cwd = project();
  const r = await mcpServer.execute({ name: "github", command: "npx" }, ctxIn(cwd, "no"));
  assert.equal(r.isError, undefined, "a decline is a normal outcome, not an error");
  assert.match(r.output, /Not added/);
  assert.equal(existsSync(projectConfigPath(cwd)), false, "no file should have been created at all");
});

test("with no approval channel it refuses and tells the user the command", async () => {
  // Fails closed, like every other governed action — and leaves the user a way forward
  // rather than a dead end.
  const cwd = project();
  const r = await mcpServer.execute({ name: "github", command: "npx", args: ["-y", "pkg"] }, ctxIn(cwd));
  assert.equal(r.isError, true);
  assert.match(r.output, /\/mcp add github npx -y pkg/);
  assert.equal(existsSync(projectConfigPath(cwd)), false);
});

test("bad arguments are refused before the user is bothered", async () => {
  const cwd = project();
  for (const args of [{ name: "x" }, { name: "x", command: "c", url: "https://a" }, { name: "", command: "c" }]) {
    const ctx = ctxIn(cwd, "yes");
    const r = await mcpServer.execute(args, ctx);
    assert.equal(r.isError, true, `${JSON.stringify(args)} should be refused`);
    assert.equal(ctx.asked.length, 0, "no prompt for input we already know is wrong");
  }
});

test("a URL becomes a remote server", async () => {
  const cwd = project();
  const r = await mcpServer.execute(
    { name: "remote", url: "https://x.dev/mcp", headers: { Authorization: "Bearer t" } },
    ctxIn(cwd, "yes"),
  );
  assert.equal(r.isError, undefined);
  const [loaded] = parseMcpConfig(await fs.readFile(projectConfigPath(cwd), "utf8"));
  assert.equal(loaded!.type, "http");
  assert.deepEqual(loaded!.type === "http" ? loaded!.headers : null, { Authorization: "Bearer t" });
});

test("a server's own flags survive, because args go through `--`", async () => {
  const cwd = project();
  await mcpServer.execute({ name: "srv", command: "my-cmd", args: ["--global", "--http"] }, ctxIn(cwd, "yes"));
  const [loaded] = parseMcpConfig(await fs.readFile(projectConfigPath(cwd), "utf8"));
  assert.deepEqual(loaded!.type === "stdio" ? loaded!.args : null, ["--global", "--http"]);
});

test("a real server is CONNECTED immediately, not left for a restart", async () => {
  // Writing the file and saying "restart to use it" would defeat the whole point.
  const cwd = project();
  const script = [
    'let b="";const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data",c=>{b+=c;let n;while((n=b.indexOf("\\n"))>=0){const l=b.slice(0,n);b=b.slice(n+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;',
    'if(m.method==="server/discover"){send({jsonrpc:"2.0",id:m.id,result:{protocolVersions:["2026-07-28"],capabilities:{}}});continue;}',
    'if(m.method==="tools/list"){send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"ping"}]}});continue;}',
    'send({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found"}});}});',
  ].join("\n");

  const mgr = new McpManager();
  try {
    const r = await mcpServer.execute(
      { name: "live", command: process.execPath, args: ["-e", script] },
      ctxIn(cwd, "yes", mgr),
    );
    assert.match(r.output, /connected with 1 tool/);
    assert.ok(mgr.asTool("mcp__live__ping"), "and usable right away");
  } finally {
    await mgr.dispose();
  }
});

test("a server that fails to start is saved, and the failure is reported honestly", async () => {
  const cwd = project();
  const mgr = new McpManager();
  try {
    const r = await mcpServer.execute(
      { name: "broken", command: "definitely-not-a-real-binary-xyz" },
      ctxIn(cwd, "yes", mgr),
    );
    assert.equal(r.isError, undefined);
    assert.match(r.output, /saved, but it is failed/);
    // Saved anyway: a typo is fixed by editing the config, not by re-adding from scratch.
    assert.deepEqual(parseMcpConfig(await fs.readFile(projectConfigPath(cwd), "utf8")).map((c) => c.name), ["broken"]);
  } finally {
    await mgr.dispose();
  }
});
