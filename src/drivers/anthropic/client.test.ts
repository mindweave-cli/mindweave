/**
 * client.test.ts — the Anthropic format translation.
 *
 * This driver's whole job is converting between the stored transcript and a wire
 * format that disagrees with it in several places, so these tests drive that
 * conversion directly with hand-built transcripts. No network, no API key.
 *
 * The case that matters most is parallel tool results: the transcript records them
 * as consecutive `role: "tool"` entries, and Anthropic requires them in a SINGLE
 * user message. Getting that wrong doesn't error — it quietly teaches the model to
 * stop making parallel tool calls — so it is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  PROGRESS_UPDATES_BETA,
  buildBody,
  emit,
  progressRequestOptions,
  renderMessages,
  replyStream,
  thinkingBudget,
  toStop,
  toTurn,
  toUsage,
} from "./client.js";
import { FABLE, FABLE_51, HAIKU, MODELS, OPUS, OPUS_48, OPUS_55, SONNET, normalize, price, thinkLevels } from "./manifest.js";
import type { Effort, ModelRequest, StreamEvent } from "../types.js";

const base: ModelRequest = { system: "SYSTEM", messages: [] };

/** Every model this provider advertises. */
const ALL = MODELS.map((m) => m.id);
/** The models on the current request surface — adaptive thinking plus `effort`. */
const CURRENT_SURFACE = [SONNET, OPUS, OPUS_48];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A body for one model at one reasoning setting. */
function bodyFor(model: string, thinking: boolean, effort: Effort, maxTokens = 1000) {
  return buildBody(
    { ...base, messages: [{ role: "user", content: "x" }], model: { model, thinking, effort } },
    maxTokens,
  );
}

/** Content blocks of a message, as an array (they always are here). */
function blocks(msg: Anthropic.MessageParam): Anthropic.ContentBlockParam[] {
  assert.ok(Array.isArray(msg.content), "expected block array content");
  return msg.content;
}

// ── Message conversion ────────────────────────────────────────────────────────

test("the system prompt goes top-level, never into the conversation", () => {
  const body = buildBody({ ...base, messages: [{ role: "user", content: "hi" }] }, 1000);
  assert.ok(Array.isArray(body.system));
  assert.equal((body.system as Anthropic.TextBlockParam[])[0]!.text, "SYSTEM");
  assert.ok(
    body.messages.every((m) => m.role !== ("system" as unknown)),
    "no message may carry the system role",
  );
});

test("a stray in-conversation system message is folded into the system prompt, not dropped", () => {
  const body = buildBody(
    {
      ...base,
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "EXTRA RULE" },
      ],
    },
    1000,
  );
  const system = (body.system as Anthropic.TextBlockParam[])[0]!.text;
  assert.match(system, /SYSTEM/);
  assert.match(system, /EXTRA RULE/);
});

test("PARALLEL tool results collapse into ONE user message", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "do both" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", type: "function", function: { name: "read", arguments: '{"p":"x"}' } },
          { id: "b", type: "function", function: { name: "read", arguments: '{"p":"y"}' } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "AAA" },
      { role: "tool", tool_call_id: "b", content: "BBB" },
    ],
  });

  // user → assistant → ONE user carrying both results.
  assert.equal(messages.length, 3);
  assert.equal(messages[2]!.role, "user");
  const results = blocks(messages[2]!);
  assert.equal(results.length, 2, "both tool results belong in the same user message");
  assert.deepEqual(
    results.map((b) => (b as Anthropic.ToolResultBlockParam).tool_use_id),
    ["a", "b"],
  );
});

test("separate tool rounds stay in separate user messages", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "AAA" },
      { role: "assistant", content: "", tool_calls: [{ id: "b", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "b", content: "BBB" },
    ],
  });
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
});

test("assistant tool calls become tool_use blocks with PARSED object input", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [{ id: "t1", type: "function", function: { name: "edit", arguments: '{"path":"a.ts","n":3}' } }],
      },
    ],
  });
  const parts = blocks(messages[1]!);
  assert.equal(parts[0]!.type, "text");
  const call = parts[1] as Anthropic.ToolUseBlockParam;
  assert.equal(call.type, "tool_use");
  assert.equal(call.id, "t1");
  assert.equal(call.name, "edit");
  // An object, not the JSON string the transcript stores.
  assert.deepEqual(call.input, { path: "a.ts", n: 3 });
});

test("malformed tool arguments degrade to {} rather than failing the turn", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "x", arguments: "{not json" } }] },
    ],
  });
  assert.deepEqual((blocks(messages[1]!)[0] as Anthropic.ToolUseBlockParam).input, {});
});

test("empty assistant prose produces no empty text block", () => {
  const { messages } = renderMessages({
    ...base,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "   ", tool_calls: [{ id: "t", type: "function", function: { name: "x", arguments: "{}" } }] },
    ],
  });
  const parts = blocks(messages[1]!);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.type, "tool_use");
});

test("an empty conversation still produces a valid request", () => {
  const body = buildBody(base, 1000);
  assert.ok(body.messages.length > 0, "Anthropic rejects an empty messages array");
  assert.equal(body.messages[0]!.role, "user");
});

// ── Caching ───────────────────────────────────────────────────────────────────

test("volatile context is appended AFTER the cache breakpoint, never inside it", () => {
  const withCtx = buildBody({ ...base, messages: [{ role: "user", content: "hi" }], context: "MAP v1" }, 1000);
  const last = withCtx.messages[withCtx.messages.length - 1]!;
  const lastBlock = blocks(last)[0] as Anthropic.TextBlockParam;
  assert.match(lastBlock.text, /MAP v1/);
  assert.equal(lastBlock.cache_control, undefined, "the volatile tail must not be a breakpoint");
});

test("the cacheable prefix is byte-identical when only the volatile context changes", () => {
  const msgs = [{ role: "user" as const, content: "build the cart" }];
  const a = buildBody({ ...base, messages: msgs, context: "MAP v1" }, 1000);
  const b = buildBody({ ...base, messages: msgs, context: "MAP v2" }, 1000);
  assert.deepEqual(a.system, b.system);
  assert.deepEqual(a.messages.slice(0, -1), b.messages.slice(0, -1));
});

test("breakpoints mark the system prompt and the last stable message, and stay under the limit of 4", () => {
  const body = buildBody(
    {
      ...base,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ],
      context: "volatile",
    },
    1000,
  );
  const system = body.system as Anthropic.TextBlockParam[];
  assert.deepEqual(system[system.length - 1]!.cache_control, { type: "ephemeral" });

  // The last STABLE message (the assistant turn), not the appended context.
  const stable = blocks(body.messages[body.messages.length - 2]!);
  assert.deepEqual(
    (stable[stable.length - 1] as Anthropic.TextBlockParam).cache_control,
    { type: "ephemeral" },
  );

  const count = JSON.stringify(body).split('"cache_control"').length - 1;
  assert.ok(count <= 4, `Anthropic allows at most 4 breakpoints, found ${count}`);
});

// ── Request options ───────────────────────────────────────────────────────────

test("tools convert from the stored OpenAI shape to input_schema", () => {
  const body = buildBody(
    {
      ...base,
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } } }],
    },
    1000,
  );
  assert.equal(body.tools?.length, 1);
  const tool = body.tools![0] as Anthropic.Tool;
  assert.equal(tool.name, "read");
  assert.equal(tool.description, "Read a file");
  assert.deepEqual(tool.input_schema, { type: "object", properties: {} });
  assert.deepEqual(body.tool_choice, { type: "auto" });
});

test("no tools means no tool_choice (a plain-text answer is forced)", () => {
  const body = buildBody({ ...base, messages: [{ role: "user", content: "go" }] }, 1000);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test("on the current surface, reasoning is adaptive thinking plus an effort level", () => {
  for (const model of CURRENT_SURFACE) {
    const on = bodyFor(model, true, "max");
    assert.deepEqual(on.thinking, { type: "adaptive" }, model);
    assert.deepEqual(on.output_config, { effort: "max" }, model);

    const off = bodyFor(model, false, "high");
    assert.deepEqual(off.thinking, { type: "disabled" }, model);
  }
});

test("the always-thinking models (both Fables, Opus 5.5) are only ever sent adaptive + progress updates", () => {
  // `disabled` and a token budget are both 400s on these models, whatever the saved
  // config says. The one value sent is `adaptive` asking for the progress updates'
  // text, which is otherwise empty and leaves the reply silent between tool calls.
  for (const model of [FABLE_51, FABLE, OPUS_55]) {
    for (const thinking of [true, false]) {
      const body = bodyFor(model, thinking, "xhigh");
      assert.deepEqual(body.thinking, { type: "adaptive", display: "updates" }, `${model}, thinking=${thinking}`);
      // Effort still applies — Fable takes the full ladder.
      assert.deepEqual(body.output_config, { effort: "xhigh" });
    }
  }
});

test("Fable 5.1 reads back from cache at a quarter of Fable 5's rate", () => {
  // The one number that changed between them: same input, same output, a cache read
  // at 2.5% of base input where every other model on this surface reads back at 10%.
  // An agentic loop re-sends its prefix on every step, so this is most of the bill.
  assert.equal(price(FABLE_51).cacheMiss, price(FABLE).cacheMiss);
  assert.equal(price(FABLE_51).output, price(FABLE).output);
  assert.equal(price(FABLE_51).cacheHit, 0.25);
  assert.equal(price(FABLE_51).cacheHit, price(FABLE).cacheHit / 4);
});

test("the progress-updates beta header rides along exactly when the body asks for updates", () => {
  for (const model of [FABLE_51, FABLE, OPUS_55]) {
    const opts = progressRequestOptions(bodyFor(model, true, "high"));
    assert.deepEqual(opts.headers, { "anthropic-beta": PROGRESS_UPDATES_BETA }, model);
  }
  // Every other model: no `display`, no beta header — nothing about them changes.
  for (const model of [...CURRENT_SURFACE, HAIKU]) {
    for (const thinking of [true, false]) {
      const body = bodyFor(model, thinking, "high");
      assert.ok(!(body.thinking && "display" in body.thinking), `${model} must not ask for a display`);
      assert.equal(progressRequestOptions(body).headers, undefined, `${model} must not send the beta`);
    }
  }
});

test("Opus 5.5 is priced below Opus 5, with its cache read at 5% of base input", () => {
  assert.deepEqual(
    { hit: price(OPUS_55).cacheHit, miss: price(OPUS_55).cacheMiss, out: price(OPUS_55).output },
    { hit: 0.2, miss: 4, out: 20 },
  );
  assert.ok(price(OPUS_55).cacheMiss < price(OPUS).cacheMiss);
});

test("Haiku 4.5 gets a token budget and NO effort — it predates both", () => {
  const on = bodyFor(HAIKU, true, "high", 16_000);
  assert.deepEqual(on.thinking, { type: "enabled", budget_tokens: 8000 });
  assert.ok(!("output_config" in on), "output_config is rejected by Haiku 4.5");

  const off = bodyFor(HAIKU, false, "high", 16_000);
  assert.ok(!("thinking" in off), "no thinking means no thinking field");
  assert.ok(!("output_config" in off), "output_config is rejected by Haiku 4.5");
});

test("the thinking budget stays inside the API's two limits at every ceiling", () => {
  // It is spent from the same allowance as the answer, so an equal budget leaves
  // nothing to answer with; and the floor is 1024.
  for (const ceiling of [1025, 2048, 16_000, 64_000]) {
    const budget = thinkingBudget(ceiling);
    assert.ok(budget >= 1024, `${ceiling}: budget ${budget} is below the floor`);
    assert.ok(budget < ceiling, `${ceiling}: budget ${budget} leaves no room to answer`);
  }
  // Below 1025 the floor and the ceiling contradict each other. There is no legal
  // number, so the answer is "none" and the caller omits the field.
  for (const ceiling of [512, 1024]) {
    assert.equal(thinkingBudget(ceiling), 0, `${ceiling} has no legal budget`);
  }
  const cramped = bodyFor(HAIKU, true, "high", 1024);
  assert.ok(!("thinking" in cramped), "no legal budget means no thinking field");
});

test("sampling parameters are never sent to any model in this lineup", () => {
  const serialized = ALL.flatMap((m) => [bodyFor(m, true, "high"), bodyFor(m, false, "high")])
    .map((b) => JSON.stringify(b))
    .join("");
  for (const param of ["temperature", "top_p", "top_k"]) {
    assert.ok(!serialized.includes(`"${param}"`), `${param} is rejected by these models`);
  }
});

test("a token budget never reaches a model on the current surface", () => {
  for (const model of [...CURRENT_SURFACE, FABLE]) {
    const serialized = JSON.stringify(bodyFor(model, true, "high")) + JSON.stringify(bodyFor(model, false, "high"));
    assert.ok(!serialized.includes("budget_tokens"), `${model}: budget_tokens is rejected here`);
  }
});

// ── Model rules ───────────────────────────────────────────────────────────────

test("normalize never pairs disabled thinking with an effort Opus 5 rejects", () => {
  for (const effort of EFFORTS) {
    const config = normalize({ model: OPUS, thinking: false, effort });
    assert.ok(
      config.effort !== "xhigh" && config.effort !== "max",
      `no-thinking at ${effort} must step down, got ${config.effort}`,
    );
  }
});

test("normalize forces thinking ON for both Fables and Opus 5.5 — none can be asked to skip it", () => {
  for (const model of [FABLE_51, FABLE, OPUS_55]) {
    for (const effort of EFFORTS) {
      assert.equal(normalize({ model, thinking: false, effort }).thinking, true, `${model}/${effort}`);
    }
  }
});

test("normalize pins Haiku 4.5's effort, so no rung it rejects is ever stored", () => {
  for (const effort of EFFORTS) {
    for (const thinking of [true, false]) {
      assert.equal(normalize({ model: HAIKU, thinking, effort }).effort, "high", `${effort}/${thinking}`);
    }
  }
});

test("normalize keeps every advertised reasoning level intact", () => {
  for (const model of ALL) {
    for (const level of thinkLevels(model)) {
      const config = { model, thinking: level.thinking, effort: level.effort };
      assert.deepEqual(normalize(config), config, `${model}: "${level.label}" was altered`);
    }
  }
});

test("switching between any two models leaves a config the target accepts", () => {
  // `/model` carries the reasoning intent across, so every level of every model has
  // to survive landing on every other model — this is the pairing that would 400.
  for (const from of ALL) {
    for (const level of thinkLevels(from)) {
      for (const to of ALL) {
        const moved = normalize({ model: to, thinking: level.thinking, effort: level.effort });
        assert.deepEqual(normalize(moved), moved, `${from} "${level.label}" → ${to} is unstable`);
        assert.ok(
          thinkLevels(to).some((l) => l.thinking === moved.thinking && l.effort === moved.effort),
          `${from} "${level.label}" → ${to} landed on ${JSON.stringify(moved)}, which ${to} does not offer`,
        );
      }
    }
  }
});

test("every advertised model has a price and a normalize that keeps it", () => {
  for (const model of ALL) {
    assert.equal(normalize({ model, thinking: true, effort: "high" }).model, model, `${model} was coerced away`);
  }
  // An id no provider serves falls back rather than reaching the wire.
  assert.equal(normalize({ model: "claude-not-a-model", thinking: true, effort: "high" }).model, SONNET);
});

// ── Response conversion ───────────────────────────────────────────────────────

test("toTurn joins text, converts tool_use back to a JSON string, and drops thinking", () => {
  const message = {
    content: [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "Here " },
      { type: "text", text: "you go." },
      { type: "tool_use", id: "t1", name: "edit", input: { path: "a.ts" } },
    ],
  } as unknown as Anthropic.Message;

  const turn = toTurn(message);
  assert.equal(turn.content, "Here you go.");
  assert.ok(!turn.content.includes("internal reasoning"), "thinking must never reach the transcript");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0]!.name, "edit");
  assert.equal(turn.toolCalls[0]!.arguments, '{"path":"a.ts"}');
  assert.deepEqual(JSON.parse(turn.toolCalls[0]!.arguments), { path: "a.ts" });
});

test("usage counts the FULL prompt, not just the uncached remainder", () => {
  // Anthropic's input_tokens excludes both cache figures; summing is the only way
  // to get real context occupancy.
  const usage = toUsage({
    input_tokens: 100,
    output_tokens: 40,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 700,
  } as Anthropic.Usage)!;

  assert.equal(usage.promptTokens, 1000);
  assert.equal(usage.completionTokens, 40);
  assert.equal(usage.totalTokens, 1040);
  assert.equal(usage.cacheHitTokens, 700);
  // Cache writes are billed as fresh input, so they count on the miss side.
  assert.equal(usage.cacheMissTokens, 300);
  assert.equal(usage.cacheHitTokens + usage.cacheMissTokens, usage.promptTokens);
});

test("usage tolerates a response that reports no cache figures", () => {
  const usage = toUsage({ input_tokens: 50, output_tokens: 10 } as Anthropic.Usage)!;
  assert.equal(usage.promptTokens, 50);
  assert.equal(usage.cacheHitTokens, 0);
  assert.equal(usage.cacheMissTokens, 50);
  assert.equal(toUsage(undefined), undefined);
});

// ── Streaming ─────────────────────────────────────────────────────────────────

/** Collect the events `emit` produces for a sequence of raw stream events. */
function collect(raw: unknown[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const event of raw) emit(event as Anthropic.MessageStreamEvent, (e) => out.push(e));
  return out;
}

test("streaming maps text, thinking, and tool-call deltas onto the shared events", () => {
  const events = collect([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "edit", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"p"' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ':"a"}' } },
    { type: "message_stop" },
  ]);

  assert.deepEqual(events, [
    { type: "reasoning", delta: "hmm" },
    { type: "text", delta: "Hello" },
    { type: "tool_start", index: 2, id: "t1", name: "edit" },
    { type: "tool_args", index: 2, delta: '{"p"' },
    { type: "tool_args", index: 2, delta: ':"a"}' },
  ]);
});

// ── Progress updates (Fable 5, Fable 5.1, Opus 5.5) ──────────────────────────

/** One response from a progress-update model: empty reasoning, a note, a tool call,
 *  another empty reasoning block, a second note, another tool call, then the answer. */
const PROGRESS_BLOCKS = [
  { type: "thinking", thinking: "", signature: "s0" },
  { type: "thinking", thinking: "Found the parser. Checking its callers next.", signature: "s1" },
  { type: "tool_use", id: "t1", name: "search", input: { q: "parse(" } },
  { type: "thinking", thinking: "", signature: "s2" },
  { type: "thinking", thinking: "Two callers; reading the second.", signature: "s3" },
  { type: "tool_use", id: "t2", name: "read_file", input: { path: "b.ts" } },
  { type: "text", text: "Both callers are covered." },
];

/** The same response as the stream of events that delivers it. */
function progressStream(): unknown[] {
  const out: unknown[] = [];
  PROGRESS_BLOCKS.forEach((b, index) => {
    out.push({ type: "content_block_start", index, content_block: { ...b, ...(b.type === "text" ? { text: "" } : {}), ...(b.type === "thinking" ? { thinking: "" } : {}) } });
    if (b.type === "thinking") {
      // Under `display: "updates"` a reasoning block streams one empty delta; a note streams its text.
      const text = b.thinking as string;
      const mid = Math.floor(text.length / 2);
      for (const part of text ? [text.slice(0, mid), text.slice(mid)] : [""]) {
        out.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } });
      }
    } else if (b.type === "text") {
      out.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    }
  });
  return out;
}

const EXPECTED_REPLY =
  "Found the parser. Checking its callers next.\n\nTwo callers; reading the second.\n\nBoth callers are covered.";

test("a progress update is reply text, a paragraph of its own, in the stored turn", () => {
  const message = { model: OPUS_55, content: PROGRESS_BLOCKS, stop_reason: "tool_use" } as unknown as Anthropic.Message;
  const turn = toTurn(message);
  assert.equal(turn.content, EXPECTED_REPLY);
  assert.equal(turn.toolCalls.length, 2);
  // A model without progress updates keeps dropping every thinking block, as before.
  const onSonnet = toTurn({ ...message, model: SONNET } as Anthropic.Message);
  assert.equal(onSonnet.content, "Both callers are covered.");
});

test("a progress update streams as text, and the screen matches what is stored", () => {
  const reply = replyStream(true);
  const events: StreamEvent[] = [];
  for (const e of progressStream()) emit(e as Anthropic.MessageStreamEvent, (x) => events.push(x), reply);
  const shown = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  assert.equal(shown, EXPECTED_REPLY);
  assert.equal(reply.text, EXPECTED_REPLY, "the salvage copy must match the screen too");
  assert.ok(!events.some((e) => e.type === "reasoning"), "under updates nothing is reasoning");
  const stored = toTurn({ model: OPUS_55, content: PROGRESS_BLOCKS, stop_reason: "end_turn" } as unknown as Anthropic.Message);
  assert.equal(shown, stored.content);
});

test("without progress updates, thinking deltas stay reasoning and never reach the reply", () => {
  const reply = replyStream(false);
  const events: StreamEvent[] = [];
  for (const e of progressStream()) emit(e as Anthropic.MessageStreamEvent, (x) => events.push(x), reply);
  const shown = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  assert.equal(shown, "Both callers are covered.");
  assert.ok(events.some((e) => e.type === "reasoning"));
});


test("streaming ignores events it has no shared equivalent for", () => {
  assert.deepEqual(
    collect([
      { type: "message_start", message: {} },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ]),
    [],
  );
});

// ── Stop reasons ──────────────────────────────────────────────────────────────

test("stop reasons map onto the shared set, so a truncated reply is detectable", () => {
  assert.equal(toStop("end_turn"), "end");
  assert.equal(toStop("tool_use"), "end");
  assert.equal(toStop("max_tokens"), "truncated");
  assert.equal(toStop("refusal"), "refused");
  assert.equal(toStop("model_context_window_exceeded"), "overflow");
  // An unfamiliar or absent reason must not be reported as a failure.
  assert.equal(toStop(null), "end");
  assert.equal(toStop("something_new" as never), "end");
});

test("toTurn carries the stop reason through", () => {
  const truncated = { content: [{ type: "text", text: "half an ans" }], stop_reason: "max_tokens" } as unknown as Anthropic.Message;
  assert.equal(toTurn(truncated).stop, "truncated");
  const normal = { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } as unknown as Anthropic.Message;
  assert.equal(toTurn(normal).stop, "end");
});

test("images render as base64 blocks, before the text, each one labelled", () => {
  const { messages } = renderMessages({
    system: "S",
    messages: [
      {
        role: "user",
        content: "what is broken here?",
        images: [{ path: "/proj/shot.png", mediaType: "image/png", data: "QUJD" }],
      },
    ],
  });

  assert.equal(messages.length, 1);
  const blocks = messages[0]!.content as Anthropic.ContentBlockParam[];
  // Image before text: the documented ordering for reliable reading.
  assert.equal(blocks[0]!.type, "text");
  assert.match((blocks[0] as { text: string }).text, /shot\.png/, "labelled so later turns can refer to it");
  assert.equal(blocks[1]!.type, "image");
  assert.deepEqual((blocks[1] as { source: unknown }).source, {
    type: "base64",
    media_type: "image/png",
    data: "QUJD",
  });
  assert.equal(blocks[2]!.type, "text");
  assert.equal((blocks[2] as { text: string }).text, "what is broken here?");
});

test("a user message with images but no text still reaches the model", () => {
  // Dropping it would silently swallow a dragged-in screenshot sent with no caption.
  const { messages } = renderMessages({
    system: "S",
    messages: [
      { role: "user", content: "", images: [{ path: "/p/a.png", mediaType: "image/png", data: "QQ==" }] },
    ],
  });
  assert.equal(messages.length, 1);
  assert.equal((messages[0]!.content as Anthropic.ContentBlockParam[]).length, 2);
});
