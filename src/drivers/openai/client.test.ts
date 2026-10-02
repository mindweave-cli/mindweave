/**
 * client.test.ts — the OpenAI Responses translation.
 *
 * This driver's whole job is converting between the stored transcript and a wire
 * format that disagrees with it in four places, so these tests drive that
 * conversion directly with hand-built transcripts. No network, no API key.
 *
 * Two cases matter more than the rest and are pinned hard:
 *   - A tool result is matched on `call_id`, NOT on the call item's own `id`.
 *     Getting that wrong fails on the FOLLOWING turn, far from the cause.
 *   - Tool schemas are stored in the OpenAI CHAT shape (nested under `function`)
 *     and must be flattened. The nested form is a validation error here, not a
 *     tolerated variant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Responses } from "openai/resources/responses/responses";
import { buildBody, emit, renderInput, toStop, toTurn, toUsage } from "./client.js";
import { ASTRA, LUNA, MODELS, SOL, SOL_61, TERRA, canSkipReasoning, normalize, price, thinkLevels } from "./manifest.js";
import type { Effort, ModelRequest, StreamEvent } from "../types.js";

const base: ModelRequest = { system: "SYSTEM", messages: [] };

/** Every model this provider advertises. */
const ALL = MODELS.map((m) => m.id);
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A built body's input array, as plain records for shape assertions. */
function inputOf(body: Responses.ResponseCreateParamsNonStreaming): Record<string, unknown>[] {
  assert.ok(Array.isArray(body.input), "expected an input array");
  return body.input as unknown as Record<string, unknown>[];
}

// ── Input conversion ──────────────────────────────────────────────────────────

test("the system prompt goes into `instructions`, never into the conversation", () => {
  const body = buildBody({ ...base, messages: [{ role: "user", content: "hi" }] }, 1000);
  assert.equal(body.instructions, "SYSTEM");
  assert.ok(!JSON.stringify(body.input).includes("SYSTEM"), "system text leaked into the input");
});

test("a stray in-conversation system message is folded into instructions, not dropped", () => {
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
  assert.ok(body.instructions?.includes("SYSTEM"), "original system prompt lost");
  assert.ok(body.instructions?.includes("EXTRA RULE"), "in-conversation system message dropped");
});

test("assistant tool calls become function_call ITEMS, not a tool_calls array", () => {
  const { input } = renderInput({
    ...base,
    messages: [
      {
        role: "assistant",
        content: "working",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
          { id: "call_2", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
    ],
  });

  const calls = input.filter((i) => (i as { type?: string }).type === "function_call");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    type: "function_call",
    call_id: "call_1",
    name: "read_file",
    arguments: '{"path":"a.ts"}',
  });
  assert.ok(!JSON.stringify(input).includes("tool_calls"), "the chat-shaped array must not survive");
});

test("a tool result becomes a function_call_output keyed by call_id", () => {
  const { input } = renderInput({
    ...base,
    messages: [{ role: "tool", content: "file contents", tool_call_id: "call_1" }],
  });
  assert.deepEqual(input, [{ type: "function_call_output", call_id: "call_1", output: "file contents" }]);
});

test("PARALLEL tool results stay separate items — this API has no coalescing rule", () => {
  // The Anthropic driver must merge these into one message; here each result is
  // its own item, and merging would be wrong. Pinned so the two never get
  // "harmonised" into the same behaviour by mistake.
  const { input } = renderInput({
    ...base,
    messages: [
      { role: "tool", content: "one", tool_call_id: "call_1" },
      { role: "tool", content: "two", tool_call_id: "call_2" },
    ],
  });
  assert.equal(input.length, 2);
  assert.equal((input[0] as { call_id: string }).call_id, "call_1");
  assert.equal((input[1] as { call_id: string }).call_id, "call_2");
});

test("an empty tool result still carries a body rather than an empty string", () => {
  const { input } = renderInput({ ...base, messages: [{ role: "tool", content: "", tool_call_id: "c" }] });
  assert.equal((input[0] as { output: string }).output, "(no output)");
});

test("empty assistant prose produces no message item", () => {
  const { input } = renderInput({
    ...base,
    messages: [
      {
        role: "assistant",
        content: "   ",
        tool_calls: [{ id: "c", type: "function", function: { name: "n", arguments: "{}" } }],
      },
    ],
  });
  assert.equal(input.length, 1, "only the call item should survive");
  assert.equal((input[0] as { type: string }).type, "function_call");
});

test("an empty conversation still produces a valid request", () => {
  const body = buildBody(base, 1000);
  assert.equal((body.input as unknown[]).length, 1);
});

test("volatile context is appended LAST, after the whole stable conversation", () => {
  const body = buildBody(
    { ...base, messages: [{ role: "user", content: "hi" }], context: "MAP" },
    1000,
  );
  const input = inputOf(body);
  assert.ok(JSON.stringify(input[input.length - 1]).includes("MAP"), "context is not last");
});

test("the cacheable prefix is byte-identical when only the volatile context changes", () => {
  const of = (context: string) => {
    const body = buildBody({ ...base, messages: [{ role: "user", content: "hi" }], context }, 1000);
    const input = body.input as unknown[];
    return JSON.stringify({ instructions: body.instructions, stable: input.slice(0, -1) });
  };
  assert.equal(of("MAP ONE"), of("A COMPLETELY DIFFERENT MAP"));
});

test("images render as data URLs, before the text, each one labelled", () => {
  const { input } = renderInput({
    ...base,
    messages: [
      {
        role: "user",
        content: "what is this",
        images: [{ path: "/tmp/shot.png", mediaType: "image/png", data: "BASE64" }],
      },
    ],
  });
  const content = (input[0] as unknown as { content: Record<string, string>[] }).content;
  assert.equal(content[0]!.type, "input_text");
  assert.ok(content[0]!.text.includes("shot.png"), "the image is not labelled by name");
  assert.equal(content[1]!.type, "input_image");
  assert.equal(content[1]!.image_url, "data:image/png;base64,BASE64");
  assert.equal(content[2]!.text, "what is this");
});

// ── Request shape ─────────────────────────────────────────────────────────────

test("tools flatten out of the stored chat shape — the nested form is invalid here", () => {
  const body = buildBody(
    {
      ...base,
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
        },
      ],
    },
    1000,
  );
  assert.deepEqual(body.tools?.[0], {
    type: "function",
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
    strict: false,
  });
  assert.equal(body.tool_choice, "auto");
});

test("no tools means no tool_choice (a plain-text answer is forced)", () => {
  const body = buildBody({ ...base, messages: [{ role: "user", content: "go" }] }, 1000);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test("reasoning is ONE dial: `none` is the off switch, the rung is sent as itself", () => {
  for (const model of ALL.filter(canSkipReasoning)) {
    assert.deepEqual(buildBody({ ...base, model: { model, thinking: false, effort: "high" } }, 1000).reasoning, {
      effort: "none",
    });
  }
  for (const model of ALL) {
    assert.deepEqual(buildBody({ ...base, model: { model, thinking: true, effort: "max" } }, 1000).reasoning, {
      effort: "max",
    });
  }
});

test("Astra and GPT-6.1 Sol are never sent `none`: OpenAI does not accept it for them", () => {
  // developers.openai.com lists their efforts as low..max and the reasoning guide says
  // `none` is unsupported, so "Standard" used to be a setting that ended in a refused request.
  assert.equal(canSkipReasoning(ASTRA), false);
  assert.equal(canSkipReasoning(SOL_61), false);
  for (const model of [ASTRA, SOL_61]) {
    // Even a stray no-thinking config reaches the wire as the lightest rung, not `none`.
    assert.deepEqual(buildBody({ ...base, model: { model, thinking: false, effort: "high" } }, 1000).reasoning, {
      effort: "low",
    });
    // Its ladder has no "answer directly" rung, and every rung is a thinking one.
    const levels = thinkLevels(model);
    assert.ok(levels.every((l) => l.thinking), `${model} still offers a no-reasoning rung`);
    assert.deepEqual(levels.map((l) => l.effort), ["low", "medium", "high", "max"]);
    // A config carried over from a model that CAN skip reasoning lands on the lightest rung,
    // not on the effort it was carrying (which would quietly spend more).
    assert.deepEqual(normalize({ model, thinking: false, effort: "high" }), { model, thinking: true, effort: "low" });
  }
  // Every other model keeps the off switch.
  for (const model of ALL.filter((m) => m !== ASTRA && m !== SOL_61)) {
    assert.equal(canSkipReasoning(model), true, `${model} lost its off switch`);
    assert.equal(thinkLevels(model)[0]!.thinking, false);
  }
});

test("GPT-6.1 Sol is offered, priced at GPT-6 Sol's rate with half its cache-read price", () => {
  assert.ok(MODELS.some((m) => m.id === "gpt-6.1-sol" && m.label === "GPT-6.1 Sol"));
  assert.deepEqual(price(SOL_61), { cacheHit: 0.1, cacheMiss: 2, output: 10 });
  assert.equal(normalize({ model: SOL_61, thinking: true, effort: "high" }).model, SOL_61, "it was coerced away");
});

test("turns are never stored on the vendor's servers", () => {
  // Mindweave keeps the transcript on the user's disk. `store` defaults to TRUE on
  // this API, so leaving it unset would silently retain every turn server-side.
  assert.equal(buildBody({ ...base, messages: [{ role: "user", content: "x" }] }, 1000).store, false);
});

test("the output ceiling is passed through, so core's reservation matches the request", () => {
  assert.equal(buildBody(base, 4242).max_output_tokens, 4242);
});

// ── Response conversion ───────────────────────────────────────────────────────

/** A finished response with the given output items. */
function response(output: unknown[], extra: Record<string, unknown> = {}): Responses.Response {
  return { status: "completed", incomplete_details: null, output, ...extra } as unknown as Responses.Response;
}

test("toTurn joins text, keeps tool arguments as a JSON string, and drops reasoning", () => {
  const turn = toTurn(
    response([
      { type: "reasoning", summary: [{ type: "summary_text", text: "internal" }] },
      { type: "message", content: [{ type: "output_text", text: "Here you go." }] },
      { type: "function_call", id: "fc_abc", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ]),
  );
  assert.equal(turn.content, "Here you go.");
  assert.deepEqual(turn.toolCalls, [{ id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }]);
  assert.ok(!turn.content.includes("internal"), "reasoning must never reach the transcript");
});

test("a tool call is identified by call_id, NOT by the item's own id", () => {
  // The API matches results on `call_id`. Using `id` produces an unmatched-result
  // error on the NEXT turn, which is a long way from the cause.
  const turn = toTurn(
    response([{ type: "function_call", id: "fc_THE_ITEM_ID", call_id: "call_THE_RIGHT_ONE", name: "n", arguments: "{}" }]),
  );
  assert.equal(turn.toolCalls[0]!.id, "call_THE_RIGHT_ONE");
});

test("a tool call with no arguments still parses as an empty object", () => {
  const turn = toTurn(response([{ type: "function_call", call_id: "c", name: "n", arguments: "" }]));
  assert.equal(turn.toolCalls[0]!.arguments, "{}");
});

test("stop reasons map onto the shared set, so a truncated reply is detectable", () => {
  assert.equal(toStop({ status: "completed", incomplete_details: null, output: [] } as never), "end");
  assert.equal(
    toStop({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } as never),
    "truncated",
  );
  assert.equal(
    toStop({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] } as never),
    "refused",
  );
  assert.equal(toStop({ status: "failed", incomplete_details: null, output: [] } as never), "overloaded");
});

test("a refusal content part is a refusal, even on a `completed` response", () => {
  // The status says completed; the answer is a decline. Reading only the status
  // would report a refusal as a clean finish with empty content.
  assert.equal(
    toStop({
      status: "completed",
      incomplete_details: null,
      output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
    } as never),
    "refused",
  );
});

test("usage splits the prompt into cache hit and miss without double-counting", () => {
  // `input_tokens` here is the FULL prompt including the cached part — unlike
  // Anthropic's, where it is the uncached remainder. Treating them alike would
  // over-report the prompt by the size of the cache read.
  const usage = toUsage({
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 20 },
    total_tokens: 1050,
  } as never);
  assert.deepEqual(usage, {
    promptTokens: 1000,
    completionTokens: 50,
    totalTokens: 1050,
    cacheHitTokens: 800,
    cacheMissTokens: 200,
  });
});

test("usage tolerates a response that reports no cache figures", () => {
  const usage = toUsage({ input_tokens: 10, output_tokens: 2, total_tokens: 12 } as never);
  assert.equal(usage?.cacheHitTokens, 0);
  assert.equal(usage?.cacheMissTokens, 10);
});

// ── Streaming ─────────────────────────────────────────────────────────────────

/** Replay events through `emit`, collecting what the UI would receive. */
function stream(events: unknown[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  const indexOf = new Map<number, number>();
  for (const e of events) emit(e as Responses.ResponseStreamEvent, (ev) => out.push(ev), indexOf);
  return out;
}

test("streaming maps text, reasoning, and tool-call deltas onto the shared events", () => {
  assert.deepEqual(
    stream([
      { type: "response.reasoning_text.delta", delta: "thinking" },
      { type: "response.output_text.delta", delta: "Hello" },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_1", name: "read_file" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path"' },
    ]),
    [
      { type: "reasoning", delta: "thinking" },
      { type: "text", delta: "Hello" },
      { type: "tool_start", index: 0, id: "call_1", name: "read_file" },
      { type: "tool_args", index: 0, delta: '{"path"' },
    ],
  );
});

test("reasoning arrives on either channel and reaches the UI from both", () => {
  assert.deepEqual(stream([{ type: "response.reasoning_summary_text.delta", delta: "summary" }]), [
    { type: "reasoning", delta: "summary" },
  ]);
});

test("parallel tool calls get dense indices, whatever output_index they arrive on", () => {
  // The API numbers items by their position in the whole output, so the first tool
  // call can be at index 3 if reasoning and a message came first. The shared event
  // shape keys on a dense index, and the args must land on the right one.
  const events = stream([
    { type: "response.output_item.added", output_index: 3, item: { type: "function_call", call_id: "a", name: "one" } },
    { type: "response.output_item.added", output_index: 4, item: { type: "function_call", call_id: "b", name: "two" } },
    { type: "response.function_call_arguments.delta", output_index: 4, delta: "SECOND" },
    { type: "response.function_call_arguments.delta", output_index: 3, delta: "FIRST" },
  ]);
  assert.deepEqual(events, [
    { type: "tool_start", index: 0, id: "a", name: "one" },
    { type: "tool_start", index: 1, id: "b", name: "two" },
    { type: "tool_args", index: 1, delta: "SECOND" },
    { type: "tool_args", index: 0, delta: "FIRST" },
  ]);
});

test("a non-function output item opens no tool slot", () => {
  // Reasoning and message items share the same event; only function calls are tools.
  assert.deepEqual(
    stream([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "message" } },
    ]),
    [],
  );
});

test("streaming ignores events it has no shared equivalent for", () => {
  assert.deepEqual(
    stream([
      { type: "response.created" },
      { type: "response.in_progress" },
      { type: "response.content_part.added" },
      { type: "response.output_text.done", text: "whole" },
      { type: "response.completed" },
    ]),
    [],
  );
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
  assert.equal(normalize({ model: "gpt-9-imaginary", thinking: true, effort: "high" }).model, TERRA);
  for (const model of [SOL, TERRA, LUNA]) {
    assert.equal(normalize({ model, thinking: true, effort: "high" }).model, model, `${model} was coerced away`);
  }
});
