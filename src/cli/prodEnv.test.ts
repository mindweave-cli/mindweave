/**
 * prodEnv.test.ts — the UI runs on React's production build, and the setting does not leak.
 *
 * The leak is the dangerous half: this process runs the user's commands, and a child inherits
 * NODE_ENV. Left at "production" it makes `npm install` skip dev dependencies. Each case runs in
 * a fresh process because React chooses its build once, when it first loads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const prodEnvUrl = new URL("./prodEnv.ts", import.meta.url).href;

function run(env: Record<string, string | undefined>): { after: string; devBuild: boolean } {
  const script = `
    import { createRequire } from "node:module";
    const { loadWithProductionEnv } = await import("${prodEnvUrl}");
    await loadWithProductionEnv(["react"]);
    const React = createRequire(process.cwd() + "/x.js")("react");
    console.log(JSON.stringify({ after: String(process.env.NODE_ENV), devBuild: /validat|didWarn/.test(String(React.createElement)) }));
  `;
  const e = { ...process.env, ...env } as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: e, encoding: "utf8", cwd: process.cwd() });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as { after: string; devBuild: boolean };
}

test("React loads in production mode and NODE_ENV is put back as it was (unset)", () => {
  const r = run({ NODE_ENV: undefined });
  assert.equal(r.devBuild, false, "the development build ran");
  assert.equal(r.after, "undefined", "NODE_ENV leaked into the process and so into every command it runs");
});

test("an explicit NODE_ENV is the user's choice and is left alone", () => {
  const r = run({ NODE_ENV: "development" });
  assert.equal(r.devBuild, true);
  assert.equal(r.after, "development");
});
