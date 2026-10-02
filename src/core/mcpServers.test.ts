/**
 * mcpServers.test.ts — the app's MCP actions write the same files the CLI does, and
 * apply to the running pool at once.
 *
 * Read back from the config files on disk after each action, because that is what the
 * next launch (and the CLI) will load. The server command does not exist, so nothing is
 * spawned for real: every server here settles as `failed`, which is also the honest
 * state for a typo'd command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "../mcp/manager.js";
import { projectConfigPath, globalConfigPath } from "../mcp/config.js";
import type { Session } from "../memory/types.js";
import {
  listMcpServers,
  mcpServerDetail,
  removeMcpServer,
  saveMcpServer,
  setMcpServerDisabled,
} from "./mcpServers.js";

const NO_SUCH = "mindweave-test-no-such-mcp-binary";

function fresh(): Session {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "mcpsrv-state-"));
  const cwd = mkdtempSync(join(tmpdir(), "mcpsrv-proj-"));
  return { cwd, toolContext: { mcp: new McpManager() } } as unknown as Session;
}
const onDisk = (path: string): Record<string, { disabled?: boolean; command?: string; url?: string }> => {
  try {
    return JSON.parse(readFileSync(path, "utf8")).mcpServers ?? {};
  } catch {
    return {};
  }
};

test("adding a server writes it to the chosen file and puts it in the live pool", async () => {
  const s = fresh();
  const r = await saveMcpServer(s, { name: "files", type: "stdio", scope: "project", command: NO_SUCH, args: "--root 'a b'" });
  assert.equal(r.ok, true);
  assert.equal(onDisk(projectConfigPath(s.cwd)).files?.command, NO_SUCH);
  assert.deepEqual(Object.keys(onDisk(globalConfigPath())), []);
  const [view] = await listMcpServers(s);
  assert.equal(view?.name, "files");
  assert.equal(view?.scope, "project");
  assert.equal(view?.target, `${NO_SUCH} --root a b`);
  const detail = await mcpServerDetail(s, "files");
  assert.deepEqual(detail?.config.args, ["--root", "a b"], "quoted args stay one argument");
});

test("a bad name, a duplicate, and an http server without a real address are refused", async () => {
  const s = fresh();
  await saveMcpServer(s, { name: "files", type: "stdio", scope: "project", command: NO_SUCH });
  assert.equal((await saveMcpServer(s, { name: "files", type: "stdio", scope: "project", command: NO_SUCH })).ok, false);
  assert.equal((await saveMcpServer(s, { name: "has space", type: "stdio", scope: "project", command: NO_SUCH })).ok, false);
  assert.equal((await saveMcpServer(s, { name: "web", type: "http", scope: "project", url: "file:///etc" })).ok, false);
});

test("turning a server off is saved in its file and shows as disabled; turning it on clears it", async () => {
  const s = fresh();
  await saveMcpServer(s, { name: "files", type: "stdio", scope: "global", command: NO_SUCH });
  await setMcpServerDisabled(s, "files", true);
  assert.equal(onDisk(globalConfigPath()).files?.disabled, true, "written to the file that already had it");
  assert.equal((await listMcpServers(s))[0]?.state, "disabled");
  await setMcpServerDisabled(s, "files", false);
  assert.equal(onDisk(globalConfigPath()).files?.disabled, undefined);
});

test("editing can rename and move scope without leaving a shadow copy, and keeps it disabled", async () => {
  const s = fresh();
  await saveMcpServer(s, { name: "files", type: "stdio", scope: "project", command: NO_SUCH });
  await setMcpServerDisabled(s, "files", true);
  const r = await saveMcpServer(s, { name: "fs", type: "stdio", scope: "global", command: NO_SUCH, originalName: "files" });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(onDisk(projectConfigPath(s.cwd))), []);
  assert.equal(onDisk(globalConfigPath()).fs?.disabled, true);
  assert.deepEqual((await listMcpServers(s)).map((v) => v.name), ["fs"]);
});

test("removing takes it out of the file and stops it", async () => {
  const s = fresh();
  await saveMcpServer(s, { name: "files", type: "stdio", scope: "project", command: NO_SUCH });
  assert.equal((await removeMcpServer(s, "files")).ok, true);
  assert.deepEqual(Object.keys(onDisk(projectConfigPath(s.cwd))), []);
  assert.deepEqual(await listMcpServers(s), []);
  assert.equal((await removeMcpServer(s, "files")).ok, false);
});
