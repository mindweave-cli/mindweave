/**
 * toolFuzz.test.ts — every registered tool, called with arguments a model can get wrong.
 *
 * A model sends the wrong type, drops a required field, or sends nothing at all, all the
 * time, and what must happen is always the same: the tool answers with an error result the
 * model can act on. It must not throw (the engine guards that, but a guard is the last
 * defence, not the plan), must not hang, and must not answer with nothing, because an empty
 * result reads to the model as "it worked and there was nothing to say".
 *
 * Runs against the real registry, so a tool added later is covered without anyone
 * remembering to add it here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./registry.js";
import { createSession } from "../memory/session.js";
import { stopChassis } from "../alternator/lane.js";
import type { Session } from "../memory/types.js";

// Nested one level down: `workspace` with no arguments looks through the project's parent
// for sibling projects, and the parent of a bare temp folder is the whole temp directory,
// which on a used machine holds thousands of entries and ran past the timeout under load.
const root = join(realpathSync.native(mkdtempSync(join(tmpdir(), "mw-fuzz-"))), "project");
mkdirSync(root);
let session: Session | undefined;
after(async () => {
  if (session) await stopChassis(session.toolContext.chassis).catch(() => {});
});

/** Tools that start a program or reach outside the machine even with plausible arguments; wrong
 *  arguments must still be refused before that point, which is exactly what is checked. */
const BAD_ARGS: [string, unknown][] = [
  ["no arguments", {}],
  ["a number where text belongs", { path: 42, command: 42, query: 42, url: 42, name: 42, action: 42, pattern: 42, content: 42, id: "x", task: 42 }],
  ["null values", { path: null, command: null, query: null, url: null, name: null, action: null, pattern: null, content: null, task: null }],
  ["arrays and objects where scalars belong", { path: ["a"], command: { x: 1 }, query: [], url: {}, name: [], action: {}, pattern: [], content: [], task: {} }],
  ["an unknown action and a missing target", { action: "definitely-not-an-action", target: -1, name: "\u0000" }],
];

const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`HUNG: ${label} took over ${ms}ms`)), ms).unref())]);

for (const tool of TOOLS) {
  test(`${tool.name}: wrong or missing arguments give an error result, never a throw, a hang or silence`, async () => {
    session ??= await createSession(root);
    const ctx = { ...session.toolContext, cwd: root, abortSignal: undefined };
    for (const [label, args] of BAD_ARGS) {
      let result;
      try {
        result = await withTimeout(Promise.resolve(tool.execute(args as Record<string, unknown>, ctx, { progress: () => {} })), 15_000, `${tool.name} with ${label}`);
      } catch (error) {
        assert.fail(`${tool.name} with ${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      assert.equal(typeof result.output, "string", `${tool.name} with ${label}: no text result`);
      assert.ok(result.output.trim().length > 0, `${tool.name} with ${label}: an EMPTY result reads as "worked, nothing to say"`);
    }
  });
}
