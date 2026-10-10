/**
 * planArtifact.test.ts — the plan survives what the transcript cannot.
 *
 * Covers the artifact lifecycle (save → load → done / deleted), the rendered
 * standing-knowledge block and its divergence contract, injection placement in
 * the volatile tail (execution turns only, never while planning — and therefore
 * independent of compaction entirely), and exit_plan writing the artifact at the
 * moment of approval.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  savePlanArtifact,
  loadPlanArtifact,
  completePlanArtifact,
  renderPlanBlock,
  planDivergenceStop,
  PLAN_DIR,
  PLAN_FILE,
} from "./planArtifact.js";
import { volatileContext } from "./engine.js";
import { exitPlan } from "../tools/exitPlan.js";
import type { ToolContext } from "../tools/types.js";

const PLAN = "1. Add the guard to `src/a.ts`\n2. Update the test in `src/a.test.ts`\n3. Run the suite";

async function freshRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "mw-plan-"));
}

test("save → load roundtrip preserves the plan verbatim", async () => {
  const root = await freshRoot();
  await savePlanArtifact(root, PLAN, "lightning");
  const loaded = await loadPlanArtifact(root);
  assert.ok(loaded);
  assert.equal(loaded!.plan, PLAN);
  assert.equal(loaded!.mode, "lightning");
  assert.ok(loaded!.approvedAt.includes("T"), "approvedAt is an ISO timestamp");
});

test("a completed plan stops loading, but the file remains as history", async () => {
  const root = await freshRoot();
  await savePlanArtifact(root, PLAN, "sentinel");
  await completePlanArtifact(root);
  assert.equal(await loadPlanArtifact(root), null, "done means not active");
  const text = await fs.readFile(join(root, PLAN_DIR, PLAN_FILE), "utf8");
  assert.ok(text.includes("status=done"), "the record survives completion");
});

test("the user deleting the file is a complete off switch", async () => {
  const root = await freshRoot();
  await savePlanArtifact(root, PLAN, "lightning");
  await fs.rm(join(root, PLAN_DIR, PLAN_FILE));
  assert.equal(await loadPlanArtifact(root), null);
});

test("a user edit to the body survives; a gutted body deactivates", async () => {
  const root = await freshRoot();
  await savePlanArtifact(root, PLAN, "lightning");
  const path = join(root, PLAN_DIR, PLAN_FILE);
  const text = await fs.readFile(path, "utf8");
  await fs.writeFile(path, text.replace("Run the suite", "Run the suite twice"), "utf8");
  const edited = await loadPlanArtifact(root);
  assert.ok(edited && edited.plan.includes("twice"), "user edits are honored — their file");
  await fs.writeFile(path, text.split("# Approved plan")[0] + "# Approved plan\n\n\n", "utf8");
  assert.equal(await loadPlanArtifact(root), null, "an empty plan binds nobody");
});

test("the rendered block carries the plan and the divergence contract", () => {
  const block = renderPlanBlock({ plan: PLAN, approvedAt: "2026-08-10T12:00:00Z", mode: "lightning" });
  assert.ok(block.includes("<approved_plan>"), "plan is fenced for the model");
  assert.ok(block.includes(PLAN), "the plan text itself is present, verbatim");
  assert.ok(/STOP/.test(block), "the stop instruction is explicit");
  assert.ok(/improvise/i.test(block), "improvising past the plan is named as the failure");
});

test("injection: execution turns carry the plan; planning turns never do", () => {
  const block = renderPlanBlock({ plan: PLAN, approvedAt: "2026-08-10T12:00:00Z", mode: "lightning" });
  const executing = volatileContext("- Use pnpm", false, block);
  assert.ok(executing.includes("<approved_plan>"), "present while executing");
  assert.ok(
    executing.indexOf("<rules>") < executing.indexOf("<approved_plan>"),
    "rules stay first in the tail; the plan follows them",
  );
  const planning = volatileContext("- Use pnpm", true, block);
  assert.ok(!planning.includes("<approved_plan>"), "absent while planning — no anchoring");
  const none = volatileContext("", false, "");
  assert.ok(!none.includes("<approved_plan>"), "absent when there is no plan");
});

test("the divergence interrupt names the failing step and orders a stop, not a workaround", () => {
  const text = planDivergenceStop("`npm run build`");
  assert.ok(text.includes("`npm run build`"));
  assert.ok(/approved/i.test(text), "the interrupt cites the approval");
  assert.ok(/do not improvise|not.*improvise/i.test(text));
  // It must NOT promise a return to planning: approving ends the planning session, so
  // a stop hands the decision to the user rather than resuming a mode by itself.
  assert.ok(/replan|decide/i.test(text), "the interrupt does not say who decides what happens next");
  assert.ok(!/back in planning mode/i.test(text), "the interrupt promises a mode change that no longer happens");
});

test("exit_plan approval writes the artifact and arms the session", async () => {
  const root = await freshRoot();
  const ctx = {
    cwd: root,
    roots: [root],
    planMode: true,
    requestApproval: async () => "Approve — Lightning (auto-accept)",
    onModeChange: () => {},
  } as unknown as ToolContext;

  const result = await exitPlan.execute({ plan: PLAN }, ctx);
  assert.ok(!result.isError, `approval must not error: ${result.output}`);
  assert.equal(ctx.activePlan, PLAN, "the session now carries the agreed plan");
  const onDisk = await loadPlanArtifact(root);
  assert.ok(onDisk && onDisk.plan === PLAN, "the artifact is on disk the moment approval lands");
});

test("exit_plan rejection writes nothing", async () => {
  const root = await freshRoot();
  const ctx = {
    cwd: root,
    roots: [root],
    planMode: true,
    requestApproval: async () => "Reject",
    onModeChange: () => {},
  } as unknown as ToolContext;
  await exitPlan.execute({ plan: PLAN }, ctx);
  assert.equal(ctx.activePlan, undefined, "no approval, no plan in force");
  assert.equal(await loadPlanArtifact(root), null, "no approval, no artifact");
});
