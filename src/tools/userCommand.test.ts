/**
 * userCommand.test.ts — a command the person typed after `!`, run in a real shell.
 *
 * Real processes, a real session: that it runs and records, that it can be stopped, that it can be
 * moved to the background without the agent being woken for it, and that the conversation holds it
 * only once it has ended.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../memory/session.js";
import { isUserShell, runUserCommand } from "./userCommand.js";

async function session() {
  // These tests make sessions, and a session files things under the state folder. The suite runs with
  // its own (scripts/testState.mjs); run alone, this keeps them out of the real home all the same.
  process.env.MINDWEAVE_STATE_DIR ||= mkdtempSync(join(tmpdir(), "mw-usercmd-state-"));
  return createSession(mkdtempSync(join(tmpdir(), "mw-usercmd-test-")));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A pause the shell itself takes: PowerShell on Windows, sh elsewhere (CI runs on all three). */
const nap = (ms: number) => (process.platform === "win32" ? `Start-Sleep -Milliseconds ${ms}` : `sleep ${ms / 1000}`);

test("it runs in the shell and the output is in the conversation, marked as the user's", async () => {
  const s = await session();
  const { result, entry } = await runUserCommand(s, "echo hello-there");
  assert.ok(!result.isError);
  assert.match(result.output, /hello-there/);
  assert.equal(s.transcript.length, 1);
  assert.equal(s.transcript[0], entry);
  assert.equal(entry.role, "user");
  assert.equal(entry.synthetic, true);
  assert.match(entry.content, /The user ran the command below themselves/);
  assert.match(entry.content, /\$ echo hello-there/);
  assert.match(entry.content, /hello-there/);
  assert.equal(entry.localCommand?.ok, true);
  assert.match(entry.localCommand?.detail ?? "", /^\$ echo hello-there/);
  assert.match(entry.localCommand?.detail ?? "", /✓ 0/);
});

test("no assistant entry, no tool entry: nothing but the one record", async () => {
  const s = await session();
  await runUserCommand(s, "echo one");
  await runUserCommand(s, "echo two");
  assert.deepEqual(s.transcript.map((e) => e.role), ["user", "user"]);
});

test("a command that fails is recorded as failed, with its exit code and what it printed", async () => {
  const s = await session();
  const { result, entry } = await runUserCommand(s, "echo oops; exit 3");
  assert.equal(result.isError, true);
  assert.equal(entry.localCommand?.ok, false);
  assert.match(entry.content, /exit 3/);
  assert.match(entry.content, /oops/);
  assert.match(entry.localCommand?.detail ?? "", /✗ 3/);
});

test("the conversation holds a command only once it has ended", async () => {
  const s = await session();
  const running = runUserCommand(s, `${nap(1500)}; echo late`);
  await sleep(500);
  assert.equal(s.transcript.length, 0, "a half-finished command is not in the conversation");
  await running;
  assert.equal(s.transcript.length, 1);
});

test("it can be stopped, quickly, and what it had printed is kept", async () => {
  const s = await session();
  const stop = new AbortController();
  const started = Date.now();
  const running = runUserCommand(s, `echo before-stop; ${nap(30000)}`, { signal: stop.signal });
  await sleep(1200);
  stop.abort();
  const { result, entry } = await running;
  assert.ok(Date.now() - started < 10_000, "stopped, not run to the end");
  assert.equal(result.isError, true);
  assert.equal(entry.localCommand?.ok, false);
  assert.match(entry.content, /The user ran the command below themselves/);
});

test("progress reaches the caller while it runs", async () => {
  const s = await session();
  const seen: string[] = [];
  const ticks =
    process.platform === "win32"
      ? '1..4 | ForEach-Object { Write-Output "tick $_"; Start-Sleep -Milliseconds 900 }'
      : "for i in 1 2 3 4; do echo tick $i; sleep 0.9; done";
  await runUserCommand(s, ticks, { onProgress: (t) => seen.push(t) });
  assert.ok(seen.some((t) => /tick/.test(t)), `no progress seen: ${JSON.stringify(seen)}`);
});

test("moved to the background, the agent is told it will be woken when it finishes", async () => {
  const s = await session();
  const running = runUserCommand(s, `${nap(4000)}; echo done-later`);
  await sleep(700);
  const moved = s.toolContext.foregroundCommands!.promoteAll("user");
  assert.equal(moved, 1, "the one running command moved");
  const { result, entry } = await running;
  try {
    assert.match(result.summary ?? "", /^Backgrounded as shell #\d+/);
    assert.match(entry.content, /The user ran the command below themselves/);
    assert.match(entry.content, /running in the background as shell #\d+, started by the user/);
    assert.match(entry.content, /You will be told when it finishes/);
    assert.doesNotMatch(entry.content, /notified AUTOMATICALLY/, "the agent is not promised a report on the person's command");
    const shells = s.toolContext.backgroundShells!;
    const still = shells.running();
    assert.equal(still.length, 1, "it is running as a shell the person can see and stop");
    // Never: it does not wake the agent when it ends, and is not watched for a port or a stall.
    const listed = still[0] as unknown as { notify?: string };
    if (listed.notify !== undefined) assert.equal(listed.notify, "on_finish");
  } finally {
    for (const sh of s.toolContext.backgroundShells?.running() ?? []) s.toolContext.backgroundShells?.kill(sh.id, "user");
  }
});

test("the person's command is not stopped by the agent's rules about commands", async () => {
  const s = await session();
  s.governance.forbidden.commands = ["echo blocked-word"];
  const { result } = await runUserCommand(s, "echo blocked-word");
  assert.ok(!result.isError, "their own command runs whatever the agent is forbidden to run");
  assert.match(result.output, /blocked-word/);
});

test("nor by the agent's forbidden paths, and nothing asks the person for leave to lift them", async () => {
  const s = await session();
  s.governance.forbidden.patterns = ["secret-area"];
  let asked = 0;
  s.toolContext.requestApproval = async () => {
    asked++;
    return "No";
  };
  const { result } = await runUserCommand(s, "echo touching secret-area");
  assert.ok(!result.isError, result.output);
  assert.match(result.output, /secret-area/);
  assert.equal(asked, 0, "no question was put to the person about their own command");
});

test("when a command of the person's finishes in the background it wakes the agent, as one of the agent's does", async () => {
  const s = await session();
  const shells = s.toolContext.backgroundShells!;
  // The person's: moved to the background, then it finishes.
  const mine = runUserCommand(s, `${nap(1800)}; echo mine-done`);
  await sleep(700);
  s.toolContext.foregroundCommands!.promoteAll("user");
  await mine;
  const deadline = Date.now() + 15_000;
  while (shells.running().length > 0 && Date.now() < deadline) await sleep(100);
  assert.equal(shells.running().length, 0, "it finished");
  await sleep(300);
  const events = await shells.drainEvents();
  assert.ok(events.some((e) => e.kind === "ended" && e.wake === true), "its ending wakes the agent: " + JSON.stringify(events.map((e) => ({ kind: e.kind, wake: e.wake }))));
});

test("an app or a dev server starts in the background, and the agent is told it is running", async () => {
  const s = await session();
  const was = process.env.MINDWEAVE_READY_WINDOW_MS;
  process.env.MINDWEAVE_READY_WINDOW_MS = "300";
  const started = Date.now();
  // "serve" is a word the shell tool takes for a server; the command itself is harmless and ends on its own.
  const { result, entry } = await runUserCommand(s, `echo serve; ${nap(20000)}`);
  try {
    assert.ok(Date.now() - started < 12_000, `the prompt came back long before the 20 s the command takes (${Date.now() - started} ms)`);
    assert.match(result.summary ?? "", /^Running as shell #\d+/);
    assert.equal(s.transcript.length, 1, "and the conversation already holds it");
    assert.match(entry.content, /The user ran the command below themselves/);
    assert.match(entry.content, /running in the background as shell #\d+, started by the user/);
    assert.match(entry.content, /You will be told when it finishes/);
    assert.doesNotMatch(entry.content, /Then STOP/, "the shell tool's words to the agent about ITS command are not passed on");
    assert.equal(entry.localCommand?.ok, true);
    const shells = s.toolContext.backgroundShells!;
    assert.equal(shells.running().length, 1, "it is a shell the person can see and stop");
    assert.ok(isUserShell(shells, shells.running()[0]!.id), "and one that Esc leaves alone, because the person started it");
  } finally {
    for (const sh of s.toolContext.backgroundShells?.running() ?? []) s.toolContext.backgroundShells?.kill(sh.id, "user");
    if (was === undefined) delete process.env.MINDWEAVE_READY_WINDOW_MS;
    else process.env.MINDWEAVE_READY_WINDOW_MS = was;
  }
});

test("an app that dies at start is recorded as failed, and the agent is not told to start it again", async () => {
  const s = await session();
  const was = process.env.MINDWEAVE_READY_WINDOW_MS;
  process.env.MINDWEAVE_READY_WINDOW_MS = "5000";
  try {
    const { result, entry } = await runUserCommand(s, "echo serve; exit 2");
    assert.equal(result.isError, true);
    assert.equal(entry.localCommand?.ok, false);
    assert.match(entry.content, /never came up/);
    assert.doesNotMatch(entry.content, /Fix the cause and start it again/, "that order is for the agent's own command");
  } finally {
    if (was === undefined) delete process.env.MINDWEAVE_READY_WINDOW_MS;
    else process.env.MINDWEAVE_READY_WINDOW_MS = was;
  }
});

test("an ordinary command is not started in the background: its output is waited for", async () => {
  const s = await session();
  const { result } = await runUserCommand(s, `${nap(700)}; echo plain-result`);
  assert.match(result.output, /plain-result/);
  assert.doesNotMatch(result.summary ?? "", /^Backgrounded/);
});
