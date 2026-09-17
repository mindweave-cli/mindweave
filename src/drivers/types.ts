/**
 * types.ts — the shared driver contract.
 *
 * Everything in this file is provider-neutral. The core engine speaks only these
 * shapes, so it never learns which model is running; a driver translates them into
 * one provider's wire format and back.
 *
 * This is the only module a driver may import from outside its own folder. Keeping
 * the surface small is what makes drivers swappable: add a provider by writing a
 * renderer for these types, not by touching the agent loop.
 */
import type { ToolSchema } from "../tools/types.js";

// ── Conversation shapes ───────────────────────────────────────────────────────

/** One tool call the model wants us to run. `arguments` is a raw JSON string. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  /**
   * Opaque provider data attached to THIS call, to be echoed back verbatim on the next
   * request. Core never reads it, never merges it, and never reasons about it — it only
   * carries it, which is what keeps this provider-neutral despite the contents not being.
   *
   * It exists because some providers make round-tripping mandatory rather than optional.
   * Gemini 3 attaches a `thought_signature` to every function call and REJECTS the next
   * request that omits it ("Function call is missing a thought_signature", 400), so a
   * client that drops unknown fields cannot call a tool twice. This was previously
   * declined on the grounds that it would change a core type for one provider's benefit;
   * that reasoning held while it was an optimization and stopped holding when it became
   * the difference between a provider working and not working at all.
   */
  meta?: Record<string, unknown>;
}

/** A tool call echoed back to the provider, in the wire shape it expects. */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Opaque provider data to splice back onto this call — see ToolCall.meta. A driver
   *  that does not need it ignores it; nothing in core inspects it. */
  meta?: Record<string, unknown>;
}

/**
 * One image travelling with a user message, with its bytes already loaded.
 *
 * Core resolves a stored path into this shape when it assembles a request, so a
 * driver never touches the filesystem and every driver gets identical bytes, caps
 * and validation. All a driver does is put them in its provider's envelope:
 *
 *   - Anthropic:            `{type:"image", source:{type:"base64", media_type, data}}`
 *   - OpenAI-compatible:    `{type:"image_url", image_url:{url:"data:<type>;base64,<data>"}}`
 *
 * `path` rides along because it is the human-readable label and the key the model is
 * given once the payload is evicted; it is not something a driver should read from.
 */
export interface ImagePart {
  /** Absolute path the image came from. For labelling, not for loading. */
  path: string;
  /** IANA media type, e.g. `image/png`. */
  mediaType: string;
  /** The image itself, base64-encoded. */
  data: string;
}

/**
 * A message in the conversation. Assistant messages may carry `tool_calls`; a
 * `tool` message carries one tool's result with the matching `tool_call_id`.
 * Keeping this exact shape is what lets the next request stay well-formed.
 *
 * This is OpenAI-shaped because that is what the transcript is stored as. A driver
 * for a provider with a different shape (Anthropic's content blocks, say) converts
 * on the way out and back on the way in — the stored transcript never changes.
 *
 * `images` is present only on user messages, only when the running model actually
 * accepts images (core checks `acceptsImages` and degrades before it ever gets
 * here), and is separate from `content` rather than folded into it so that adding
 * vision changed no existing field. A driver written before images existed keeps
 * compiling and keeps behaving exactly as it did: it simply ignores the field.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Images attached to this message, bytes included. Only ever set on `user`. */
  images?: ImagePart[];
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/**
 * Why the model stopped talking. Providers spell these differently; a driver maps
 * its own vocabulary onto this small set.
 *
 *   - `end`        — finished normally, or handed back tool calls to run.
 *   - `truncated`  — hit the output ceiling mid-answer. The reply is INCOMPLETE.
 *   - `refused`    — the provider's safety layer declined. There is no answer.
 *   - `overflow`   — the conversation no longer fits the context window.
 *   - `overloaded` — the provider's infrastructure cut the request off before it
 *                    finished (not a token limit, not a refusal). Worth a plain
 *                    retry later, the reply is INCOMPLETE the same as `truncated`.
 *
 * `truncated` is the one that matters most: without it a cut-off reply looks
 * exactly like a finished one, and the loop carries on with half an answer.
 */
export type StopReason = "end" | "truncated" | "refused" | "overflow" | "overloaded";

/** What one model turn produced: free text and/or a set of tool calls. */
export interface Turn {
  content: string;
  toolCalls: ToolCall[];
  /** Why generation stopped. Absent means the driver didn't report one; treat
   *  that as `end`, which is what every provider means by saying nothing. */
  stop?: StopReason;
  /**
   * Token accounting, when the provider reported it.
   *
   * Present on BUFFERED turns as well as streamed ones, and that is the point: the
   * buffered path is core's own internal calls — the compaction summary, the session
   * memory notes, the web-page distillation — and those spend real tokens on the
   * user's key. Without this they were invisible, so the figure on screen was short
   * by exactly the work the user never asked for and could not see.
   *
   * Optional because a provider may report nothing, which is not the same as zero.
   */
  usage?: Usage;
}

/**
 * A provider-agnostic request. This split is what makes prompt caching work on
 * EVERY model: `system` + `messages` are a STABLE, cacheable prefix — identical
 * across the steps of a task and across turns, because messages are append-only —
 * while `context` is volatile per-turn content (a ranked code map, the todo list)
 * rendered at the TAIL so it never invalidates the cached prefix. `tools` is also
 * stable and part of the prefix.
 *
 * Each driver consumes this same shape and applies caching its own way:
 *   - OpenAI-compatible providers: automatic prefix caching — it just needs the
 *     prefix kept byte-stable, which this shape guarantees.
 *   - Anthropic: explicit `cache_control` breakpoints at the prefix boundary
 *     (after tools, system, and the last stable message).
 *   - Gemini: explicit cached-content API, same principle.
 * So adding a model is "write a renderer for this request," and the cache-friendly
 * structure is decided once, here, for all of them.
 */
export interface ModelRequest {
  /** Stable, cacheable system instructions. */
  system: string;
  /** The conversation so far — append-only, no system message inside. */
  messages: ChatMessage[];
  /**
   * Genuinely volatile per-turn context — the ranked code map, the todo list, standing
   * rules, reply-style guidance. Rendered LAST, outside the cache prefix, because these
   * really do change from step to step and are small enough that re-sending them is
   * cheaper than the cache writes they would cause.
   */
  context?: string;
  /** Tools the model may call; empty/omitted forces a plain-text answer. */
  tools?: ToolSchema[];
  /** Model + reasoning selection. */
  model?: ModelConfig;
}

// ── Usage and streaming ───────────────────────────────────────────────────────

/** Token accounting for a turn, when the provider reports it (streaming only).
 *  `promptTokens` splits into cache hit + miss; the split is what lets us show a
 *  cache-aware cost instead of a misleading raw sum. Providers that don't report
 *  the split leave the two at 0 (the cost summary then treats the prompt as fresh). */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  /**
   * Fresh input, INCLUDING anything written to the cache. Kept inclusive so every
   * existing consumer stays correct without knowing about the split below.
   */
  cacheMissTokens: number;
  /**
   * The part of `cacheMissTokens` that was also written into the cache, when the
   * provider says so. A SUBSET, not a fourth bucket — pricing multiplies this slice by
   * the write rate and the remainder by the plain input rate, so double-counting it
   * would silently inflate every figure we show.
   *
   * Absent on providers that do not report it, which is not the same as zero and is
   * why it is optional rather than defaulted.
   */
  cacheWriteTokens?: number;
}

/**
 * A live event from a streaming turn. The engine forwards these to the UI so the
 * reply paints as it's generated:
 *   - `reasoning` — a chunk of the model's thinking.
 *   - `text`      — a chunk of the visible answer.
 *   - `tool_start`— the model has begun a tool call (name known; args still coming).
 *   - `tool_args` — a fragment of that call's JSON arguments.
 * The terminal `Turn` (with assembled content + tool calls + usage) is the driver
 * call's return value, not an event — so the engine builds the transcript from the
 * same well-formed shape as the non-streaming path.
 */
export type StreamEvent =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_args"; index: number; delta: string };

/** A completed streaming turn: the assembled reply plus usage when reported. */
export interface StreamResult extends Turn {
  usage?: Usage;
}

/** Per-call knobs. The model/reasoning selection lives on the ModelRequest;
 *  this is just the cancel signal (Esc to interrupt). */
export interface TurnOptions {
  signal?: AbortSignal;
}

/** Streaming knobs: the turn options plus a sink for the live events. */
export interface StreamOptions extends TurnOptions {
  /** Called for every delta as it arrives. The UI renders from these. */
  onEvent?: (event: StreamEvent) => void;
}

// ── Model selection ───────────────────────────────────────────────────────────

/** A model id, as the provider names it (e.g. `deepseek-v4-flash`). Drivers own
 *  their own id space; core only stores and forwards the string. */
export type ModelId = string;

/**
 * How much reasoning budget to spend when thinking is on. This is the union of
 * every provider's ladder, not one provider's: a driver offers only the rungs its
 * models actually accept, and `normalize` clamps anything else down to a rung it
 * does serve. DeepSeek exposes two of these, Anthropic all five.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Which model answers and how hard it thinks. Persisted per project. */
export interface ModelConfig {
  model: ModelId;
  thinking: boolean;
  /** Only meaningful when `thinking` is true. */
  effort: Effort;
}

/** One entry in the `/model` picker. */
export interface ModelChoice {
  id: ModelId;
  label: string;
  description: string;
  /**
   * When set, a millisecond timestamp past which this model is no longer offered.
   *
   * For a model a provider is retiring on a known date — typically because the vendor
   * is about to route its id to a successor. The registry stops listing it once the
   * clock passes this, so one published build behaves correctly on both sides of the
   * date. It is a transitional model rather than part of the stated lineup, so the
   * headline model counts in the docs do not count it.
   */
  until?: number;
  /**
   * What a DISCOVERED provider's listing says about this model, when it says anything.
   *
   * A fixed lineup answers these questions from the manifest's functions, because the
   * driver's author knew every model. A router serving hundreds of models from dozens of
   * vendors cannot: guessing a context window or a price by substring would be wrong for
   * most of them. Its catalogue reports the real numbers, so they travel with the choice.
   *
   * The registry reads these first and falls back to the manifest function for anything
   * absent, so a provider can report some facts and not others. Plain data only, because
   * a discovered list is persisted to disk as JSON.
   */
  facts?: ModelFacts;
}

/** Per-model facts reported by a discovered provider's own listing. See ModelChoice.facts. */
export interface ModelFacts {
  contextWindow?: number;
  price?: ModelPrice;
  acceptsImages?: boolean;
  /** Ceiling for a buffered call on this model; see DriverManifest.bufferedOutputTokens. */
  bufferedOutputTokens?: number;
  /** The `/think` ladder this model actually accepts. */
  thinkLevels?: ThinkLevel[];
}

/** One entry in the `/think` picker, for a given model. */
export interface ThinkLevel {
  label: string;
  description: string;
  thinking: boolean;
  effort: Effort;
}

/** USD per 1,000,000 tokens, split by how each token was billed. */
export interface ModelPrice {
  /** Input tokens served from the prompt cache (cheap — this is why re-send is OK). */
  cacheHit: number;
  /** Fresh input tokens (the real cost of new context). */
  cacheMiss: number;
  /** Generated tokens. */
  output: number;
  /**
   * Fresh input that is ALSO written into the cache, per million.
   *
   * A third rate, because on some providers it genuinely is one: Anthropic bills a
   * cache write at 1.25x base input (2x for the 1h TTL), since the tokens are both
   * processed and stored. Folding writes into `cacheMiss` under-reports every turn of
   * an agentic loop, which writes a new prefix segment constantly — the bill a user
   * actually receives is the one this field exists to match.
   *
   * Optional: on a provider whose cache writes cost the same as ordinary input, or
   * which never distinguishes the two, leaving it unset means "same as `cacheMiss`",
   * which is both correct there and the safe default everywhere else.
   */
  cacheWrite?: number;
}

// ── The contract ──────────────────────────────────────────────────────────────

/**
 * A provider's CHEAP metadata: what it offers and what those offerings cost.
 *
 * Manifests are always loaded, for every installed provider, because the pickers
 * and the cost/compaction math need them before anyone has chosen a model. So a
 * manifest must be plain data and pure functions — no SDK imports, no network, no
 * side effects at module load. Anything heavier belongs in the `Driver` below,
 * which is only loaded once its provider is actually selected.
 */
export interface DriverManifest {
  /** Stable identifier, e.g. "deepseek". Used to route and to name the folder. */
  id: string;

  /** Human-readable provider name, e.g. "DeepSeek". Shown during key setup. */
  label: string;

  /** The environment variable holding this provider's API key, e.g.
   *  `DEEPSEEK_API_KEY`. Setup asks for the key belonging to the model the user
   *  is about to run, so this has to be metadata rather than a hard-coded name. */
  apiKeyEnv: string;

  /** Where a user gets a key, shown on the setup screen. */
  keysUrl: string;

  /**
   * Optional: something a user should know before their prompts go to this provider,
   * shown when they switch to it. For a fact about where data goes that the provider's
   * name does not make obvious (a router may forward prompts to hosts with their own
   * retention terms). Plain text, one or two sentences.
   */
  notice?: string;

  /**
   * The models this provider offers, in `/model` order. The first is its default.
   *
   * For most providers this is the whole truth: a vendor serves a lineup known when
   * the driver is written. For a DISCOVERED provider (see `discoverModels`) it is
   * instead the fallback shown before discovery has run — often empty, since a local
   * runtime serves whatever the user has pulled and a router's catalogue changes
   * weekly. Read it through the registry's `modelsOf`, never directly, or a
   * discovered provider will look empty forever.
   */
  models: ModelChoice[];

  /**
   * Optional: fetch the live model list. Its PRESENCE is what marks a provider as
   * discovered rather than fixed.
   *
   * This exists because the fixed `models` array encodes an assumption that is true
   * of every vendor API and false of two important cases: a local runtime, where the
   * list is whatever has been pulled onto this machine, and a router, where it is
   * hundreds of models across every vendor. Both are legitimate providers, and
   * neither can state its lineup at build time.
   *
   * Called by the registry, whose cache is the only place a result is kept — a
   * driver must not memoize its own, or the list would go stale exactly when a user
   * pulls a new model and reopens the picker to find it.
   *
   * Rejecting is fine and expected: a local runtime that is not running should fail
   * here rather than throw somewhere less obvious. The registry keeps the previous
   * list on failure, so a discovery blip never empties a working picker.
   */
  discoverModels?(): Promise<ModelChoice[]>;

  /**
   * Optional: claim a model id that is not in the list yet.
   *
   * The active provider is DERIVED from the current model id rather than stored
   * beside it, deliberately — a second copy of the same fact is a second thing to
   * keep in sync. That derivation works by finding the manifest whose list contains
   * the id, which breaks for a discovered provider in the window before discovery
   * has run: a saved config naming a local model would be attributed to whichever
   * provider happens to be the fallback, and the session would open on the wrong
   * one.
   *
   * So a discovered provider states how to recognise its own ids without a list —
   * in practice a namespace prefix. Consulted only after the lists are searched, so
   * it can never take a model another provider actually serves.
   */
  ownsModel?(model: ModelId): boolean;

  /** The reasoning levels `/think` offers for one of this provider's models. */
  thinkLevels(model: ModelId): ThinkLevel[];

  /** Cache-aware price for a model. */
  price(model: ModelId): ModelPrice;

  /**
   * The model's USABLE context window — the span where retrieval and attention
   * stay reliable, which is often well below the advertised storage maximum.
   * Compaction thresholds are derived from this.
   */
  contextWindow(model: ModelId): number;

  /**
   * The ceiling this driver puts on a single BUFFERED (non-streaming) call.
   *
   * Buffered calls are core's small internal ones — a compaction summary, a page
   * distillation — so this is the most tokens one of those can come back with.
   * Core reserves exactly this much room below the window, which is why it is a
   * fact the driver has to report rather than a number core can guess: a provider
   * that caps its buffered replies at 8K needs a far smaller reserve than one that
   * allows 64K, and reserving the larger of the two on both wastes context.
   *
   * This is NOT the model's advertised output maximum (both current Anthropic
   * models accept 128K). It is what THIS driver actually sends, so it belongs to
   * the driver rather than the model card.
   *
   * Optional: a driver that sends no ceiling at all, leaving the provider's own
   * default to apply, omits it and core falls back to a conservative reserve.
   */
  bufferedOutputTokens?(model: ModelId): number;

  /**
   * Whether this model can actually SEE an image, as opposed to being told one was
   * attached. A fact about the model, reported by the driver that knows it.
   *
   * This is deliberately a fact and not a behaviour: the driver states what its model
   * can do, and core alone decides what to do about it — attach the bytes, or degrade
   * to naming the file and telling the user why. That split is what lets a provider
   * gain vision by flipping one function, with no change anywhere in core, and what
   * keeps core from ever asking "which provider is this".
   *
   * Optional, and absent means NO. A text-only provider writes nothing; a provider
   * whose lineup is mixed answers per model, which is the common case (a vendor
   * usually ships vision on some tiers before others).
   */
  acceptsImages?(model: ModelId): boolean;

  /**
   * Coerce a stored/unknown model id into one this provider actually serves, and
   * keep the reasoning intent valid for it (a level the target model lacks is
   * clamped down, an illegal combination is corrected). Called when loading a
   * saved config and when switching models.
   */
  normalize(config: ModelConfig): ModelConfig;
}

/**
 * Everything the core needs to actually TALK to one model family.
 *
 * A driver owns: the HTTP call, the request/streaming format, where prompt-cache
 * breakpoints go, and any model-specific parsing fixes. It extends its manifest so
 * the engine holds one object.
 *
 * Core owns (never a driver): the agent loop, the tools and their safety gates,
 * WHAT the system prompt says, memory, and compaction. A driver controls format,
 * not craft — it must never add "how to code" instructions for a model. The system
 * prompt is byte-identical whichever provider is running; only the envelope differs.
 */
export interface Driver extends DriverManifest {
  /** Ask the model for one turn. */
  toolTurn(request: ModelRequest, options?: TurnOptions): Promise<Turn>;

  /** Ask the model for one turn, streaming deltas to `options.onEvent`. */
  streamTurn(request: ModelRequest, options?: StreamOptions): Promise<StreamResult>;

  /**
   * Optional: clean provider quirks out of streamed text before it is displayed.
   * `toolTurn`/`streamTurn` already return clean content, but the live UI renders
   * raw `text` deltas as they arrive, so a provider that leaks markup into the
   * text channel repairs it here. Defaults to identity when a driver omits it.
   */
  sanitizeText?(raw: string): string;

  /**
   * Optional: look something up on the web.
   *
   * Search is a provider capability, not a service core buys: a model that can
   * search does it inside its own infrastructure, and one that can't cannot be
   * given the ability by bolting a third-party index onto core. So this is the
   * same bargain as `acceptsImages` — the driver reports what its provider can
   * do, and core decides how to degrade. Absent means NO, and the `web_search`
   * tool says so plainly rather than pretending.
   *
   * Returns the answer the provider grounded in what it found, plus the sources
   * it used. Results come back this way rather than as raw hits because providers
   * hand the page text to the model and not to the caller — the citations are the
   * only part core can read, so the synthesis has to come from the same call.
   */
  webSearch?(query: string, options?: SearchOptions): Promise<SearchResult>;
}

/** Options for a single `webSearch` call. */
export interface SearchOptions {
  /** Abort the underlying request (the engine's interrupt reaches it this way). */
  signal?: AbortSignal;
}

/** One page a search leaned on. */
export interface SearchSource {
  title: string;
  url: string;
}

/** What a provider found, in the only shape every provider can supply. */
export interface SearchResult {
  /** The provider's answer, grounded in the pages it read. */
  answer: string;
  /** The pages behind that answer, in the order they were cited. */
  sources: SearchSource[];
  /** True when the provider stopped searching early (its own loop hit a cap). */
  partial?: boolean;
}
