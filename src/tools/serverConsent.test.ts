/**
 * serverConsent.test.ts — a language server is installed only after the user says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureInstalled, installDecision, takeUndecidedInstalls } from "../alternator/chassis/provision.js";
import { askPendingInstalls } from "./serverConsent.js";
import type { ToolContext } from "./types.js";

const SPEC = { source: "npm" as const, package: "example-language-server", version: "1.0.0", binName: "example-ls" };

function ctxAnswering(answer: string | null, asked: string[]): ToolContext {
  return {
    cwd: "",
    reads: new Map(),
    todos: [],
    ...(answer === null ? {} : { requestApproval: async (_q: string, _o: string[], detail?: string) => (asked.push(detail ?? ""), answer) }),
  } as unknown as ToolContext;
}

test("the user is told where the server comes from, and 'never' is remembered", async () => {
  delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  takeUndecidedInstalls();
  await ensureInstalled("consent-never", SPEC);
  const asked: string[] = [];
  await askPendingInstalls(ctxAnswering("Never", asked));
  assert.match(asked[0]!, /example-language-server@1\.0\.0/);
  assert.match(asked[0]!, /without running its install scripts/);
  assert.equal(installDecision("consent-never"), "never");
});

test("'not now' records nothing, and with nobody to ask the request is kept", async () => {
  delete process.env.MINDWEAVE_NO_AUTO_INSTALL;
  takeUndecidedInstalls();
  await ensureInstalled("consent-later", SPEC);
  await askPendingInstalls(ctxAnswering(null, []));
  assert.deepEqual(takeUndecidedInstalls().map((p) => p.key), ["consent-later"], "still waiting");
  await ensureInstalled("consent-later", SPEC);
  await askPendingInstalls(ctxAnswering("Not now", []));
  assert.equal(installDecision("consent-later"), undefined);
});
