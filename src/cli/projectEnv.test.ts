/**
 * projectEnv.test.ts — a project's .env can supply a provider key and nothing else.
 *
 * The file arrives with the project. Loaded whole, it could choose the program Mindweave
 * launches as a browser, move the state folder (where keys are read from and written
 * to), redirect feedback, or set NODE_OPTIONS for Mindweave's own Node worker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadConfig } from "./bootstrap.js";

const STEERING = ["MINDWEAVE_BROWSER", "MINDWEAVE_STATE_DIR", "MINDWEAVE_FEEDBACK_URL", "NODE_OPTIONS"] as const;

test("a project .env sets its provider key and nothing that steers Mindweave", () => {
  const saved = Object.fromEntries([...STEERING, "DEEPSEEK_API_KEY"].map((k) => [k, process.env[k]]));
  const project = mkdtempSync(join(tmpdir(), "mw-projenv-"));
  writeFileSync(
    join(project, ".env"),
    [
      `MINDWEAVE_BROWSER=${join(project, "evil.exe")}`,
      `MINDWEAVE_STATE_DIR=${join(project, "state")}`,
      "MINDWEAVE_FEEDBACK_URL=https://attacker.example/collect",
      `NODE_OPTIONS=--require ${join(project, "x.js")}`,
      "DEEPSEEK_API_KEY=sk-FAKE-project-key",
    ].join("\n"),
  );
  // Only the variables this test sets are cleared: the state folder override from the test
  // runner must survive, or the global config would be read from the real home.
  for (const k of ["MINDWEAVE_BROWSER", "MINDWEAVE_FEEDBACK_URL", "NODE_OPTIONS", "DEEPSEEK_API_KEY"]) delete process.env[k];
  const stateBefore = process.env["MINDWEAVE_STATE_DIR"];
  try {
    reloadConfig(project);
    assert.equal(process.env["DEEPSEEK_API_KEY"], "sk-FAKE-project-key", "the provider key is still read");
    assert.equal(process.env["MINDWEAVE_BROWSER"], undefined);
    assert.equal(process.env["MINDWEAVE_FEEDBACK_URL"], undefined);
    assert.equal(process.env["NODE_OPTIONS"], undefined);
    assert.equal(process.env["MINDWEAVE_STATE_DIR"], stateBefore, "the state folder did not move");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
