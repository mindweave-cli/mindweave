/**
 * docsCurrent.test.ts — the two files that tell a new user which providers exist.
 *
 * Both had gone three weeks and six providers stale: `.env.example` listed ONE key of
 * thirteen, and PROVIDERS.md still said "more providers are on the way" under a table
 * with two rows. Nothing was wrong with either file when it was written; they simply
 * had no reason to change when a provider was added.
 *
 * So the registry is the source of truth and these assert against it. A new driver now
 * fails this until it appears where a user would look for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allProviders } from "./registry.js";
import type { ModelChoice } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

/**
 * The models a provider states as its lineup — the permanent ones. A model with an
 * `until` is transitional (a vendor is about to route its id to a successor), so it is
 * not part of the headline count and would otherwise make the count flip on its
 * retirement date and rot the docs.
 */
const countStable = (models: ModelChoice[] | undefined): number =>
  (models ?? []).filter((m) => m.until === undefined).length;

test(".env.example names every provider's key variable", () => {
  const text = read("../../.env.example");
  // A local runtime (Ollama) has no key variable to fill in; its name has to be there instead.
  const missing = allProviders().filter((p) => !text.includes(p.local ? p.label : p.apiKeyEnv));
  assert.deepEqual(
    missing.map((p) => `${p.label} (${p.apiKeyEnv})`),
    [],
    "a provider ships that the first file a new user opens does not mention",
  );
});

test("PROVIDERS.md names every provider and its key", () => {
  const text = read("PROVIDERS.md");
  for (const p of allProviders()) {
    if (!p.local) assert.ok(text.includes(p.apiKeyEnv), `${p.label}'s key variable is missing`);
    assert.ok(text.includes(p.label), `${p.label} is not listed`);
  }
});

test("PROVIDERS.md states the real provider and model counts", () => {
  // The specific way it went wrong last time: prose that was true when written and
  // silently became a lie. A count is checkable, so it is checked.
  const text = read("PROVIDERS.md");
  const providers = allProviders();
  const models = providers.reduce((n, p) => n + countStable(p.models), 0);
  // Digits, not words, precisely so this can be checked. "Thirteen" reads better and
  // cannot be verified, which is how the old file came to promise providers that had
  // already shipped.
  const claim = text.match(/(\d+) providers, (\d+) models/);
  assert.ok(claim, "PROVIDERS.md no longer states the counts in a checkable form");
  assert.equal(Number(claim![1]), providers.length, "the stated provider count is wrong");
  assert.equal(Number(claim![2]), models, "the stated model count is wrong");
});

test("the README states the real provider and model counts", () => {
  // The front page is where a stale claim does the most damage, and it is exactly
  // where one survived longest: the README said "Two providers ship today" while
  // thirteen had shipped, and named OpenAI and Qwen as unclaimed driver work months
  // after both were built. Nobody re-reads the top of a README.
  const text = readFileSync(join(here, "..", "..", "README.md"), "utf8");
  const providers = allProviders();
  const models = providers.reduce((n, p) => n + countStable(p.models), 0);

  const claim = text.match(/(\d+) providers, (\d+) models/);
  assert.ok(claim, "the README no longer states the counts in a checkable form");
  assert.equal(Number(claim![1]), providers.length, "the README's provider count is wrong");
  assert.equal(Number(claim![2]), models, "the README's model count is wrong");

  // And it names them, so a provider added without a line here is caught too.
  for (const p of providers) {
    assert.ok(text.includes(p.label), `the README does not name ${p.label}`);
  }
});
