/**
 * stateGuard.test.ts — the file tools cannot reach Mindweave's own state folder.
 *
 * It holds MCP sign-in tokens, key labels, the permission and rule files, past sessions,
 * the undo history and installed programs. The agent is pointed at two places there by
 * design (its memory folder and saved MCP results), and only those stay reachable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { protectedPathReason } from "./guard.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { projectDir, registerOpenProject, stateRoot } from "../memory/store.js";

test("Mindweave's state folder is protected, except the memory and MCP result folders", () => {
  const root = stateRoot();
  for (const rel of ["mcp-auth.json", "keys.json", ".env", "MINDWEAVE.md", "bin/rg.exe", "chassis/x/server.js", "projects/p/trusted", "projects/p/forbidden.md", "projects/p/abc.jsonl", "projects/p/checkpoints/s/stack.json"]) {
    assert.ok(protectedPathReason(join(root, rel)), `${rel} is not protected`);
  }
  // The folders of the project this session opened stay reachable; no other project's do.
  const open = join(tmpdir(), "mw-open-project-" + process.pid);
  registerOpenProject(open);
  const mine = projectDir(open).slice(root.length + 1).replace(/\\/g, "/");
  for (const rel of [`${mine}/memory/MEMORY.md`, `${mine}/memory/note.md`, `${mine}/mcp-results/server/result.json`, `${mine}/cleared/x.txt`]) {
    assert.equal(protectedPathReason(join(root, rel)), null, `${rel} should stay reachable`);
  }
  for (const rel of ["projects/p/memory/MEMORY.md", "projects/p/cleared/x.txt", "projects/p/mcp-results/server/result.json"]) {
    assert.ok(protectedPathReason(join(root, rel)), `${rel} belongs to another project`);
  }
  assert.equal(protectedPathReason(join(root + "-elsewhere", "keys.json")), null, "a sibling folder is not the state folder");
});

test("on macOS and Windows a different spelling of the state folder's case is the same folder", async () => {
  const { foldsCase } = await import("./guard.js");
  assert.equal(foldsCase("darwin"), true);
  assert.equal(foldsCase("win32"), true);
  assert.equal(foldsCase("linux"), false);
  const loud = join(stateRoot().toUpperCase(), "mcp-auth.json");
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    assert.ok(protectedPathReason(loud), "a shouted spelling of the state folder was readable on a case-insensitive volume");
    Object.defineProperty(process, "platform", { value: "linux" });
    // A case-sensitive volume really does treat that as some other folder (Windows folds regardless).
    if (real.value !== "win32") assert.equal(protectedPathReason(loud), null);
  } finally {
    Object.defineProperty(process, "platform", real);
  }
});

test("two projects whose paths flatten to the same name do not share a state folder", () => {
  const base = mkdtempSync(join(tmpdir(), "mw-collide-"));
  const a = join(base, "b-c");
  const b = join(base, "b", "c");
  const trustedFolder = projectDir(a);
  const other = projectDir(b);
  assert.notEqual(other, trustedFolder, "C:\\x\\b-c and C:\\x\\b\\c are different projects");
  assert.equal(projectDir(a), trustedFolder, "the first keeps its folder");
  assert.equal(projectDir(b), other, "and the second keeps its own");
});