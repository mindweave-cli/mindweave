/**
 * contextRecent.test.ts — reopening a saved session reuses the project's context for a few seconds.
 *
 * Switching between the sessions of one project collected the same snapshot again each time (several git processes, about a
 * tenth of a second). It is reused for a short while on a reopen; a new session, and a reopen after the window, collect afresh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectContextText, projectContextTextRecent, RECENT_CONTEXT_MS } from "./context.js";

function folder(readme: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-ctx-"));
  writeFileSync(join(dir, "README.md"), readme);
  return dir;
}

test("a reopen within the window reuses the collected context, even if the project changed meanwhile", async () => {
  const dir = folder("# First version of the readme\n\nSome words.\n");
  const first = await projectContextTextRecent(dir, 1_000);
  assert.match(first, /First version of the readme/);
  writeFileSync(join(dir, "README.md"), "# Second version of the readme\n\nOther words.\n");
  const again = await projectContextTextRecent(dir, 1_000 + RECENT_CONTEXT_MS - 1);
  assert.equal(again, first, "same text inside the window");
});

test("after the window, and for a new session, the context is collected afresh", async () => {
  const dir = folder("# Old words\n");
  await projectContextTextRecent(dir, 5_000);
  writeFileSync(join(dir, "README.md"), "# New words\n");
  const later = await projectContextTextRecent(dir, 5_000 + RECENT_CONTEXT_MS);
  assert.match(later, /New words/, "the window has passed");
  writeFileSync(join(dir, "README.md"), "# Newest words\n");
  assert.match(await projectContextText(dir), /Newest words/, "a new session never reads the remembered copy");
});

test("different projects do not share a remembered context", async () => {
  const a = folder("# Project A readme\n");
  const b = folder("# Project B readme\n");
  assert.match(await projectContextTextRecent(a, 9_000), /Project A readme/);
  assert.match(await projectContextTextRecent(b, 9_000), /Project B readme/);
});
