/**
 * openrouter.test.ts — the router, and the core pieces it needed.
 *
 * What is pinned is what goes wrong quietly: a model run on a different provider than
 * the one chosen, a reasoning level the model rejects, a price or window guessed where
 * the catalogue stated one, a failed reply recorded as finished, and cache breakpoints
 * landing on the part of the prompt that changes every step.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBody, consumeStream, toTurn, ProviderHttpError } from "../openaiCompat/wire.js";
import { clearDiscovered, manifestForModel, normalizeConfig, seedDiscovered, snapToLevels } from "../registry.js";
import type { ModelRequest, ThinkLevel } from "../types.js";
import { isUsable, levelsFor, toChoice, toChoices, type CatalogEntry } from "./catalog.js";
import { cacheSplit, openrouterProvider, reasoningFields, withBreakpoints } from "./client.js";
import { DEFAULT_MODEL, PREFIX, USABLE_WINDOW_CAP } from "./manifest.js";

const TOOLS = ["tools", "tool_choice", "max_tokens"];

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "vendor/model-1",
    name: "Vendor: Model 1",
    context_length: 1_048_576,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" },
    top_provider: { context_length: 1_048_576, max_completion_tokens: 384_000 },
    supported_parameters: TOOLS,
    reasoning: { mandatory: false, supported_efforts: ["max", "high", "low"] },
    ...over,
  };
}

// ── Which models are listed ───────────────────────────────────────────────────

test("a model that can run an agent turn is listed", () => {
  assert.ok(isUsable(entry()));
});

test("models that would fail on first use, or cannot be priced, are left out", () => {
  assert.equal(isUsable(entry({ supported_parameters: ["max_tokens"] })), false, "no tools");
  assert.equal(isUsable(entry({ architecture: { output_modalities: ["image"] } })), false, "no text out");
  assert.equal(isUsable(entry({ id: "vendor/model-1:batch" })), false, "batch-only");
  assert.equal(isUsable(entry({ id: "~vendor/model-latest" })), false, "moving alias");
  assert.equal(isUsable(entry({ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } })), false, "router");
});

test("free models are listed, and say they are rate-limited", () => {
  const free = entry({ id: "vendor/model-1:free", name: "Vendor: Model 1 (free)", pricing: { prompt: "0", completion: "0" } });
  assert.ok(isUsable(free));
  assert.match(toChoice(free).description, /free, rate-limited/);
});

test("a model that costs nothing without the :free suffix reads as free, not as a $0 price", () => {
  const preview = entry({ id: "stealth/preview-alpha", name: "Preview Alpha", pricing: { prompt: "0", completion: "0" } });
  const description = toChoice(preview).description;
  assert.match(description, /free/);
  assert.doesNotMatch(description, /\$0/);
  assert.doesNotMatch(description, /rate-limited/, "the :free request limit was claimed for a model that does not carry it");
});

// ── Facts from the catalogue ──────────────────────────────────────────────────

test("ids are namespaced, labels lose the vendor prefix, the vendor stays findable", () => {
  const c = toChoice(entry());
  assert.equal(c.id, `${PREFIX}vendor/model-1`);
  assert.equal(c.label, "Model 1");
  assert.match(c.description, /^Vendor/);
});

test("price is per million, with cache read and write when listed", () => {
  const c = toChoice(entry({ pricing: { prompt: "0.00001", completion: "0.00005", input_cache_read: "0.00000025", input_cache_write: "0.0000125" } }));
  const p = c.facts!.price!;
  assert.ok(Math.abs(p.cacheMiss - 10) < 1e-9 && Math.abs(p.output - 50) < 1e-9);
  assert.ok(Math.abs(p.cacheHit - 0.25) < 1e-9 && Math.abs(p.cacheWrite! - 12.5) < 1e-9);
});

test("without a cache-read price, cached input is not assumed to be cheaper", () => {
  const p = toChoice(entry({ pricing: { prompt: "0.000001", completion: "0.000002" } })).facts!.price!;
  assert.equal(p.cacheHit, p.cacheMiss);
});

test("the window is the advertised one, capped at the usable ceiling", () => {
  assert.equal(toChoice(entry()).facts!.contextWindow, USABLE_WINDOW_CAP);
  const small = entry({ context_length: 131_072, top_provider: { context_length: 131_072 } });
  assert.equal(toChoice(small).facts!.contextWindow, 131_072);
});

test("peak-hour pricing is admitted in the description", () => {
  const peak = entry({ pricing: { prompt: "0.00000015", completion: "0.0000006", overrides: [{}] } });
  assert.match(toChoice(peak).description, /peak hours cost more/);
});

test("the reasoning ladder is the catalogue's, in Mindweave's rungs", () => {
  const levels = levelsFor(entry());
  assert.deepEqual(
    levels.map((l) => [l.thinking, l.effort]),
    [[false, "low"], [true, "low"], [true, "high"], [true, "max"]],
  );
});

test("a model whose reasoning is mandatory offers no way to turn it off", () => {
  const levels = levelsFor(entry({ reasoning: { mandatory: true, supported_efforts: ["high", "medium", "low", "none"] } }));
  assert.ok(levels.every((l) => l.thinking), "an off row was offered for a model that rejects it");
});

test("no reasoning object means one row, and a toggle-only model gets on and off", () => {
  assert.equal(levelsFor(entry({ reasoning: null })).length, 1);
  assert.deepEqual(levelsFor(entry({ reasoning: { mandatory: false } })).map((l) => l.thinking), [false, true]);
});

// ── The registry answering from facts ─────────────────────────────────────────

test("the id another provider also serves is attributed by its namespace", () => {
  // `openai/gpt-oss-120b` is an exact id on Groq too. Un-namespaced, choosing it here
  // ran it on Groq.
  clearDiscovered();
  assert.equal(manifestForModel(`${PREFIX}openai/gpt-oss-120b`).id, "openrouter");
  assert.equal(manifestForModel("openai/gpt-oss-120b").id, "groq");
});

test("once discovered, window, price, vision and ladder come from the catalogue", () => {
  clearDiscovered();
  const c = toChoice(entry({ context_length: 64_000, top_provider: { context_length: 64_000 }, architecture: { input_modalities: ["text"], output_modalities: ["text"] } }));
  seedDiscovered("openrouter", [c], Date.now());
  const m = manifestForModel(c.id);
  assert.equal(m.contextWindow(c.id), 64_000);
  assert.equal(m.acceptsImages?.(c.id), false);
  assert.ok(Math.abs(m.price(c.id).cacheMiss - 0.15) < 1e-9);
  assert.deepEqual(m.thinkLevels(c.id), c.facts!.thinkLevels);
  clearDiscovered();
});

test("every catalogue level survives normalize, and anything else lands on one", () => {
  clearDiscovered();
  const c = toChoice(entry({ reasoning: { mandatory: true, supported_efforts: ["xhigh", "medium"] } }));
  seedDiscovered("openrouter", [c], Date.now());
  const levels = c.facts!.thinkLevels!;
  for (const l of levels) {
    const config = { model: c.id, thinking: l.thinking, effort: l.effort };
    assert.deepEqual(normalizeConfig(config), config, `"${l.label}" was altered`);
  }
  const moved = normalizeConfig({ model: c.id, thinking: false, effort: "max" });
  assert.ok(levels.some((l) => l.thinking === moved.thinking && l.effort === moved.effort));
  assert.equal(moved.effort, "xhigh", "the nearest rung to max should be xhigh, not medium");
  clearDiscovered();
});

test("snapping rounds down on a tie, never up to a costlier rung", () => {
  const ladder: ThinkLevel[] = [
    { label: "Low", description: "", thinking: true, effort: "low" },
    { label: "High", description: "", thinking: true, effort: "high" },
  ];
  assert.equal(snapToLevels({ model: "m", thinking: true, effort: "medium" }, ladder).effort, "low");
});

// ── The request ───────────────────────────────────────────────────────────────

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "SYSTEM",
  messages: [{ role: "user", content: "hi" }],
  model: { model: `${PREFIX}anthropic/claude-fable-5.1`, thinking: true, effort: "xhigh" },
  ...over,
});

test("the namespace never reaches the wire", () => {
  assert.equal(buildBody(openrouterProvider, req()).model, "anthropic/claude-fable-5.1");
  assert.equal(buildBody(openrouterProvider, req({ model: undefined })).model, DEFAULT_MODEL.slice(PREFIX.length));
});

test("reasoning is OpenRouter's one field: an effort when on, disabled when off", () => {
  assert.deepEqual(reasoningFields({ model: "m", thinking: true, effort: "max" }), { reasoning: { effort: "max" } });
  assert.deepEqual(reasoningFields({ model: "m", thinking: false, effort: "low" }), { reasoning: { enabled: false } });
});

test("Anthropic-served models get breakpoints on the system prompt and the last stable message only", () => {
  const body = buildBody(
    openrouterProvider,
    req({
      messages: [
        { role: "user", content: "task" },
        { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", content: "file text", tool_call_id: "1" },
      ],
      context: "todo list",
    }),
  );
  const messages = body.messages as { role: string; content: unknown }[];
  const marked = messages.map((m) => Array.isArray(m.content) && JSON.stringify(m.content).includes("cache_control"));
  // system, user, assistant(tool call), tool result, context tail
  assert.deepEqual(marked, [true, false, false, true, false]);
});

test("breakpoints walk back past a message with no text to mark", () => {
  const out = withBreakpoints(
    [
      { role: "system", content: "S" },
      { role: "user", content: "task" },
      { role: "assistant", content: "" },
    ],
    false,
  );
  assert.ok(Array.isArray(out[1]!.content), "the boundary did not move to the nearest message with text");
  assert.equal(out[2]!.content, "");
});

test("families that cache automatically are sent plain strings", () => {
  const body = buildBody(openrouterProvider, req({ model: { model: `${PREFIX}deepseek/deepseek-v4.1-flash`, thinking: false, effort: "low" } }));
  assert.ok((body.messages as { content: unknown }[]).every((m) => typeof m.content === "string"));
});

test("data collection is left at OpenRouter's default unless the user denies it", () => {
  const before = process.env.MINDWEAVE_OPENROUTER_DATA;
  try {
    delete process.env.MINDWEAVE_OPENROUTER_DATA;
    assert.equal(buildBody(openrouterProvider, req()).provider, undefined);
    process.env.MINDWEAVE_OPENROUTER_DATA = "deny";
    assert.deepEqual(buildBody(openrouterProvider, req()).provider, { data_collection: "deny" });
  } finally {
    if (before === undefined) delete process.env.MINDWEAVE_OPENROUTER_DATA;
    else process.env.MINDWEAVE_OPENROUTER_DATA = before;
  }
});

test("app attribution goes out as OpenRouter reads it", () => {
  assert.equal(openrouterProvider.headers?.["HTTP-Referer"], "https://github.com/mindweave-cli/mindweave");
  assert.equal(openrouterProvider.headers?.["X-OpenRouter-Title"], "mwcode");
});

test("cache reads and writes are both reported", () => {
  assert.deepEqual(
    cacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 150 } }),
    { hit: 800, miss: 200, write: 150 },
  );
  assert.equal(cacheSplit({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } }), undefined);
});

// ── Failures inside a 200 ─────────────────────────────────────────────────────

function sse(...chunks: unknown[]): Pick<Response, "body"> {
  const text = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
  return { body: new Response(text).body };
}

test("an error chunk after text keeps the text as an incomplete reply", async () => {
  const result = await consumeStream(
    openrouterProvider,
    sse(
      { choices: [{ delta: { content: "Half an ans" } }] },
      { error: { code: 502, message: "upstream died" }, choices: [{ delta: {}, finish_reason: "error" }] },
    ),
  );
  assert.equal(result.content, "Half an ans");
  assert.equal(result.stop, "overloaded", "a reply cut off by the provider was recorded as finished");
});

test("an error chunk with nothing before it surfaces the provider's message", async () => {
  await assert.rejects(
    consumeStream(openrouterProvider, sse({ error: { code: 402, message: "Insufficient credits" } })),
    (e: unknown) => e instanceof ProviderHttpError && e.status === 402 && /Insufficient credits/.test(e.message),
  );
});

test("finish_reason error with no error object is still a failure", async () => {
  await assert.rejects(consumeStream(openrouterProvider, sse({ choices: [{ delta: {}, finish_reason: "error" }] })));
});

test("a buffered 200 carrying an error throws instead of returning an empty turn", () => {
  assert.throws(
    () => toTurn(openrouterProvider, { error: { code: 429, message: "Rate limited" } }),
    (e: unknown) => e instanceof ProviderHttpError && e.status === 429,
  );
});

// ── The persisted catalogue ───────────────────────────────────────────────────

test("a refreshed list is written to disk and seeds the next launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mw-openrouter-cache-"));
  const before = process.env.MINDWEAVE_STATE_DIR;
  process.env.MINDWEAVE_STATE_DIR = dir;
  try {
    const { persistedForTest, loadDiscoveryCache } = await import("../../dynamo/model.js");
    clearDiscovered();
    const c = toChoice(entry());
    seedDiscovered("openrouter", [c], 1234);
    await persistedForTest("openrouter");
    const saved = JSON.parse(readFileSync(join(dir, "cache", "models-openrouter.json"), "utf8"));
    assert.equal(saved.fetchedAt, 1234);
    clearDiscovered();
    await loadDiscoveryCache();
    assert.equal(manifestForModel(c.id).contextWindow(c.id), USABLE_WINDOW_CAP, "the facts did not survive the round trip");
  } finally {
    clearDiscovered();
    if (before === undefined) delete process.env.MINDWEAVE_STATE_DIR;
    else process.env.MINDWEAVE_STATE_DIR = before;
  }
});

test("toChoices drops unusable entries and keeps the rest in catalogue order", () => {
  const out = toChoices([entry({ id: "a/one" }), entry({ id: "a/one:batch" }), entry({ id: "b/two" })]);
  assert.deepEqual(out.map((c) => c.id), [`${PREFIX}a/one`, `${PREFIX}b/two`]);
});
