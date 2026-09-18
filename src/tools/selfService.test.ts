/**
 * selfService.test.ts — the settings the agent can change when it is simply ASKED, and
 * the honest answer for the ones it cannot.
 *
 * Every standing decision could be recorded and none could be taken back: "forget that
 * rule", "you can edit that file again", "drop that skill", "turn the linear server off"
 * all ended with the user editing files under `.mindweave/` by hand. And the tools that
 * did exist could not be FOUND: the deferred pool is only reachable through `find_tools`,
 * which scores names heavily and descriptions barely, so "remember a rule for this
 * project" did not return `governor` at all — it returned two tools that merely mention
 * the word "rule" in passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { governor, skillTool } from "./governorTools.js";
import { mindweaveStatus } from "./mindweaveStatus.js";
import { matchDeferred } from "./deferredNative.js";
import { loadGovernance } from "../governor/index.js";
import type { ToolContext } from "./types.js";

async function project(): Promise<{ dir: string; ctx: ToolContext }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "mw-selfservice-"));
  const governance = await loadGovernance(dir);
  return {
    dir,
    ctx: { cwd: dir, roots: [dir], reads: new Map(), todos: [], governance } as unknown as ToolContext,
  };
}

// ── lifting what was recorded ────────────────────────────────────────────────

test("a rule can be dropped again, live and on disk", async () => {
  const { dir, ctx } = await project();
  try {
    await governor.execute({ action: "remember_rule", value: "Use pnpm, never npm", name: "pnpm" }, ctx);
    assert.equal(ctx.governance!.rules.length, 1, "the rule was not recorded");

    const gone = await governor.execute({ action: "forget_rule", value: "pnpm" }, ctx);
    assert.ok(!gone.isError, gone.output);
    assert.equal(ctx.governance!.rules.length, 0, "the live session still carries the dropped rule");
    assert.equal((await loadGovernance(dir)).rules.length, 0, "the rule came back from disk");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("dropping a rule that was never set says so instead of claiming a change", async () => {
  const { dir, ctx } = await project();
  try {
    const miss = await governor.execute({ action: "forget_rule", value: "no-such-rule" }, ctx);
    assert.equal(miss.isError, true);
    assert.match(miss.output, /No rule named/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a forbidden path and a forbidden command can both be lifted", async () => {
  const { dir, ctx } = await project();
  try {
    await governor.execute({ action: "forbid_path", value: "src/legacy/**" }, ctx);
    await governor.execute({ action: "forbid_command", value: "git push --force" }, ctx);
    assert.ok(ctx.governance!.forbidden.patterns.includes("src/legacy/**"));

    const path = await governor.execute({ action: "unforbid_path", value: "src/legacy/**" }, ctx);
    const command = await governor.execute({ action: "unforbid_command", value: "git push --force" }, ctx);
    assert.ok(!path.isError, path.output);
    assert.ok(!command.isError, command.output);
    assert.ok(!ctx.governance!.forbidden.patterns.includes("src/legacy/**"), "the live guard still refuses the path");

    const fresh = await loadGovernance(dir);
    assert.ok(!fresh.forbidden.patterns.includes("src/legacy/**"), "the path came back from disk");
    assert.ok(!(fresh.forbidden.commands ?? []).includes("git push --force"), "the command came back from disk");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a skill can be created and then deleted by name", async () => {
  const { dir, ctx } = await project();
  try {
    const made = await skillTool.execute(
      { name: "Release Process", description: "ship a version", steps: "1. run the tests\n2. push" },
      ctx,
    );
    assert.ok(!made.isError, made.output);
    assert.equal(ctx.governance!.skills.length, 1);

    const gone = await skillTool.execute({ action: "delete", name: "release-process" }, ctx);
    assert.ok(!gone.isError, gone.output);
    assert.equal(ctx.governance!.skills.length, 0, "the live catalog still offers the deleted skill");
    assert.equal((await loadGovernance(dir)).skills.length, 0, "the skill came back from disk");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("deleting a skill that does not exist is reported, not invented", async () => {
  const { dir, ctx } = await project();
  try {
    const miss = await skillTool.execute({ action: "delete", name: "nothing-like-this" }, ctx);
    assert.equal(miss.isError, true);
    assert.match(miss.output, /No skill named/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── being findable by the words a person uses ────────────────────────────────

test("the words a user would say find the tool that does the thing", async () => {
  const cases: [query: string, tool: string][] = [
    ["remember a rule for this project", "governor"],
    ["forget that rule", "governor"],
    ["stop forbidding that command", "governor"],
    ["save this as a skill", "skill"],
    ["delete a skill", "skill"],
    ["add an mcp server", "mcp_server"],
    ["disable an mcp server", "mcp_server"],
    ["what version are you running", "mindweave"],
    ["what can you change yourself", "mindweave"],
    ["switch to another model", "mindweave"],
    ["undo the last change", "mindweave"],
  ];
  for (const [query, expected] of cases) {
    const names = matchDeferred(query).map((t) => t.name);
    assert.ok(names.includes(expected), `"${query}" did not find ${expected}; it found ${names.join(", ") || "nothing"}`);
  }
});

// ── knowing what it is, and who changes what ─────────────────────────────────

test("the status report names the version, the model, and this project's setup", async () => {
  const { dir, ctx } = await project();
  try {
    await governor.execute({ action: "remember_rule", value: "Use pnpm, never npm", name: "pnpm" }, ctx);
    const report = await mindweaveStatus.execute(
      {},
      { ...ctx, modelConfig: { model: "deepseek-v4-flash", thinking: false, effort: "high" } } as ToolContext,
    );
    const version = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")).version;
    assert.match(report.output, new RegExp(`v${version.replace(/\./g, "\\.")}`), "the running version is not reported");
    assert.match(report.output, /DeepSeek/, "the model in use is not reported");
    assert.match(report.output, /Rules \(1\): pnpm/);
    assert.match(report.output, /MCP servers: none configured/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the report says which settings are the user's, with the command for each", async () => {
  const { dir, ctx } = await project();
  try {
    const report = await mindweaveStatus.execute({}, ctx);
    // The point of this half: asked to switch model, the agent must answer with the
    // command rather than trying, or saying it cannot and stopping there.
    for (const command of ["/model", "/think", "/key", "/undo", "/compact", "/analytics", "/update"]) {
      assert.ok(report.output.includes(command), `${command} is not offered as the user's way to do it`);
    }
    assert.match(report.output, /I can change these myself/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
