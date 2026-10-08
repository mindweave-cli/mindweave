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
import { stateRoot } from "../memory/store.js";

test("Mindweave's state folder is protected, except the memory and MCP result folders", () => {
  const root = stateRoot();
  for (const rel of ["mcp-auth.json", "keys.json", ".env", "MINDWEAVE.md", "bin/rg.exe", "chassis/x/server.js", "projects/p/trusted", "projects/p/forbidden.md", "projects/p/abc.jsonl", "projects/p/checkpoints/s/stack.json"]) {
    assert.ok(protectedPathReason(join(root, rel)), `${rel} is not protected`);
  }
  for (const rel of ["projects/p/memory/MEMORY.md", "projects/p/memory/note.md", "projects/p/mcp-results/server/result.json"]) {
    assert.equal(protectedPathReason(join(root, rel)), null, `${rel} should stay reachable`);
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
