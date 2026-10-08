/**
 * runCommandEncoding.test.ts — text outside ASCII survives run_command on Windows.
 *
 * Windows PowerShell 5.1 writes its output in the console code page and reads a file
 * without a byte-order mark as ANSI, so a file named "résumé-数据.txt" came back as
 * "r?sum?-??.txt" and its contents as mojibake. See UTF8_PRELUDE in runCommand.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./registry.js";
import type { ToolContext } from "./types.js";

const TEXT = "héllo — 你好 ✓ مرحبا";
const NAME = "résumé-数据-ملف.txt";
const windowsOnly = { skip: process.platform !== "win32" };

async function run(command: string, cwd: string): Promise<string> {
  const tool = TOOLS.find((t) => t.name === "run_command")!;
  const ctx = { cwd, roots: [cwd], reads: new Map(), todos: [] } as unknown as ToolContext;
  const result = await tool.execute({ command }, ctx);
  return String((result as { output?: string }).output ?? "");
}

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "mw-enc-"));
  writeFileSync(join(dir, NAME), TEXT + "\n");
  return dir;
}

test("printed text, a file name and file contents come back intact", windowsOnly, async () => {
  const dir = folder();
  assert.match(await run(`Write-Output "${TEXT}"`, dir), new RegExp(TEXT));
  assert.match(await run("Get-ChildItem -Name", dir), new RegExp(NAME.replace(/\./g, "\\.")));
  assert.match(await run("Get-Content -Raw *.txt", dir), new RegExp(TEXT));
});

test("a program piped through the shell still keeps its text (unchanged by the prelude)", windowsOnly, async () => {
  const out = await run(`node -e "console.log('${TEXT}')" | Select-Object -First 1`, folder());
  assert.match(out, new RegExp(TEXT));
});

test("a redirect writes UTF-8, not UTF-16", windowsOnly, async () => {
  const dir = folder();
  await run(`'${TEXT}' > out.txt`, dir);
  const bytes = readFileSync(join(dir, "out.txt"));
  assert.notDeepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "UTF-16 byte-order mark");
  assert.match(bytes.toString("utf8"), new RegExp(TEXT));
});

test("the prelude does not move the line numbers errors report", windowsOnly, async () => {
  // The wrapper has always put exactly one line before the command, so line 2 of the
  // command is reported as line 3. The prelude shares that line; a second line would make it 4.
  const out = await run("Write-Output ok\nGet-Item does-not-exist-here", folder());
  assert.match(out, /line:3 /i, out);
});
