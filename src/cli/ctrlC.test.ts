/**
 * ctrlC.test.ts — Ctrl+C leaves, and leaves nothing running.
 *
 * Enforced by reading the source. The failure needs a REAL TTY to reproduce: raw mode is
 * what turns Ctrl+C from a signal into a byte, and a test process has no raw terminal to
 * put into that state. What went wrong was invisible for the same reason — Ink's default
 * was to unmount on that byte and stop there, so painting ceased while the process stayed
 * up with the turn still running, and neither `exit` hook ran because nothing exited.
 *
 * The two hooks are the whole point of exiting properly: altScreen's restores the terminal
 * (see terminalRestore.test.ts) and backgroundShells' synchronously kills what is still
 * running. Both are registered on `exit`, and `exit` only happens if something calls it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("Ink is told to keep its hands off Ctrl+C", async () => {
  // With this true (its default), Ink unmounts on the byte and the app never hears it.
  const source = await read("../main.ts");
  assert.match(source, /exitOnCtrlC:\s*false/, "Ink would silently unmount on Ctrl+C again");
});

test("the app handles Ctrl+C, and exits rather than unmounting", async () => {
  const source = await read("./App.tsx");
  assert.match(source, /key\.ctrl\s*\|\|\s*input\s*!==\s*"c"/, "no Ctrl+C handler in the app");
  const handler = source.slice(source.indexOf('input !== "c"'));
  const body = handler.slice(0, handler.indexOf("},"));
  assert.match(body, /process\.exit\(130\)/, "Ctrl+C must exit, which is what runs the exit hooks");
  assert.match(body, /abort\(\)/, "an in-flight turn must be aborted on the way out");
});

test("background shells are killed synchronously on exit", async () => {
  // The hook that stops a task outliving the app. Synchronous because an async kill never
  // reaches the OS from an exit handler — see killTree.ts's header.
  const source = await read("../tools/backgroundShells.ts");
  assert.match(source, /process\.once\("exit"/, "nothing kills background shells on exit");
  const hook = source.slice(source.indexOf('process.once("exit"'));
  assert.match(hook.slice(0, 300), /dispose\(true\)/, "the exit kill must be the synchronous one");
});

test("every manager registers itself, or the exit hook has nothing to kill", async () => {
  const source = await read("../tools/backgroundShells.ts");
  const ctor = source.slice(source.indexOf("constructor("));
  assert.match(ctor.slice(0, 400), /active\.add\(this\)/);
  assert.match(ctor.slice(0, 400), /registerCleanup\(\)/);
});
