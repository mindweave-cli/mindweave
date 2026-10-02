/** auxModel.test.ts — background calls on a model that will not switch reasoning off,
 *  or will not serve a request with no tools attached. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auxConfig, isAgenticOnlyRefusal, isReasoningRequired, withAuxModel } from "./auxModel.js";
import type { ModelConfig } from "../drivers/types.js";

test("the provider's own refusal is recognised, and ordinary errors are not", () => {
  assert.equal(isReasoningRequired(new Error("Reasoning is mandatory for this endpoint and cannot be disabled.")), true);
  assert.equal(isReasoningRequired({ message: "400", body: { error: { message: "thinking cannot be disabled for this model" } } }), true);
  assert.equal(isReasoningRequired(new Error("Rate limit exceeded")), false);
  assert.equal(isReasoningRequired(new Error("reasoning tokens used: 12")), false);
});

test("reasoning off first; on refusal, once more with it on at low effort, then remembered", async () => {
  const config: ModelConfig = { model: "test:needs-reasoning", thinking: true, effort: "high" };
  const seen: ModelConfig[] = [];
  const call = async (m: ModelConfig) => {
    seen.push(m);
    if (!m.thinking) throw new Error("Reasoning is mandatory for this endpoint and cannot be disabled.");
    return "summary";
  };
  assert.equal(await withAuxModel(config, call), "summary");
  assert.deepEqual(seen.map((m) => [m.thinking, m.effort]), [[false, "high"], [true, "low"]]);
  // Next time it goes straight to what works: no doomed first attempt.
  seen.length = 0;
  assert.equal(await withAuxModel(config, call), "summary");
  assert.deepEqual(seen.map((m) => m.thinking), [true]);
  assert.equal(auxConfig(config).thinking, true);
});

test("any other failure is not retried", async () => {
  const config: ModelConfig = { model: "test:plain", thinking: false, effort: "low" };
  let calls = 0;
  await assert.rejects(withAuxModel(config, async () => { calls++; throw new Error("upstream timeout"); }), /upstream timeout/);
  assert.equal(calls, 1);
  assert.equal(auxConfig(config).thinking, false);
});

test("an 'agentic harness only' refusal is recognised, and ordinary errors are not", () => {
  assert.equal(
    isAgenticOnlyRefusal(new Error("thinkingmachines/inkling-small:free is only available on agentic harnesses. Try plugging it into a coding agent.")),
    true,
  );
  assert.equal(isAgenticOnlyRefusal(new Error("Rate limit exceeded")), false);
});

test("a model that only serves tool-shaped requests gets real tools on retry, then remembered", async () => {
  const config: ModelConfig = { model: "test:agentic-only", thinking: false, effort: "low" };
  const seen: boolean[] = [];
  const call = async (_m: ModelConfig, withTools: boolean) => {
    seen.push(withTools);
    if (!withTools) throw new Error("this-model is only available on agentic harnesses.");
    return "notes";
  };
  assert.equal(await withAuxModel(config, call), "notes");
  assert.deepEqual(seen, [false, true]);
  // Next time it goes straight to what works.
  seen.length = 0;
  assert.equal(await withAuxModel(config, call), "notes");
  assert.deepEqual(seen, [true]);
});

test("a model needing BOTH reasoning on and tools attached gets both, in the order refused", async () => {
  const config: ModelConfig = { model: "test:needs-both", thinking: false, effort: "low" };
  const seen: Array<{ thinking: boolean; withTools: boolean }> = [];
  const call = async (m: ModelConfig, withTools: boolean) => {
    seen.push({ thinking: !!m.thinking, withTools });
    if (!m.thinking) throw new Error("Reasoning is mandatory for this endpoint and cannot be disabled.");
    if (!withTools) throw new Error("this-model is only available on agentic harnesses.");
    return "done";
  };
  assert.equal(await withAuxModel(config, call), "done");
  assert.deepEqual(seen, [
    { thinking: false, withTools: false },
    { thinking: true, withTools: false },
    { thinking: true, withTools: true },
  ]);
});
