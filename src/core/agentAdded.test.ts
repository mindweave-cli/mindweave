/**
 * agentAdded.test.ts — what the agent saves itself shows up in Settings, and can be
 * edited and removed there exactly like something the user added.
 *
 * The agent writes through its own tools (`governor`, `skill`); the Settings screens
 * read and write through core/rulesSkills.ts and core/permissions.ts. Two paths to the
 * same files, so this runs the agent's real tools and then the screens' real functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../memory/session.js";
import { findTool } from "../tools/registry.js";
import { deleteRuleSkill, listRulesSkills, readRuleSkill, saveRuleSkill } from "./rulesSkills.js";
import { movePermission, permissionsView, removePermission } from "./permissions.js";
import { forbiddenCommandPatternReason, forbiddenPathReason } from "../governor/forbidden.js";

async function fresh() {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "agent-add-state-"));
  return createSession(mkdtempSync(join(tmpdir(), "agent-add-proj-")));
}
async function agent(s: Awaited<ReturnType<typeof fresh>>, tool: string, args: Record<string, unknown>) {
  const result = await findTool(tool)!.execute(args, s.toolContext);
  assert.ok(!result.isError, `${tool} failed: ${result.output}`);
}

test("a rule and a skill the agent saves are listed, editable and removable in Settings", async () => {
  const s = await fresh();
  await agent(s, "governor", { action: "remember_rule", value: "Use pnpm, never npm." });
  await agent(s, "skill", { name: "Release", description: "Ship a version", steps: "1. Test\n2. Tag" });

  const items = await listRulesSkills(s);
  assert.deepEqual(items.map((i) => `${i.kind}:${i.scope}`).sort(), ["rule:project", "skill:project"]);

  // Edit the agent's rule the way the Settings editor does, and the chat follows it.
  const rule = items.find((i) => i.kind === "rule")!;
  const text = await readRuleSkill(s, rule.file);
  assert.ok(text?.includes("Use pnpm, never npm."));
  await saveRuleSkill(s, rule.file, text!.replace("Use pnpm, never npm.", "Use bun."));
  assert.deepEqual(s.governance.rules.map((r) => r.body), ["Use bun."]);

  // Remove both from Settings.
  for (const item of items) await deleteRuleSkill(s, item.file);
  assert.deepEqual(await listRulesSkills(s), []);
  assert.deepEqual(s.governance.rules, []);
  assert.deepEqual(s.governance.skills, []);
});

test("a path and a command the agent forbids are listed, movable and removable in Permissions", async () => {
  const s = await fresh();
  await agent(s, "governor", { action: "forbid_path", value: "config/prod.json" });
  await agent(s, "governor", { action: "forbid_command", value: "git push --force" });

  const view = await permissionsView(s);
  assert.deepEqual(view.lists.path, [{ value: "config/prod.json", scope: "project" }]);
  assert.deepEqual(view.lists.command, [{ value: "git push --force", scope: "project" }]);

  // Make the command universal from Settings, then remove the path: both take effect now.
  await movePermission(s, "command", "git push --force", "project");
  assert.deepEqual((await permissionsView(s)).lists.command, [{ value: "git push --force", scope: "global" }]);
  assert.ok(forbiddenCommandPatternReason(s.toolContext.governance!.forbidden, "git push --force"));
  await removePermission(s, "path", "config/prod.json", "project");
  assert.equal(forbiddenPathReason(s.toolContext.governance!.forbidden, join(s.cwd, "config", "prod.json")), null);
});
