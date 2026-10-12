/**
 * commandOutput.test.ts — the file a command writes into.
 *
 * The reason this exists at all is that a pipe has a fixed kernel buffer and stops the
 * child dead once nothing is draining it. The tests that matter here are the ones about
 * READING a file back safely: every read is a byte range at an arbitrary offset, and a
 * range boundary lands mid-character as soon as a command prints anything but ASCII.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import {
  OutputReader,
  composeFileOutput,
  createOutputFile,
  removeOutputFile,
  sizeOf,
  tailOf,
} from "./commandOutput.js";

/** A file holding exactly `text`, written the way a child would. */
async function fileWith(text: string): Promise<string> {
  const { path, handle } = await createOutputFile();
  await handle.write(text);
  await handle.close();
  return path;
}

test("a fresh file is empty and has a path of its own", async () => {
  const a = await createOutputFile();
  const b = await createOutputFile();
  await a.handle.close();
  await b.handle.close();
  assert.notEqual(a.path, b.path, "two commands would write into each other's output");
  assert.equal(await sizeOf(a.path), 0);
  removeOutputFile(a.path);
  removeOutputFile(b.path);
});

test("the size of a file that does not exist is zero, not an error", async () => {
  // Asked before the child has written anything, and asked again after cleanup. Neither
  // may throw: the size is polled on a timer that outlives both.
  assert.equal(await sizeOf("/definitely/not/here.log"), 0);
});

test("the tail is the END of the output", async () => {
  // A build's diagnosis is at the end. The head is what a test that only checked "some
  // text came back" would accept.
  const path = await fileWith(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
  const tail = await tailOf(path, 64);
  assert.match(tail, /line 199$/);
  assert.doesNotMatch(tail, /line 0\b/);
  removeOutputFile(path);
});

test("a tail shorter than the budget returns the whole file", async () => {
  const path = await fileWith("short");
  assert.equal(await tailOf(path, 4096), "short");
  removeOutputFile(path);
});

test("a tail that starts mid-character does not begin with a broken one", async () => {
  // The one that would be visible on every progress update forever. A byte offset lands
  // inside a multi-byte character constantly; decoding from there yields U+FFFD.
  const path = await fileWith("é".repeat(100));
  for (let bytes = 1; bytes <= 12; bytes++) {
    const tail = await tailOf(path, bytes);
    assert.ok(!tail.startsWith("\uFFFD"), `a ${bytes}-byte tail began with a replacement character`);
  }
  removeOutputFile(path);
});

test("output within budget is returned whole, with nothing claimed dropped", async () => {
  const path = await fileWith("all of it");
  const out = await composeFileOutput(path, 100, 100);
  assert.equal(out.text, "all of it");
  assert.equal(out.dropped, 0);
  removeOutputFile(path);
});

test("output over budget keeps BOTH ends and names the gap", async () => {
  // Keeping only the head throws away the half that says what happened; keeping only the
  // tail throws away what was being attempted.
  const path = await fileWith("HEAD" + "x".repeat(5000) + "TAIL");
  const out = await composeFileOutput(path, 50, 50);
  assert.match(out.text, /^HEAD/, "the beginning was dropped");
  assert.match(out.text, /TAIL$/, "the end was dropped");
  assert.match(out.text, /bytes omitted from the middle/, "the gap is not named, so the model reads it as continuous");
  assert.ok(out.dropped > 4000);
  removeOutputFile(path);
});

test("a missing file composes to nothing rather than throwing", async () => {
  const out = await composeFileOutput("/definitely/not/here.log", 100, 100);
  assert.equal(out.text, "");
  assert.equal(out.dropped, 0);
});

test("a reader returns only what is NEW since it last read", async () => {
  const { path, handle } = await createOutputFile();
  const reader = new OutputReader(path);
  await handle.write("first\n");
  assert.equal(await reader.next(4096), "first\n");
  // Nothing written in between: a reader that returned the file again would repeat every
  // line to the model on each poll.
  assert.equal(await reader.next(4096), "");
  await handle.write("second\n");
  assert.equal(await reader.next(4096), "second\n");
  await handle.close();
  removeOutputFile(path);
});

test("a character split across two reads survives the boundary", async () => {
  // The decoder has to be kept BETWEEN reads. Recreated per read, the leading bytes of a
  // character are decoded as a replacement and its tail as another — every chunk boundary
  // corrupting a character, and chunk boundaries are wherever the poll happened to land.
  const { path, handle } = await createOutputFile();
  const reader = new OutputReader(path);
  const bytes = Buffer.from("héllo", "utf8");
  await handle.write(bytes.subarray(0, 2)); // 'h' and the first byte of 'é'
  const first = await reader.next(4096);
  await handle.write(bytes.subarray(2));
  const second = await reader.next(4096);
  await handle.close();
  assert.equal(first + second, "héllo");
  removeOutputFile(path);
});

test("a reader is bounded by what it is asked for", async () => {
  const path = await fileWith("0123456789");
  const reader = new OutputReader(path);
  assert.equal(await reader.next(4), "0123");
  assert.equal(await reader.next(4), "4567");
  assert.equal(await reader.next(4), "89");
  removeOutputFile(path);
});

test("a truncated file rewinds the reader instead of reading past the end", async () => {
  // Nothing truncates one of these today, but a reader whose offset is past EOF returns
  // garbage forever rather than failing, which is the worst way for it to be wrong.
  const path = await fileWith("0123456789");
  const reader = new OutputReader(path);
  await reader.next(4096);
  await fs.writeFile(path, "ab");
  assert.equal(await reader.next(4096), "");
  assert.equal(reader.offset, 2, "the reader stayed past the end of a shorter file");
  removeOutputFile(path);
});

test("seekToEnd skips what is already there", async () => {
  const path = await fileWith("old output\n");
  const reader = new OutputReader(path);
  await reader.seekToEnd();
  assert.equal(await reader.next(4096), "");
  removeOutputFile(path);
});

// ── the properties a pipe could not give ─────────────────────────────────────

test("a command that prints far more than a pipe buffer still finishes", async () => {
  // The one that made this worth doing. A pipe's kernel buffer is tens of kilobytes and
  // only drains while something reads it; past that the child BLOCKS on its next write —
  // stopped, indefinitely, looking exactly like a hang. Here nothing reads at all until
  // the command is over, and it still completes.
  const { runCommand } = await import("./runCommand.js");
  const ctx = { cwd: process.cwd(), reads: new Map(), todos: [] } as unknown as import("./types.js").ToolContext;
  const command =
    process.platform === "win32"
      ? "1..20000 | ForEach-Object { 'x' * 200 }"
      // One awk process writing 20,000 lines of 200 characters. This used to fork `seq` once per line, which is 20,000
      // processes: fine on Linux, over a minute under macOS's older bash, and it looked exactly like the stall under test.
      : `awk 'BEGIN { s = sprintf("%200s", ""); gsub(/ /, "x", s); for (i = 0; i < 20000; i++) print s }'`;
  const r = await runCommand.execute({ command, timeout: 60_000 }, ctx);
  assert.doesNotMatch(r.output, /timed out/i, "a few megabytes of output stalled the command");
  assert.match(r.output, /omitted from the middle/, "4MB of output was not truncated, so it was never that large");
});

test("the output file is cleaned up once the command has been read", async () => {
  // These live in the temp directory and a session can run hundreds of commands. The
  // startup sweep is the backstop for a crash, not the plan.
  //
  // The removal is fire-and-forget (removeOutputFile does an un-awaited fs.rm), so the
  // file can still be on disk the instant execute() returns — hence the poll. The harder
  // problem was the temp directory being SHARED: this suite runs under
  // --test-concurrency, and a sibling test's own mindweave-out- files, created while this
  // one looks, are indistinguishable from a leak and read as one. So this test gets its
  // OWN temp directory. os.tmpdir() reads these env vars, and a test file runs in its own
  // process, so overriding them here isolates this test and affects nothing else.
  const { runCommand } = await import("./runCommand.js");
  const { promises: nodeFs } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const isolated = await nodeFs.mkdtemp(join(tmpdir(), "mw-cleanup-"));
  const prev = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TMPDIR = process.env.TEMP = process.env.TMP = isolated;
  try {
    const listOut = async () => (await nodeFs.readdir(isolated)).filter((f) => f.startsWith("mindweave-out-"));
    const ctx = { cwd: process.cwd(), reads: new Map(), todos: [] } as unknown as import("./types.js").ToolContext;
    await runCommand.execute({ command: process.platform === "win32" ? "Write-Output hi" : "echo hi" }, ctx);
    let leaked: string[] = [];
    for (let i = 0; i < 100; i++) {
      leaked = await listOut();
      if (leaked.length === 0) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(leaked.length, 0, `output file was not cleaned up: ${leaked.join(", ")}`);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("stdout and stderr land in ONE file, interleaved as written", async () => {
  // They share a descriptor on purpose. Collected separately and concatenated, a test
  // runner's progress and its errors arrive as two blocks in the wrong order, and the
  // line that explains a failure is nowhere near the failure.
  const { runCommand } = await import("./runCommand.js");
  const ctx = { cwd: process.cwd(), reads: new Map(), todos: [] } as unknown as import("./types.js").ToolContext;
  const command =
    process.platform === "win32"
      ? "Write-Output first; [Console]::Error.WriteLine('second'); Write-Output third"
      : "echo first; echo second 1>&2; echo third";
  const r = await runCommand.execute({ command }, ctx);
  const at = (s: string) => r.output.indexOf(s);
  assert.ok(at("first") >= 0 && at("second") >= 0 && at("third") >= 0, `missing a stream: ${r.output}`);
  assert.ok(at("first") < at("second"), "stderr was collected apart from stdout and reordered");
  assert.ok(at("second") < at("third"), "stderr was collected apart from stdout and reordered");
});
