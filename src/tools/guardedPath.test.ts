/**
 * guardedPath.test.ts — every tool that takes a path judges the file, not the string.
 *
 * Each of these got a secret out before: a Windows stream spelling of .env, a link inside
 * the project pointing at .git or .ssh, a search pointed straight at .env, the ui tool
 * opening .env as a file:// page, and a write through a link landing outside the project
 * with no question. The last test asks every tool that takes a file path for .env, so a
 * tool added later without the guard fails here rather than in someone's session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { guardedPathReason, protectedPathReason } from "./guard.js";
import { TOOLS } from "./registry.js";
import type { ToolContext } from "./types.js";

const SECRET = "API_KEY=hunter2-FAKE-guarded";
const WIN = process.platform === "win32";

function project(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-guarded-")));
  writeFileSync(join(root, ".env"), SECRET + "\n");
  writeFileSync(join(root, "app.js"), "const API_KEY_NAME = 1;\n");
  return root;
}

/** A directory link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
function linkDir(target: string, at: string): void {
  symlinkSync(target, at, WIN ? "junction" : "dir");
}

const ctxFor = (root: string): ToolContext => ({ cwd: root, roots: [root], reads: new Map(), todos: [] });

test("other spellings of a protected file are judged as that file", { skip: !WIN }, async () => {
  const root = project();
  for (const spelling of [".env::$DATA", ".env.", ".env ", ".env. . "]) {
    assert.ok(await guardedPathReason(join(root, spelling)), spelling);
  }
});

test("a link inside the project to .git or a key folder is judged by where it goes", async () => {
  const root = project();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  linkDir(join(root, ".git"), join(root, "g"));
  assert.ok(await guardedPathReason(join(root, "g", "config")));
  assert.equal(await guardedPathReason(join(root, "app.js")), null, "ordinary files stay readable");
});

test("files that hold tokens are protected, ordinary code is not", () => {
  for (const p of [".npmrc", ".netrc", ".git-credentials", ".pypirc", ".docker/config.json", ".kube/config", "server.key", "cert.p12", "prod.tfvars", "terraform.tfstate", "service-account-prod.json", ".aws/credentials", ".config/gh/hosts.yml", "Library/Keychains/login.keychain-db", ".local/share/keyrings/login.keyring", ".password-store/work/token.gpg", "AppData/Roaming/Microsoft/Credentials/ABC123", "AppData/Roaming/Microsoft/Vault/x"]) {
    assert.ok(protectedPathReason(`/home/u/${p}`), p);
  }
  for (const p of ["src/env.ts", "src/keys.ts", "docker-compose.yml", "src/config.json", "README.md", "package.json", "src/Library/index.ts", "docs/keyrings.md"]) {
    assert.equal(protectedPathReason(`/home/u/project/${p}`), null, p);
  }
});

test("a write through a link to outside the project asks, and with nobody to ask is refused", async () => {
  const root = project();
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-guarded-out-")));
  linkDir(outside, join(root, "docs"));
  const write = TOOLS.find((t) => t.name === "write_file")!;
  const r = await write.execute({ path: "docs/planted.txt", content: "x" }, ctxFor(root));
  assert.match(r.output, /outside the workspace/);
  assert.equal(existsSync(join(outside, "planted.txt")), false);
});

test("no tool that takes a file path hands back .env or changes it", async () => {
  const root = project();
  const env = join(root, ".env");
  const fileish = TOOLS.filter((t) => {
    const props = Object.keys((t.parameters as { properties?: object }).properties ?? {});
    return props.some((p) => p === "path" || p === "paths") || t.name === "ui";
  });
  assert.ok(fileish.length >= 8, `only ${fileish.length} tools found; did the parameter names change?`);
  for (const tool of fileish) {
    const args =
      tool.name === "ui"
        ? { url: pathToFileURL(env).href }
        : {
            path: ".env",
            paths: [".env"],
            pattern: "API_KEY",
            output_mode: "content",
            name: "API_KEY",
            content: "API_KEY=replaced",
            new_definition: "x",
            edits: [{ old_string: SECRET, new_string: "API_KEY=replaced" }],
          };
    let output = "";
    try {
      const r = await tool.execute(args, ctxFor(root));
      output = `${r.output} ${r.detail ?? ""}`;
    } catch (error) {
      output = String(error);
    }
    assert.ok(!output.includes("hunter2-FAKE-guarded"), `${tool.name} returned the secret`);
    assert.equal(readFileSync(env, "utf8"), SECRET + "\n", `${tool.name} changed .env`);
  }
});

test("a forbidden folder cannot be edited through a link to it", async () => {
  const root = project();
  mkdirSync(join(root, "src", "legacy"), { recursive: true });
  writeFileSync(join(root, "src", "legacy", "old.ts"), "export const x = 1;\n");
  linkDir(join(root, "src", "legacy"), join(root, "docs"));
  const ctx: ToolContext = { ...ctxFor(root), governance: { rules: [], skills: [], forbidden: { patterns: ["src/legacy"], root } } };
  const write = TOOLS.find((t) => t.name === "write_file")!;
  const r = await write.execute({ path: "docs/planted.ts", content: "x" }, ctx);
  assert.equal(existsSync(join(root, "src", "legacy", "planted.ts")), false, `written: ${r.output}`);
});
