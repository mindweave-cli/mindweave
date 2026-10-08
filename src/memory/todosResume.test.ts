/**
 * todosResume.test.ts — a continued session still has its task list.
 *
 * The list lived only in memory: `/continue` started with none, and once the tool result
 * that carried it had been cleared there was nothing left to rewrite it from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, resumeSession } from "./session.js";
import { saveSession } from "./store.js";
import { stopChassis } from "../alternator/lane.js";

test("the task list survives saving and resuming; a finished list does not come back", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-todos-")));
  const s = await createSession(root);
  s.transcript.push({ role: "user", content: "build it" }, { role: "assistant", content: "on it" });
  s.toolContext.todos = [
    { content: "Write the parser", activeForm: "Writing the parser", status: "completed" },
    { content: "Run the tests", activeForm: "Running the tests", status: "in_progress" },
    { content: "Update the docs", activeForm: "Updating the docs", status: "pending" },
  ];
  await saveSession(s);
  const again = await resumeSession(root, s.id);
  try {
    assert.ok(again);
    assert.deepEqual(again.toolContext.todos.map((t) => `${t.status}:${t.content}`), [
      "completed:Write the parser",
      "in_progress:Run the tests",
      "pending:Update the docs",
    ]);
    again.toolContext.todos = [];
    await saveSession(again);
    const third = await resumeSession(root, s.id);
    assert.deepEqual(third?.toolContext.todos, [], "an empty list stays empty");
    await stopChassis(third?.toolContext.chassis).catch(() => {});
  } finally {
    await stopChassis(s.toolContext.chassis).catch(() => {});
    await stopChassis(again?.toolContext.chassis).catch(() => {});
  }
});
