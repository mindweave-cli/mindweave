/**
 * childEnv.test.ts — programs Mindweave starts never see the keys Mindweave loaded.
 *
 * The snapshot is taken when childEnv.ts is first loaded, so every variable this file
 * sets afterwards stands for one Mindweave added from its settings files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedByMindweave, childEnv } from "./childEnv.js";
import { TOOLS } from "./registry.js";
import type { ToolContext } from "./types.js";

const FAKE = "sk-FAKE-test-only-0123456789";

test("a key loaded after startup is not passed to a child", () => {
  process.env["DEEPSEEK_API_KEY"] = FAKE;
  process.env["DEEPSEEK_API_KEY_1"] = FAKE;
  process.env["SOME_PROJECT_SETTING"] = "from a .env file";
  try {
    assert.equal(addedByMindweave("DEEPSEEK_API_KEY"), true);
    const env = childEnv();
    assert.equal(env["DEEPSEEK_API_KEY"], undefined);
    assert.equal(env["DEEPSEEK_API_KEY_1"], undefined);
    assert.equal(env["SOME_PROJECT_SETTING"], undefined);
  } finally {
    delete process.env["DEEPSEEK_API_KEY"];
    delete process.env["DEEPSEEK_API_KEY_1"];
    delete process.env["SOME_PROJECT_SETTING"];
  }
});

test("the shell's own variables pass through, and extra wins", () => {
  const env = childEnv({ NO_COLOR: "1" });
  assert.ok(env["PATH"] ?? env["Path"], "PATH is kept");
  assert.equal(env["NO_COLOR"], "1");
});

test("run_command cannot print a key Mindweave loaded", async () => {
  process.env["GEMINI_API_KEY"] = FAKE;
  try {
    const tool = TOOLS.find((t) => t.name === "run_command")!;
    const cwd = mkdtempSync(join(tmpdir(), "mw-childenv-"));
    const ctx = { cwd, roots: [cwd], reads: new Map(), todos: [] } as unknown as ToolContext;
    const command = process.platform === "win32" ? "Get-ChildItem Env: | Out-String -Width 400" : "env";
    const result = await tool.execute({ command }, ctx);
    const output = String((result as { output?: string }).output ?? "");
    assert.match(output, /PATH/i, "the command really listed the environment");
    assert.ok(!output.includes(FAKE), "the key reached the command");
    assert.ok(!/GEMINI_API_KEY/.test(output), "the key's name reached the command");
  } finally {
    delete process.env["GEMINI_API_KEY"];
  }
});
