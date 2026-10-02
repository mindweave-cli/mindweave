/**
 * rulesSkills.test.ts — rules and skills as files, per project or for all projects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../memory/session.js";
import { createRuleSkill, deleteRuleSkill, importRuleSkill, listRulesSkills, moveRuleSkill, readRuleSkill, saveRuleSkill } from "./rulesSkills.js";

async function fresh() {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "rs-state-"));
  return createSession(mkdtempSync(join(tmpdir(), "rs-proj-")));
}

test("a saved rule reaches the open chat at once, from either scope", async () => {
  const s = await fresh();
  const r = await createRuleSkill(s, "rule", "Use pnpm", "global");
  assert.ok(r.ok && r.file);
  await saveRuleSkill(s, r.file!, "---\nname: use-pnpm\n---\nUse pnpm, never npm.\n");
  assert.deepEqual(s.governance.rules.map((x) => x.body), ["Use pnpm, never npm."]);
  const p = await createRuleSkill(s, "rule", "Tests", "project");
  await saveRuleSkill(s, p.ok ? p.file! : "", "Every change gets a test.");
  assert.equal(s.governance.rules.length, 2);
  assert.deepEqual((await listRulesSkills(s)).map((i) => `${i.kind}:${i.name}:${i.scope}`), ["rule:tests:project", "rule:use-pnpm:global"]);
});

test("a skill is created from a template, moved between scopes, and deleted with its folder", async () => {
  const s = await fresh();
  const r = await createRuleSkill(s, "skill", "Deploy app", "project");
  assert.ok(r.ok);
  assert.deepEqual(s.governance.skills.map((k) => k.name), ["deploy-app"]);
  const moved = await moveRuleSkill(s, r.ok ? r.file! : "");
  assert.ok(moved.ok);
  assert.deepEqual((await listRulesSkills(s)).map((i) => i.scope), ["global"]);
  await deleteRuleSkill(s, moved.ok ? moved.file! : "");
  assert.deepEqual(await listRulesSkills(s), []);
  assert.deepEqual(s.governance.skills, []);
});

test("a project rule overrides a universal one of the same name", async () => {
  const s = await fresh();
  const g = await createRuleSkill(s, "rule", "style", "global");
  await saveRuleSkill(s, g.ok ? g.file! : "", "Use tabs.");
  const p = await createRuleSkill(s, "rule", "style", "project");
  await saveRuleSkill(s, p.ok ? p.file! : "", "Use two spaces.");
  assert.deepEqual(s.governance.rules.map((x) => x.body), ["Use two spaces."]);
});

test("nothing outside the rules and skills folders can be read or written through it", async () => {
  const s = await fresh();
  const outside = join(s.cwd, "secret.md");
  writeFileSync(outside, "x");
  assert.equal(await readRuleSkill(s, outside), null);
  assert.equal((await saveRuleSkill(s, outside, "y")).ok, false);
  assert.equal((await deleteRuleSkill(s, join(s.cwd, "..", "rules", "a.md"))).ok, false);
});

test("an uploaded file becomes a rule or a skill by what it is, with its text kept", async () => {
  const s = await fresh();
  assert.equal((await importRuleSkill(s, "No Console Logs.md", "Never leave console.log in code.", "project")).kind, "rule");
  const skill = await importRuleSkill(s, "SKILL.md", "---\nname: Release\nwhen_to_use: when shipping\n---\n1. Tag\n", "global");
  assert.equal(skill.kind, "skill");
  const flagged = await importRuleSkill(s, "deploy.md", "---\nwhen_to_use: deploying\n---\nSteps", "project");
  assert.equal(flagged.kind, "skill");
  assert.deepEqual((await listRulesSkills(s)).map((i) => `${i.kind}:${i.name}:${i.scope}`), ["rule:no-console-logs:project", "skill:deploy:project", "skill:release:global"]);
  assert.deepEqual(s.governance.rules.map((r) => r.body), ["Never leave console.log in code."]);
  assert.equal((await importRuleSkill(s, "SKILL.md", "no header, no name", "project")).ok, false, "a nameless SKILL.md is refused");
  assert.equal((await importRuleSkill(s, "empty.md", "  ", "project")).ok, false);
});
