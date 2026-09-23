/**
 * client.test.ts — the shared OpenAI-compatible wire layer, and Qwen's binding to it.
 *
 * Two things are under test and they are worth naming separately:
 *
 *   - The SHARED layer, which every OpenAI-compatible provider will now run
 *     through. Its stream plumbing is where a bug would be invisible and
 *     expensive: fragmented tool arguments, frames split across packets, a
 *     non-standard finish_reason falling through to "end".
 *   - Qwen's own facts, of which the load-bearing one is that `enable_thinking`
 *     must be sent even when it is FALSE, because this family thinks by default.
 *
 * No network, no API key: the stream is driven from hand-built SSE bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody, consumeStream, renderMessages, toStop, toTurn, toUsage } from "../openaiCompat/wire.js";
import { cacheSplit, extraStop, qwenProvider, reasoningFields, thinkingBudget } from "./client.js";
import { FLASH, FLASH_38, MAX_37, MAX_38, MODELS, PLUS, normalize, price, thinkLevels } from "./manifest.js";
import type { Effort, ModelRequest, StreamEvent } from "../types.js";

const base: ModelRequest = { system: "SYSTEM", messages: [] };
const ALL = MODELS.map((m) => m.id);
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A response body streaming the given SSE frames. */
function sse(frames: string[]): Pick<Response, "body"> {
  const encoder = new TextEncoder();
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const f of frames) yield encoder.encode(f);
      },
    },
  } as unknown as Pick<Response, "body">;
}

/** Consume SSE frames, returning the finished turn and the events emitted. */
async function drain(frames: string[]) {
  const events: StreamEvent[] = [];
  const result = await consumeStream(qwenProvider, sse(frames), (e) => events.push(e));
  return { result, events };
}

/** One SSE frame carrying a JSON chunk. */
function frame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── Qwen's own facts ──────────────────────────────────────────────────────────

test("thinking OFF is sent EXPLICITLY — this family thinks by default", () => {
  // The whole point. Omitting the field does not mean "no thinking" here; it means
  // full reasoning at the higher billing rate, on every internal call that never
  // sets a model config. Absence is the bug this test exists to catch.
  assert.deepEqual(reasoningFields(undefined), { enable_thinking: false });
  assert.deepEqual(reasoningFields({ model: PLUS, thinking: false, effort: "high" }), {
    enable_thinking: false,
  });
});

test("thinking ON sends a token budget, not an effort rung", () => {
  assert.deepEqual(reasoningFields({ model: PLUS, thinking: true, effort: "max" }), {
    enable_thinking: true,
    thinking_budget: 32_768,
  });
});

test("every advertised rung maps to a budget inside the provider's cap", () => {
  for (const model of ALL) {
    for (const level of thinkLevels(model)) {
      if (!level.thinking) continue;
      const budget = thinkingBudget(level.effort);
      assert.ok(budget >= 1 && budget <= 32_768, `${level.label}: ${budget} is outside 1..32768`);
    }
  }
  // An unknown rung falls back rather than sending undefined.
  assert.equal(thinkingBudget("not-a-rung"), thinkingBudget("high"));
  assert.equal(thinkingBudget(undefined), thinkingBudget("high"));
});

test("a capacity failure is not reported as a clean finish", () => {
  assert.equal(extraStop("insufficient_system_resource"), "overloaded");
  assert.equal(extraStop("stop"), undefined);
  // And it survives the shared mapper rather than falling through to "end".
  assert.equal(toStop(qwenProvider, "insufficient_system_resource"), "overloaded");
});

test("the cache split reads the details object, and reports nothing when absent", () => {
  assert.deepEqual(cacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } }), {
    hit: 800,
    miss: 200,
  });
  assert.equal(cacheSplit({ prompt_tokens: 1000 }), undefined);
  assert.equal(cacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } }), undefined);
});

test("an unreported cache counts the whole prompt as fresh, never as free", () => {
  // Inventing a discount the user did not receive is the worse error, so the
  // fallback over-estimates rather than under-reports.
  const usage = toUsage(qwenProvider, { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 });
  assert.deepEqual(usage, {
    promptTokens: 500,
    completionTokens: 20,
    totalTokens: 520,
    cacheHitTokens: 0,
    cacheMissTokens: 500,
  });
});

// ── The shared request shape ──────────────────────────────────────────────────

test("the system prompt leads and the volatile context trails everything stable", () => {
  const messages = renderMessages({ ...base, messages: [{ role: "user", content: "hi" }], context: "MAP" });
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[messages.length - 1]!.role, "user");
  assert.ok(messages[messages.length - 1]!.content.includes("MAP"));
});

test("the cacheable prefix is byte-identical when only the volatile context changes", () => {
  const of = (context: string) =>
    JSON.stringify(renderMessages({ ...base, messages: [{ role: "user", content: "hi" }], context }).slice(0, -1));
  assert.equal(of("MAP ONE"), of("A COMPLETELY DIFFERENT MAP"));
});

test("no context means no trailing block at all", () => {
  const messages = renderMessages({ ...base, messages: [{ role: "user", content: "hi" }] });
  assert.equal(messages.length, 2);
  assert.ok(!JSON.stringify(messages).includes("current_context"));
});

test("tools pass through in the stored shape, with tool_choice auto", () => {
  const body = buildBody(qwenProvider, {
    ...base,
    tools: [{ type: "function", function: { name: "read_file", description: "d", parameters: {} } }],
  });
  assert.equal((body.tools as unknown[]).length, 1);
  assert.equal(body.tool_choice, "auto");
});

test("no tools means no tool_choice (a plain-text answer is forced)", () => {
  const body = buildBody(qwenProvider, base);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test("the reasoning fields reach the body", () => {
  const body = buildBody(qwenProvider, { ...base, model: { model: PLUS, thinking: true, effort: "high" } });
  assert.equal(body.enable_thinking, true);
  assert.equal(body.thinking_budget, 16_000);
});

// ── The shared stream plumbing ────────────────────────────────────────────────

test("streaming maps text, reasoning, and tool-call deltas onto the shared events", async () => {
  const { result, events } = await drain([
    frame({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    frame({ choices: [{ delta: { content: "Hello" } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file" } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"p":1}' } }] } }] }),
    frame({ choices: [{ finish_reason: "tool_calls", delta: {} }] }),
    "data: [DONE]\n\n",
  ]);

  assert.deepEqual(events, [
    { type: "reasoning", delta: "thinking" },
    { type: "text", delta: "Hello" },
    { type: "tool_start", index: 0, id: "c1", name: "read_file" },
    { type: "tool_args", index: 0, delta: '{"p":1}' },
  ]);
  assert.equal(result.content, "Hello");
  assert.deepEqual(result.toolCalls, [{ id: "c1", name: "read_file", arguments: '{"p":1}' }]);
  assert.equal(result.stop, "end");
});

test("reasoning is read from either channel name", async () => {
  // Some compatible providers spell it `reasoning`, not `reasoning_content`.
  const { events } = await drain([frame({ choices: [{ delta: { reasoning: "alt channel" } }] })]);
  assert.deepEqual(events, [{ type: "reasoning", delta: "alt channel" }]);
});

test("tool arguments split across many chunks reassemble in order", async () => {
  const { result } = await drain([
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "edit" } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] } }] }),
  ]);
  assert.equal(result.toolCalls[0]!.arguments, '{"path":"a.ts"}');
});

test("PARALLEL tool calls stay separate and come back in index order", async () => {
  const { result } = await drain([
    // Deliberately announced out of order — the map is keyed by index, not arrival.
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "two", arguments: "{}" } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "one", arguments: "{}" } }] } }] }),
  ]);
  assert.deepEqual(
    result.toolCalls.map((t) => t.name),
    ["one", "two"],
  );
});

test("a tool call that never carries arguments still parses as an empty object", async () => {
  const { result } = await drain([
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "list" } }] } }] }),
  ]);
  assert.equal(result.toolCalls[0]!.arguments, "{}");
});

test("an SSE frame split across packets is never parsed half-formed", async () => {
  // The realistic network case: JSON arriving in pieces that are individually
  // invalid. Parsing eagerly would drop the chunk and lose the text silently.
  const whole = frame({ choices: [{ delta: { content: "split" } }] });
  const { result } = await drain([whole.slice(0, 20), whole.slice(20)]);
  assert.equal(result.content, "split");
});

test("CRLF frame separators are handled as well as LF", async () => {
  const chunk = JSON.stringify({ choices: [{ delta: { content: "crlf" } }] });
  const { result } = await drain([`data: ${chunk}\r\n\r\n`]);
  assert.equal(result.content, "crlf");
});

test("keep-alive comments and malformed lines are skipped, not fatal", async () => {
  const { result } = await drain([
    ": keep-alive\n\n",
    "data: {not json\n\n",
    frame({ choices: [{ delta: { content: "ok" } }] }),
  ]);
  assert.equal(result.content, "ok");
});

test("a truncated reply is detectable rather than looking like a clean finish", async () => {
  const { result } = await drain([frame({ choices: [{ finish_reason: "length", delta: { content: "half" } }] })]);
  assert.equal(result.stop, "truncated");
});

test("usage from the trailing chunk reaches the result with its cache split", async () => {
  const { result } = await drain([
    frame({ choices: [{ delta: { content: "x" } }] }),
    frame({
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 900 } },
    }),
  ]);
  assert.deepEqual(result.usage, {
    promptTokens: 1000,
    completionTokens: 10,
    totalTokens: 1010,
    cacheHitTokens: 900,
    cacheMissTokens: 100,
  });
});

test("nothing after [DONE] is read", async () => {
  const { result } = await drain(["data: [DONE]\n\n", frame({ choices: [{ delta: { content: "LATE" } }] })]);
  assert.equal(result.content, "");
});

// ── The buffered path ─────────────────────────────────────────────────────────

test("a buffered response converts to the same turn shape as a streamed one", () => {
  const turn = toTurn(qwenProvider, {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "on it",
          tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"p":1}' } }],
        },
      },
    ],
  });
  assert.equal(turn.content, "on it");
  assert.deepEqual(turn.toolCalls, [{ id: "c1", name: "read_file", arguments: '{"p":1}' }]);
  assert.equal(turn.stop, "end");
});

test("a buffered response with null content degrades to an empty string", () => {
  const turn = toTurn(qwenProvider, { choices: [{ message: { content: null }, finish_reason: "stop" }] });
  assert.equal(turn.content, "");
  assert.deepEqual(turn.toolCalls, []);
});

// ── Model rules ───────────────────────────────────────────────────────────────

test("normalize keeps every advertised reasoning level intact", () => {
  for (const model of ALL) {
    for (const level of thinkLevels(model)) {
      const config = { model, thinking: level.thinking, effort: level.effort };
      assert.deepEqual(normalize(config), config, `${model}: "${level.label}" was altered`);
    }
  }
});

test("normalize snaps an unlisted effort onto a rung /think actually offers", () => {
  for (const model of ALL) {
    for (const effort of EFFORTS) {
      for (const thinking of [true, false]) {
        const moved = normalize({ model, thinking, effort });
        assert.ok(
          thinkLevels(model).some((l) => l.thinking === moved.thinking && l.effort === moved.effort),
          `${model}: ${thinking}/${effort} landed on ${JSON.stringify(moved)}, which /think does not list`,
        );
      }
    }
  }
});

test("an unknown model id falls back rather than reaching the wire", () => {
  assert.equal(normalize({ model: "qwen-imaginary", thinking: true, effort: "high" }).model, PLUS);
  for (const model of [PLUS, MAX_38, MAX_37, FLASH_38, FLASH]) {
    assert.equal(normalize({ model, thinking: true, effort: "high" }).model, model, `${model} was coerced away`);
  }
});

test("prices match Alibaba's International table, not the older, lower figures", () => {
  // 3.7 Max was carried at exactly half its price and 3.5 Flash at about two thirds,
  // so every session on either reported well under what it cost.
  const row = (m: string) => ({ ...price(m) });
  assert.deepEqual(row(MAX_37), { cacheHit: 0.5, cacheMiss: 2.5, output: 7.5 });
  assert.deepEqual(row(FLASH), { cacheHit: 0.02, cacheMiss: 0.1, output: 0.4 });
  assert.deepEqual(row(FLASH_38), { cacheHit: 0.016, cacheMiss: 0.15, output: 0.47 });
  // The older Max is no longer the cheaper one, which its description must not hide.
  assert.ok(price(MAX_37).cacheMiss > price(MAX_38).cacheMiss);
});
