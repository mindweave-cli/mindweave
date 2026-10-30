/**
 * forgetByText.test.ts — taking something back when it is asked for the way a person says it.
 *
 * Seen as: "remove the rule entirely" ended with the agent trying `forget_rule` four times and giving up. The rules block shows a rule's
 * TEXT, never its name, and the tool wanted the name; and the rule was one of the user's own, kept for every project, which the
 * tool did not look at either. Rules, skills and lifted protections are now found by name or by what they say, in this project's and
 * in the user's own, and the question the person is asked says which one it is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { governor, skillTool } from "./governorTools.js";
import { resolveEntry } from "./resolveName.js";
import { loadGovernance } from "../governor/index.js";
import { stateRoot } from "../memory/store.js";
import type { ToolContext } from "./types.js";

const RULE_TEXT = "Always commit and push directly to the `main` branch. Never create a separate branch unless the user explicitly asks for one.";

async function setup(answer = "Yes") {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "mw-forget-")));
  // One of the user's own rules, for every project, with no name in the text that says it.
  await fs.mkdir(join(stateRoot(), "rules"), { recursive: true });
  const file = join(stateRoot(), "rules", "commit-and-push-to-main.md");
  await fs.writeFile(file, `---\ndescription: Commit and push straight to main\n---\n${RULE_TEXT}\n`, "utf8");
  const asked: Array<{ q: string; detail?: string }> = [];
  const governance = await loadGovernance(dir);
  const ctx = {
    cwd: dir,
    roots: [dir],
    reads: new Map(),
    todos: [],
    governance,
    requestApproval: async (q: string, _o: string[], detail?: string) => (asked.push({ q, ...(detail ? { detail } : {}) }), answer),
  } as unknown as ToolContext;
  const cleanup = async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(file, { force: true });
  };
  return { dir, ctx, file, asked, cleanup };
}

test("a rule is dropped by the text the model can see, and it was one of the user's own for every project", async () => {
  const { ctx, file, asked, cleanup } = await setup();
  try {
    assert.equal(ctx.governance!.rules.length, 1, "the user's own rule is in force");
    const r = await governor.execute({ action: "forget_rule", value: RULE_TEXT }, ctx);
    assert.ok(!r.isError, r.output);
    assert.equal(existsSync(file), false, "the rule file is gone");
    assert.equal(ctx.governance!.rules.length, 0, "and the live session no longer carries it");
    assert.match(asked[0]!.q, /EVERY project/, "the person is told it applies everywhere");
    assert.match(r.output, /every project/);
  } finally {
    await cleanup();
  }
});

test("a short phrase from the rule, or its name, finds the same rule", async () => {
  for (const value of ["Never create a separate branch", "commit-and-push-to-main", "COMMIT AND PUSH TO MAIN"]) {
    const { ctx, file, cleanup } = await setup();
    try {
      const r = await governor.execute({ action: "forget_rule", value }, ctx);
      assert.ok(!r.isError, `${value}: ${r.output}`);
      assert.equal(existsSync(file), false, value);
    } finally {
      await cleanup();
    }
  }
});

test("a no changes nothing", async () => {
  const { ctx, file, cleanup } = await setup("No");
  try {
    const r = await governor.execute({ action: "forget_rule", value: RULE_TEXT }, ctx);
    assert.match(r.output, /declined/);
    assert.equal(existsSync(file), true);
    assert.equal(ctx.governance!.rules.length, 1);
  } finally {
    await cleanup();
  }
});

test("a miss lists the rules that exist, by name, so the next try can use one", async () => {
  const { ctx, cleanup } = await setup();
  try {
    const r = await governor.execute({ action: "forget_rule", value: "wear a hat on Fridays" }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.output, /commit-and-push-to-main \(yours, for every project\)/);
  } finally {
    await cleanup();
  }
});

test("two rules that both fit are not guessed between", async () => {
  const { dir, ctx, file, cleanup } = await setup();
  try {
    await fs.mkdir(join(dir, ".mindweave-unused"), { recursive: true });
    await governor.execute({ action: "remember_rule", value: "Commit messages are short and in the present tense", name: "commit-style" }, ctx);
    const r = await governor.execute({ action: "forget_rule", value: "commit" }, ctx);
    assert.equal(r.isError, true);
    assert.match(r.output, /more than one rule/);
    assert.match(r.output, /commit-style/);
    assert.match(r.output, /commit-and-push-to-main/);
    assert.equal(existsSync(file), true, "nothing was dropped");
  } finally {
    await cleanup();
  }
});

test("this project's own rule is still dropped by its name", async () => {
  const { ctx, cleanup } = await setup();
  try {
    await governor.execute({ action: "remember_rule", value: "Use pnpm, never npm", name: "pnpm" }, ctx);
    const r = await governor.execute({ action: "forget_rule", value: "pnpm" }, ctx);
    assert.ok(!r.isError, r.output);
    assert.ok(!ctx.governance!.rules.some((x) => x.name === "pnpm"));
  } finally {
    await cleanup();
  }
});

test("a skill of the user's own is deleted by what it says, from where it lives", async () => {
  const { dir, ctx, cleanup } = await setup();
  const skillDir = join(stateRoot(), "skills", "ship-it");
  try {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(join(skillDir, "SKILL.md"), "---\nname: ship-it\ndescription: Cut a release and tag it\n---\nSteps\n", "utf8");
    ctx.governance = await loadGovernance(dir);
    const r = await skillTool.execute({ action: "delete", name: "cut a release and tag it" }, ctx);
    assert.ok(!r.isError, r.output);
    assert.equal(existsSync(skillDir), false);
    assert.match(r.output, /every project/);
  } finally {
    await fs.rm(skillDir, { recursive: true, force: true });
    await cleanup();
  }
});

test("a command the user forbade for every project can be allowed again", async () => {
  const { ctx, cleanup } = await setup();
  const file = join(stateRoot(), "forbidden-commands.md");
  try {
    await fs.writeFile(file, "git push --force\n", "utf8");
    const r = await governor.execute({ action: "unforbid_command", value: "push --force" }, ctx);
    assert.ok(!r.isError, r.output);
    assert.doesNotMatch(await fs.readFile(file, "utf8"), /git push --force/);
  } finally {
    await fs.rm(file, { force: true });
    await cleanup();
  }
});

test("nobody to ask: a protection is not lifted by a message that is not the person's", async () => {
  const { ctx, cleanup } = await setup();
  try {
    (ctx as { requestApproval?: unknown }).requestApproval = undefined;
    const r = await governor.execute({ action: "unforbid_path", value: "src/legacy/**" }, ctx);
    assert.match(r.output, /Not done/);
  } finally {
    await cleanup();
  }
});

test("the matcher: exact first, then the same ignoring punctuation, then a piece of one; several is not one", () => {
  const rules = [{ n: "pnpm", t: "Use pnpm, never npm." }, { n: "tests", t: "Every component gets a test" }];
  assert.deepEqual(resolveEntry(rules, "pnpm", (x) => [x.n, x.t]), { kind: "one", item: rules[0] });
  assert.deepEqual(resolveEntry(rules, "use pnpm never npm", (x) => [x.n, x.t]), { kind: "one", item: rules[0] });
  assert.deepEqual(resolveEntry(rules, "gets a test", (x) => [x.n, x.t]), { kind: "one", item: rules[1] });
  assert.equal(resolveEntry(rules, "e", (x) => [x.n, x.t]).kind, "none", "a few letters match nothing");
  assert.equal(resolveEntry(rules, "", (x) => [x.n, x.t]).kind, "none");
  const dup = [{ n: "a", t: "run the build first" }, { n: "b", t: "run the build last" }];
  assert.equal(resolveEntry(dup, "run the build", (x) => [x.n, x.t]).kind, "many");
});
