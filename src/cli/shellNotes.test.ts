/**
 * shellNotes.test.ts — a line in the conversation is for something the person has to be told.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shellNote } from "./shellNotes.js";
import type { ShellInfo } from "../tools/backgroundShells.js";

const clip = (c: string) => c;
const shell = (over: Partial<ShellInfo>): ShellInfo => ({ id: 1, command: "npm run dev", status: "running", ...over }) as ShellInfo;

test("a command stopped on purpose says nothing, whoever stopped it", () => {
  assert.equal(shellNote(shell({ status: "killed", stoppedBy: "agent" }), "ended", clip), undefined);
  assert.equal(shellNote(shell({ status: "killed", stoppedBy: "user" }), "ended", clip), undefined);
});

test("coming up, and ending cleanly, say nothing: the agent's own row and reply already do", () => {
  assert.equal(shellNote(shell({}), "ready", clip), undefined);
  assert.equal(shellNote(shell({}), "opened", clip), undefined);
  assert.equal(shellNote(shell({ status: "exited", exitCode: 0 } as Partial<ShellInfo>), "ended", clip), undefined);
});

test("a command that died on its own is told, as an error", () => {
  const n = shellNote(shell({ status: "exited", exitCode: 1 } as Partial<ShellInfo>), "ended", clip);
  assert.ok(n && n.error);
  assert.match(n!.text, /shell #1 \(npm run dev\) finished with exit 1/);
});

test("a command gone quiet, or waiting on a prompt, is told", () => {
  const quiet = shellNote(shell({ stallReason: "silent" } as Partial<ShellInfo>), "stalled", clip);
  assert.ok(quiet && quiet.error && /stuck/.test(quiet.text));
  const prompt = shellNote(shell({ stallReason: "prompt" } as Partial<ShellInfo>), "stalled", clip);
  assert.ok(prompt && /waiting for input/.test(prompt.text));
});
