/**
 * ripgrepShell.test.ts — `rg` works in a command, searches the folder, and leaves secrets out.
 *
 * A command's stdin was a closed pipe, so `rg pattern` with no path searched that empty
 * pipe and found nothing; the bundled rg was not on the command's PATH; and an rg the
 * user had installed searched .env files the search tool leaves out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./registry.js";
import { ripgrepAvailable, ripgrepPath } from "./ripgrep.js";
import type { ToolContext } from "./types.js";

test("rg with no path searches the folder, and does not print .env", async (t) => {
  if (!(await ripgrepAvailable()) || !/[\\/]/.test(ripgrepPath())) return t.skip("no bundled ripgrep here");
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-rgshell-")));
  writeFileSync(join(cwd, "app.js"), "const needle = 1;\n");
  writeFileSync(join(cwd, ".env"), "NEEDLE_KEY=hunter2-FAKE-rg\n");
  const run = TOOLS.find((x) => x.name === "run_command")!;
  const ctx = { cwd, roots: [cwd], reads: new Map(), todos: [] } as unknown as ToolContext;
  const r = await run.execute({ command: "rg -i --hidden needle" }, ctx);
  const output = String(r.output);
  assert.match(output, /app\.js/, `rg found nothing: ${output.slice(0, 300)}`);
  assert.ok(!output.includes("hunter2-FAKE-rg"), "rg printed a secret");
});
