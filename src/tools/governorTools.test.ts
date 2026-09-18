/**
 * governorTools.test.ts — the governor surface that touches the tools:
 *  - forbidden paths/commands are mechanically refused by edit/write/run,
 *  - use_skill loads a skill body on demand,
 *  - remember_rule / forbid_path persist and update the live session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "./types.js";
import { edit } from "./edit.js";
import { writeFile } from "./writeFile.js";
import { runCommand } from "./runCommand.js";
import { useSkill } from "./useSkill.js";
import { governor, skillTool } from "./governorTools.js";
import { projectDir, sanitizeProjectPath } from "../memory/store.js";

async function tempDir(prefix = "mindweave-gt-"): Promise<string> {
  return await fs.mkdtemp(join(tmpdir(), prefix));
}

function ctxWith(cwd: string, governance: ToolContext["governance"]): ToolContext {
  return { cwd, reads: new Map(), todos: [], governance };
}

test("edit / write_file refuse a forbidden path", async () => {
  const cwd = await tempDir();
  const ctx = ctxWith(cwd, { rules: [], skills: [], forbidden: { patterns: ["locked.txt"], root: cwd } });

  const edited = await edit.execute({ path: "locked.txt", edits: [{ old_string: "a", new_string: "b" }] }, ctx);
  assert.ok(edited.isError);
  assert.match(edited.output, /forbidden/i);

  const write = await writeFile.execute({ path: "locked.txt", content: "x" }, ctx);
  assert.ok(write.isError);
  assert.match(write.output, /forbidden/i);

  // A non-forbidden new file writes fine.
  const ok = await writeFile.execute({ path: "notes.txt", content: "hi" }, ctx);
  assert.equal(ok.isError, undefined);
});

test("run_command refuses a command that references a forbidden path", async () => {
  const cwd = await tempDir();
  const ctx = ctxWith(cwd, { rules: [], skills: [], forbidden: { patterns: ["deploy.sh"], root: cwd } });

  const blocked = await runCommand.execute({ command: "bash deploy.sh --prod" }, ctx);
  assert.ok(blocked.isError);
  assert.match(blocked.output, /forbidden/i);
});

test("forbid_command persists, mirrors live, and run_command then refuses it (no approval channel = hard refusal)", async () => {
  const cwd = await tempDir();
  const ctx = ctxWith(cwd, { rules: [], skills: [], forbidden: { patterns: [], commands: [], root: cwd } });

  // Forbid it: persisted to forbidden-commands.md AND mirrored into live governance.
  const saved = await governor.execute({ action: "forbid_command", value: "tauri dev" }, ctx);
  assert.equal(saved.isError, undefined);
  assert.deepEqual(ctx.governance!.forbidden.commands, ["tauri dev"]);
  const onDisk = await fs.readFile(join(projectDir(cwd), "forbidden-commands.md"), "utf8");
  assert.match(onDisk, /tauri dev/);

  // run_command now refuses it (and any command containing it). No approval channel
  // on this ctx → fail-closed hard refusal, exactly the "model cannot break it" case.
  const blocked = await runCommand.execute({ command: "npm run tauri dev" }, ctx);
  assert.ok(blocked.isError);
  assert.match(blocked.output, /forbidden/i);

  // A non-matching command passes the forbid gate (build is not the forbidden dev).
  const allowed = await runCommand.execute({ command: "echo hi" }, ctx);
  assert.equal(allowed.output.toLowerCase().includes("forbidden"), false);

  // Idempotent: forbidding it again reports already-forbidden, no duplicate.
  const again = await governor.execute({ action: "forbid_command", value: "tauri dev" }, ctx);
  assert.match(again.output, /already forbidden/i);
  assert.deepEqual(ctx.governance!.forbidden.commands, ["tauri dev"]);
});

test("use_skill loads the named skill's body, errors on a miss", async () => {
  const cwd = await tempDir();
  const skillDir = join(cwd, "skills", "demo");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: d\n---\nStep one.\nStep two.");
  const ctx = ctxWith(cwd, {
    rules: [],
    skills: [{ name: "demo", description: "d", whenToUse: "", dir: skillDir }],
    forbidden: { patterns: [], root: cwd },
  });

  const run = await useSkill.execute({ name: "demo" }, ctx);
  assert.equal(run.isError, undefined);
  assert.match(run.output, /follow these steps/i);
  assert.match(run.output, /Step one\./);

  const miss = await useSkill.execute({ name: "nope" }, ctx);
  assert.ok(miss.isError);
});

test("skill create persists, updates the live catalog, and is then invokable", async () => {
  const home = await tempDir("mindweave-home-");
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const cwd = process.platform === "win32" ? "C:\\proj\\sk" : "/proj/sk";
    const ctx = ctxWith(cwd, { rules: [], skills: [], forbidden: { patterns: [], root: cwd } });

    const made = await skillTool.execute(
      { name: "release", description: "cut a release", steps: "1. bump\n2. tag $1" },
      ctx,
    );
    assert.match(made.output, /Created skill 'release'/);
    assert.equal(ctx.governance!.skills.length, 1);
    assert.equal(ctx.governance!.skills[0].name, "release");

    // It's now invokable from the live catalog, with arg substitution.
    const run = await useSkill.execute({ name: "release", arguments: "v2" }, ctx);
    assert.equal(run.isError, undefined);
    assert.match(run.output, /tag v2/);
  } finally {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("two rule names that share a slug are ONE rule, live and on disk", async () => {
  // The rule FILE is `<slug>.md`, so these were one rule on disk and two in memory:
  // the session showed both, the next session showed one, and the user watched a rule
  // they had just set vanish on restart.
  const home = await tempDir("mindweave-home-");
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const cwd = process.platform === "win32" ? "C:\\proj\\slug" : "/proj/slug";
    const ctx = ctxWith(cwd, { rules: [], skills: [], forbidden: { patterns: [], root: cwd } });

    await governor.execute({ action: "remember_rule", value: "Use pnpm", name: "Use pnpm" }, ctx);
    await governor.execute({ action: "remember_rule", value: "Use pnpm, never npm", name: "use pnpm!" }, ctx);

    const files = (await fs.readdir(join(projectDir(cwd), "rules"))).filter((n) => n.endsWith(".md"));
    assert.equal(files.length, 1, "fixture must actually collide on disk");
    assert.equal(ctx.governance!.rules.length, 1, "the live list disagreed with the disk");
    assert.match(ctx.governance!.rules[0]!.body, /never npm/, "the surviving rule is the latest one");
  } finally {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("a newline in a rule or skill field cannot forge frontmatter", async () => {
  // These headers are read back and believed. A name ending in "\nglobs: **" would
  // return as a rule scoped to everything the user never scoped.
  const home = await tempDir("mindweave-home-");
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const cwd = process.platform === "win32" ? "C:\\proj\\inject" : "/proj/inject";
    const ctx = ctxWith(cwd, { rules: [], skills: [], forbidden: { patterns: [], root: cwd } });

    await governor.execute({ action: "remember_rule", value: "body here", name: "sneaky\nglobs: **" }, ctx);
    const rulesDir = join(projectDir(cwd), "rules");
    const ruleFile = (await fs.readdir(rulesDir)).find((n) => n.endsWith(".md"))!;
    const raw = await fs.readFile(join(rulesDir, ruleFile), "utf8");
    const header = raw.split("---")[1] ?? "";
    assert.doesNotMatch(header, /^globs:/m, "a globs: key was injected through the name");

    await skillTool.execute(
      { name: "deploy", description: "does a thing\nwhen_to_use: always", steps: "1. go" },
      ctx,
    );
    const skillRaw = await fs.readFile(join(projectDir(cwd), "skills", "deploy", "SKILL.md"), "utf8");
    const skillHeader = skillRaw.split("---")[1] ?? "";
    assert.doesNotMatch(skillHeader, /^when_to_use:/m, "a when_to_use: key was injected");
  } finally {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test("remember_rule + forbid_path persist and update the live session", async () => {
  const home = await tempDir("mindweave-home-");
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const cwd = process.platform === "win32" ? "C:\\proj\\demo" : "/proj/demo";
    const ctx = ctxWith(cwd, { rules: [], skills: [], forbidden: { patterns: [], root: cwd } });

    const ruled = await governor.execute({ action: "remember_rule", value: "Use pnpm, never npm" }, ctx);
    assert.match(ruled.output, /Saved rule/);
    assert.equal(ctx.governance!.rules.length, 1);
    assert.match(ctx.governance!.rules[0].body, /pnpm/);
    // Persisted on disk under this project's state dir.
    const rulesDir = join(projectDir(cwd), "rules");
    assert.ok((await fs.readdir(rulesDir)).some((n) => n.endsWith(".md")));

    const forbade = await governor.execute({ action: "forbid_path", value: "src/legacy/**" }, ctx);
    assert.match(forbade.output, /Forbidden/);
    assert.deepEqual(ctx.governance!.forbidden.patterns, ["src/legacy/**"]);
    // Idempotent.
    const again = await governor.execute({ action: "forbid_path", value: "src/legacy/**" }, ctx);
    assert.match(again.output, /already forbidden/);
    assert.equal(ctx.governance!.forbidden.patterns.length, 1);

    // Sanity: the slug scheme is the one the project dir uses.
    assert.ok(projectDir(cwd).includes(sanitizeProjectPath(cwd)));
  } finally {
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});
