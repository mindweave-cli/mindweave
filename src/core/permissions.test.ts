/**
 * permissions.test.ts — standing permissions, per project or for every project.
 *
 * Each case checks two things: the file the next launch will read, and the LIVE session
 * (what the very next tool call is judged by), because a settings change that only took
 * effect after a restart is the failure this screen exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../memory/session.js";
import { projectDir, stateRoot } from "../memory/store.js";
import { forbiddenPathReason, forbiddenCommandPatternReason } from "../governor/forbidden.js";
import {
  addPermission,
  defaultModeFor,
  movePermission,
  permissionsView,
  removePermission,
  revokeSessionGrant,
  setDefaultMode,
} from "./permissions.js";

async function fresh() {
  process.env.MINDWEAVE_STATE_DIR = mkdtempSync(join(tmpdir(), "perm-state-"));
  const cwd = mkdtempSync(join(tmpdir(), "perm-proj-"));
  const session = await createSession(cwd);
  return session;
}
const file = (dir: string, name: string) => {
  try {
    return readFileSync(join(dir, name), "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
};
const live = (s: Awaited<ReturnType<typeof fresh>>) => s.toolContext.governance!;

test("a project entry and a universal entry both apply at once, each saved in its own file", async () => {
  const s = await fresh();
  assert.equal((await addPermission(s, "path", "./secrets/", "project")).ok, true);
  assert.equal((await addPermission(s, "command", "git push --force", "global")).ok, true);
  assert.deepEqual(file(projectDir(s.cwd), "forbidden.md"), ["secrets"]);
  assert.deepEqual(file(stateRoot(), "forbidden-commands.md"), ["git push --force"]);
  assert.ok(forbiddenPathReason(live(s).forbidden, join(s.cwd, "secrets", "a.txt")), "project path blocked now");
  assert.ok(forbiddenCommandPatternReason(live(s).forbidden, "git  push --force origin"), "universal command blocked now");
  const view = await permissionsView(s);
  assert.deepEqual(view.lists.path, [{ value: "secrets", scope: "project" }]);
  assert.deepEqual(view.lists.command, [{ value: "git push --force", scope: "global" }]);
});

test("a universal entry reaches a different project too", async () => {
  const s = await fresh();
  await addPermission(s, "path", "*.pem", "global");
  const other = await createSession(mkdtempSync(join(tmpdir(), "perm-other-")));
  assert.ok(forbiddenPathReason(other.toolContext.governance!.forbidden, join(other.cwd, "key.pem")));
});

test("moving an entry between scopes leaves exactly one copy, and removing lifts it at once", async () => {
  const s = await fresh();
  await addPermission(s, "path", "src/legacy", "project");
  await movePermission(s, "path", "src/legacy", "project");
  assert.deepEqual(file(projectDir(s.cwd), "forbidden.md"), []);
  assert.deepEqual(file(stateRoot(), "forbidden.md"), ["src/legacy"]);
  assert.equal((await addPermission(s, "path", "src/legacy", "global")).ok, false, "a duplicate is refused");
  await removePermission(s, "path", "src/legacy", "global");
  assert.equal(forbiddenPathReason(live(s).forbidden, join(s.cwd, "src", "legacy", "x.ts")), null);
});

test("bad values are refused with a reason, not saved", async () => {
  const s = await fresh();
  assert.equal((await addPermission(s, "path", "C:\\Windows\\x", "project")).ok, false);
  assert.equal((await addPermission(s, "path", "../other", "project")).ok, false);
  assert.equal((await addPermission(s, "mcpTool", "not-a-tool", "project")).ok, false);
  assert.equal((await addPermission(s, "sentinel", "governor", "global")).ok, false, "changing permissions is always asked");
  assert.deepEqual(file(projectDir(s.cwd), "forbidden.md"), []);
});

test("a Sentinel allowance is live at once and offered only for actions that change things", async () => {
  const s = await fresh();
  await addPermission(s, "sentinel", "run_command", "global");
  assert.deepEqual(live(s).sentinelAllow, ["run_command"]);
  const choices = (await permissionsView(s)).choices.sentinel.map((c) => c.value);
  assert.ok(choices.includes("edit") && choices.includes("run_command"));
  assert.ok(!choices.includes("read_file") && !choices.includes("governor") && !choices.includes("mcp_server"));
});

test("the project's default mode wins over the universal one, and clearing it falls back", async () => {
  const s = await fresh();
  assert.equal(await defaultModeFor(s.cwd), null);
  await setDefaultMode(s, "global", "sentinel");
  assert.equal(await defaultModeFor(s.cwd), "sentinel");
  await setDefaultMode(s, "project", "architect");
  assert.equal(await defaultModeFor(s.cwd), "architect");
  await setDefaultMode(s, "project", null);
  assert.equal(await defaultModeFor(s.cwd), "sentinel");
});

test("revoking a pattern lifted for this session puts the block back", async () => {
  const s = await fresh();
  await addPermission(s, "path", "config/prod.json", "project");
  // What approval.ts does when the user says "yes, this time".
  const g = live(s);
  g.lifted = ["config/prod.json"];
  g.forbidden = { ...g.forbidden, patterns: g.forbidden.patterns.filter((p) => p !== "config/prod.json") };
  assert.equal(forbiddenPathReason(live(s).forbidden, join(s.cwd, "config", "prod.json")), null);
  await revokeSessionGrant(s, "lifted", "config/prod.json");
  assert.ok(forbiddenPathReason(live(s).forbidden, join(s.cwd, "config", "prod.json")));
});

test("another project can be viewed and edited without touching the open one", async () => {
  const s = await fresh();
  const other = mkdtempSync(join(tmpdir(), "perm-elsewhere-"));
  assert.equal((await addPermission(s, "command", "npm publish", "project", other)).ok, true);
  assert.deepEqual(file(projectDir(other), "forbidden-commands.md"), ["npm publish"]);
  assert.deepEqual(file(projectDir(s.cwd), "forbidden-commands.md"), [], "the open project is untouched");
  const view = await permissionsView(s, other);
  assert.equal(view.project.current, false);
  assert.deepEqual(view.lists.command, [{ value: "npm publish", scope: "project" }]);
  assert.equal((await permissionsView(s)).project.current, true);
  await setDefaultMode(s, "project", "architect", other);
  assert.equal(await defaultModeFor(other), "architect");
  assert.equal(await defaultModeFor(s.cwd), null);
});

test("command rules are listed, added, moved and removed like the other lists, and apply at once", async () => {
  const s = await fresh();
  assert.equal((await addPermission(s, "commandRule", "allow npm test", "project")).ok, true);
  assert.equal((await addPermission(s, "commandRule", "forbid npm publish :: releases are done by hand", "global")).ok, true);
  assert.deepEqual(file(projectDir(s.cwd), "command-rules.md"), ["allow npm test"]);
  assert.deepEqual(file(stateRoot(), "command-rules.md"), ["forbid npm publish :: releases are done by hand"]);
  assert.deepEqual(
    live(s).commandRules?.map((r) => `${r.decision} ${r.words.join(" ")}`),
    ["forbid npm publish", "allow npm test"],
    "the live session already has both",
  );
  const view = await permissionsView(s);
  assert.deepEqual(view.lists.commandRule.map((i) => `${i.scope}:${i.value}`), ["project:allow npm test", "global:forbid npm publish :: releases are done by hand"]);
  // A line that is not a rule is refused, not written.
  const bad = await addPermission(s, "commandRule", "please run tests", "project");
  assert.equal(bad.ok, false);
  assert.deepEqual(file(projectDir(s.cwd), "command-rules.md"), ["allow npm test"]);
  // Twice is once.
  assert.equal((await addPermission(s, "commandRule", "allow   npm   test", "project")).ok, false);
  assert.equal((await movePermission(s, "commandRule", "allow npm test", "project")).ok, true);
  assert.deepEqual(file(projectDir(s.cwd), "command-rules.md"), []);
  assert.ok(file(stateRoot(), "command-rules.md").includes("allow npm test"));
  assert.equal((await removePermission(s, "commandRule", "allow npm test", "global")).ok, true);
  assert.deepEqual(live(s).commandRules?.map((r) => r.decision), ["forbid"]);
});
