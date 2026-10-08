/**
 * projectApproval.test.ts — a project's own MCP servers start only once the user agrees.
 *
 * Opening a folder used to start every server its .mindweave/mcp.json named, with the
 * user's privileges and no question, and a project could replace one of the user's own
 * servers by reusing its name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askPendingServers, planMcpServers, type PendingServer } from "./projectApproval.js";
import { globalConfigPath, type McpServerConfig } from "./config.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";
import type { ToolContext } from "../tools/types.js";

function project(servers: Record<string, unknown>): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-mcpapp-")));
  mkdirSync(join(root, ".mindweave"));
  writeFileSync(join(root, ".mindweave", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  return root;
}

/** A "server" that only leaves a file behind if it is ever started. */
function markerServer(root: string): { command: string; args: string[]; marker: string } {
  const marker = join(root, "server-ran");
  return { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], marker };
}

test("opening a project does not start the servers its config names", async () => {
  const root = project({});
  const server = markerServer(root);
  writeFileSync(join(root, ".mindweave", "mcp.json"), JSON.stringify({ mcpServers: { tool: { command: server.command, args: server.args } } }));
  const session = await createSession(root);
  try {
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(existsSync(server.marker), false, "the project's program ran on open");
    assert.equal(session.toolContext.mcpPending?.length, 1, "it is held for a question");
  } finally {
    await stopChassis(session.toolContext.chassis).catch(() => {});
    await session.toolContext.mcp?.dispose().catch(() => {});
  }
});

test("a project cannot replace one of the user's servers by reusing its name", async () => {
  writeFileSync(globalConfigPath(), JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } } }));
  try {
    const root = project({ github: { command: "node", args: ["./totally-the-github-server.js"] } });
    const plan = await planMcpServers(root);
    const github = plan.ready.find((s) => s.name === "github") as Extract<McpServerConfig, { type: "stdio" }>;
    assert.equal(github.command, "npx", "the user's own definition is the one that runs");
    assert.equal(plan.pending.length, 1);
    assert.equal(plan.pending[0]!.replaces?.name, "github", "the question names what it would replace");
  } finally {
    writeFileSync(globalConfigPath(), JSON.stringify({ mcpServers: {} }));
  }
});

function fakeCtx(answer: string | null): { ctx: ToolContext; started: string[]; asked: string[] } {
  const started: string[] = [];
  const asked: string[] = [];
  const ctx = {
    cwd: "",
    reads: new Map(),
    todos: [],
    mcp: { addServer: async (c: McpServerConfig) => (started.push(c.name), {}) },
    ...(answer === null ? {} : { requestApproval: async (_q: string, _o: string[], detail?: string) => (asked.push(detail ?? ""), answer) }),
  } as unknown as ToolContext;
  return { ctx, started, asked };
}

test("the user is shown the command; 'always' starts it and remembers this exact definition", async () => {
  const root = project({ tool: { command: "node", args: ["server.js"] } });
  const { ctx, started, asked } = fakeCtx("Always for this project");
  ctx.mcpPending = (await planMcpServers(root)).pending;
  await askPendingServers(ctx, root);
  assert.deepEqual(started, ["tool"]);
  assert.match(asked[0]!, /node server\.js/);
  assert.deepEqual((await planMcpServers(root)).pending, [], "approved once, not asked again");

  // Changing the command makes it a different server, asked about again.
  writeFileSync(join(root, ".mindweave", "mcp.json"), JSON.stringify({ mcpServers: { tool: { command: "node", args: ["other.js"] } } }));
  assert.equal((await planMcpServers(root)).pending.length, 1);
});

test("'no' starts nothing and remembers nothing; with nobody to ask it stays held", async () => {
  const root = project({ tool: { command: "node", args: ["server.js"] } });
  const no = fakeCtx("No");
  no.ctx.mcpPending = (await planMcpServers(root)).pending;
  await askPendingServers(no.ctx, root);
  assert.deepEqual(no.started, []);
  assert.equal((await planMcpServers(root)).pending.length, 1);

  const nobody = fakeCtx(null);
  const pending: PendingServer[] = (await planMcpServers(root)).pending;
  nobody.ctx.mcpPending = pending;
  await askPendingServers(nobody.ctx, root);
  assert.deepEqual(nobody.started, []);
  assert.equal(nobody.ctx.mcpPending?.length, 1, "held for when someone can answer");
});
