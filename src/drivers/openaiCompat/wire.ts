/**
 * wire.ts — the shared OpenAI-compatible wire layer.
 *
 * A growing number of providers serve chat over OpenAI's `/chat/completions`
 * shape: same request body, same `tools[]` → `tool_calls`, same SSE framing, same
 * fragmented tool-call arguments. Written per provider, that is ~250 lines of
 * identical stream plumbing copied N times, and N places for the same bug to be
 * fixed once and missed elsewhere. So the plumbing lives here ONCE and each
 * provider supplies only the handful of facts that genuinely differ.
 *
 * What a provider still owns, via `CompatProvider` below:
 *   - where it lives (base URL) and which key opens it,
 *   - how it spells REASONING, which is the field every provider invents
 *     differently (a toggle, a budget, an effort rung, or nothing at all),
 *   - which of its `finish_reason` values are not in the OpenAI vocabulary,
 *   - where it reports cached-token counts, which is also unstandardised.
 *
 * What this module deliberately does NOT do: change what the model is asked. The
 * system prompt is the same bytes through here as through any other driver. This
 * is an envelope, not a craft decision.
 */
import type {
  ChatMessage,
  ModelConfig,
  ModelRequest,
  StreamEvent,
  StreamResult,
  StopReason,
  ToolCall,
  Turn,
  Usage,
} from "../types.js";
import { clientId } from "../clientId.js";
import { isAbortLike, isRetryable, nextDelayMs, retryAfterMs, RETRY_MAX_ATTEMPTS } from "../retryPolicy.js";
import { salvagePartialTurn } from "../partialTurn.js";

/** The facts one OpenAI-compatible provider has to supply. */
export interface CompatProvider {
  /** Human-readable name, used only in error messages. */
  label: string;
  /** Root of the OpenAI-compatible API, with no trailing slash. */
  baseUrl: string;
  /** Environment variable holding the key, e.g. `DASHSCOPE_API_KEY`. */
  apiKeyEnv: string;
  /** Model used when a request carries no explicit selection. */
  defaultModel: string;

  /**
   * The provider-specific fields that express a reasoning selection.
   *
   * This is the one part no two providers agree on: DeepSeek takes
   * `thinking: {type}` plus `reasoning_effort`, Qwen takes `enable_thinking` plus
   * `thinking_budget`, others take a bare `reasoning_effort` or nothing. Returning
   * a fragment of the body — rather than accepting a flag — means a provider can
   * express any of those without this module learning about it.
   *
   * Returning an EMPTY object is meaningful and must be deliberate: it leaves the
   * provider's own default in force, which for several of these is "think hard,
   * and bill for it". Say so explicitly rather than defaulting into it.
   */
  reasoningFields(config: ModelConfig | undefined): Record<string, unknown>;

  /**
   * Map a `finish_reason` this provider invented onto the shared set. Return
   * `undefined` for anything the OpenAI vocabulary already covers, which is
   * handled below. Optional: most providers add nothing.
   */
  extraStop?(reason: string): StopReason | undefined;

  /**
   * Pull the cache hit/miss split out of a usage object. Optional, because the
   * field names are unstandardised and some providers report nothing at all —
   * which is why the fallback treats the whole prompt as fresh rather than
   * inventing a split that would quietly under-report cost.
   */
  cacheSplit?(usage: Record<string, unknown>): { hit: number; miss: number; write?: number } | undefined;

  /**
   * Output ceiling for a BUFFERED (non-streaming) call — core's small internal
   * ones, like a compaction summary.
   *
   * This must agree with what the manifest reports as `bufferedOutputTokens`,
   * because core reserves exactly that much room below the context window. A
   * manifest that declares a ceiling while the request sends none is the failure
   * this field exists to prevent: the provider's own default applies, which is
   * typically far larger than the reservation, and a long summary then overruns
   * the room set aside for it. Omit BOTH or set BOTH.
   */
  bufferedMaxTokens?: number;

  /** Output ceiling for a streamed turn. Omitted leaves the provider's default. */
  streamMaxTokens?: number;

  /**
   * Sampling fields (`temperature`, `top_p`, …) for this request. Optional, and
   * omitting it — which every provider but DeepSeek does — sends nothing and leaves
   * the provider's own defaults in force.
   *
   * It takes the config rather than being a constant because whether sampling has
   * any effect at all can depend on the reasoning selection: DeepSeek documents that
   * thinking mode IGNORES temperature and top_p, silently, without an error. Sending
   * them anyway would be inert rather than harmful, but it would also be a claim in
   * the request body that is not true of the call, and the next person to read it
   * would reasonably conclude the numbers were doing something.
   */
  sampling?(config: ModelConfig | undefined): Record<string, unknown>;

  /**
   * Repair a provider's own damage to the assembled reply, before anything else
   * sees it. Optional, and most providers need nothing.
   *
   * This exists because "OpenAI-compatible" describes the request, not the model's
   * discipline about honouring it. DeepSeek intermittently emits tool calls as
   * MARKUP inside the text channel instead of as `tool_calls`, so the reply arrives
   * carrying a call that will never run and prose full of tags. Recovering the call
   * and stripping the tags is a repair, not a format decision — which is why it
   * takes the assembled content AND the structured calls, and may return both
   * changed: the two are one decision (a recovered call is only recovered because
   * the structured list was empty).
   *
   * Applied identically on the buffered and streamed paths, so a turn cannot be
   * clean one way and corrupt the other.
   */
  repairContent?(content: string, toolCalls: ToolCall[]): { content: string; toolCalls: ToolCall[] };

  /** Extra request headers, e.g. a router's app identification. Optional. */
  headers?: Record<string, string>;

  /**
   * Last word on the request body before it is sent, for what the shared shape cannot
   * express: a router's model id differs from the id Mindweave stores, and explicit
   * cache breakpoints live on message content parts. Receives the finished body and
   * returns the one to send. Applied on the buffered and streamed paths alike.
   */
  finishBody?(body: Record<string, unknown>, req: ModelRequest): Record<string, unknown>;
}

/**
 * The error thrown when a provider returns a non-2xx response.
 *
 * `status` and `detail` ride on the object rather than being formatted into the
 * message, because something upstream has to tell an account refusal (401/402/403/
 * 429) apart from a malformed request, and re-parsing a human sentence to recover a
 * number we already had is the kind of thing that quietly stops working. See
 * `drivers/providerError.ts`. Both SDK-backed drivers expose `status` the same way,
 * so one classifier serves every provider.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    label: string,
    statusText: string,
  ) {
    super(`${label} API error ${status}: ${detail || statusText}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * The cache split as most OpenAI-compatible providers report it:
 * `prompt_tokens_details.cached_tokens`, where `prompt_tokens` is the FULL prompt
 * including the cached part — so the miss side is the remainder, not a second
 * figure to add.
 *
 * Shared because this exact shape is what Qwen, GLM, xAI, Mistral, Groq and
 * Cerebras all return, and six copies of six lines is six places for the same
 * arithmetic to drift. A provider that reports something else supplies its own.
 *
 * Returning `undefined` when nothing is reported is load-bearing, not tidiness. The
 * caller then counts the whole prompt as fresh, and on a multi-step turn that means
 * every step's prompt is counted again — which is exactly the inflation the token
 * meter exists to avoid. So a provider that DOES cache must be wired to this, or
 * its turns silently report several times what they cost.
 */
export function standardCacheSplit(usage: Record<string, unknown>): { hit: number; miss: number } | undefined {
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const hit = typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
  if (hit === 0) return undefined;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  return { hit, miss: Math.max(0, prompt - hit) };
}

/** Apply a provider's content repair, or pass the turn through untouched. */
function repair(
  provider: CompatProvider,
  content: string,
  toolCalls: ToolCall[],
): { content: string; toolCalls: ToolCall[] } {
  return provider.repairContent ? provider.repairContent(content, toolCalls) : { content, toolCalls };
}

/**
 * Render a ModelRequest to OpenAI-shape messages: the stable system prompt, the
 * stable conversation, then the volatile context as a trailing block.
 *
 * Keeping `context` strictly LAST is what preserves the cacheable prefix — an
 * OpenAI-compatible provider caches the longest identical prefix from token 0, so
 * anything volatile must come after everything worth caching. This is the property
 * the whole ModelRequest split exists to guarantee.
 */
/**
 * Put a stored tool call back on the wire, including whatever opaque provider data came
 * with it.
 *
 * `meta.extra_content` is spliced back as a sibling of `function`, which is the shape it
 * arrived in. Gemini 3 attaches a `thought_signature` there and returns 400 on the next
 * request if it is missing — "Function call is missing a thought_signature" — so an
 * OpenAI-compatible client that drops unknown fields can make exactly one tool call per
 * conversation and then breaks. Passing it through unread is the whole fix.
 */
function wireToolCall(
  c: NonNullable<ChatMessage["tool_calls"]>[number],
  provider: string,
): Record<string, unknown> {
  // Only back to the provider that produced it.
  //
  // The blob is opaque and provider-specific: Gemini's is a thought_signature, and
  // sending it to DeepSeek or Qwen after a mid-session /provider switch hands one
  // vendor's internal data to another under a key they never defined. Measured before
  // this check existed — the signature went straight through.
  //
  // An UNTAGGED blob is replayed, because it can only have come from a session recorded
  // before this tag existed and the alternative is worse: Gemini returns 400 on the next
  // request when a call loses its signature, so dropping it would break exactly the
  // resumed sessions that still carry one.
  const from = c.meta?.provider;
  const mine = from === undefined || from === provider;
  const extra = mine ? c.meta?.extra_content : undefined;
  return {
    id: c.id,
    type: c.type,
    function: c.function,
    ...(extra ? { extra_content: extra } : {}),
  };
}

/**
 * Serialize messages for the body, converting each tool call's opaque `meta` into the
 * field name the provider actually expects.
 *
 * Separate from `renderMessages` on purpose: that function answers "what messages, in
 * what order", which is the part worth asserting in tests, while this one is the last
 * step before the bytes leave. Sending `meta` verbatim would put an unknown key on the
 * wire under a name no provider knows.
 */
/**
 * Render one message's content, as multimodal parts when it carries images.
 *
 * OpenAI's shape, which is what every provider on this transport speaks: `content`
 * becomes an ARRAY of typed parts instead of a string, and an image is an
 * `image_url` whose url is a `data:` URI. DeepSeek documents exactly this for its
 * vision model, so nothing here is provider-specific.
 *
 * The text part comes FIRST and is always present, even when empty. A message that
 * is only images reads as a bare attachment with no request attached to it, and the
 * text is what carries the user's actual question.
 */
function toWireContent(m: ChatMessage): string | Record<string, unknown>[] {
  if (!m.images || m.images.length === 0) return m.content;
  return [
    { type: "text", text: m.content },
    ...m.images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    })),
  ];
}

export function toWireMessages(messages: ChatMessage[], provider = ""): Record<string, unknown>[] {
  return messages.map((m) => {
    // `images` is OUR field, not a wire field. It was previously spread onto the
    // request untouched, so a provider saw an unknown key and the picture itself
    // never left the machine — the attachment was silently text-only.
    const { tool_calls: calls, images: _ours, ...rest } = m;
    const base = { ...rest, content: toWireContent(m) };
    if (!calls || calls.length === 0) return base;
    return { ...base, tool_calls: calls.map((c) => wireToolCall(c, provider)) };
  });
}

export function renderMessages(req: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: req.system }, ...req.messages];
  if (req.context && req.context.trim()) {
    // A trailing USER message is the most universally accepted shape here: a
    // non-leading system message is not guaranteed to be honored. It is clearly
    // framed as current context rather than as the human talking.
    messages.push({ role: "user", content: `<current_context>\n${req.context}\n</current_context>` });
  }
  return messages;
}

/**
 * Build the request body shared by the buffered and streaming paths.
 *
 * `maxTokens` is the output ceiling for THIS path, and is omitted from the body
 * when the provider declares none — leaving its own default in force, which is the
 * documented behaviour rather than an oversight.
 */
export function buildBody(
  provider: CompatProvider,
  req: ModelRequest,
  maxTokens?: number,
): Record<string, unknown> {
  const tools = req.tools ?? [];
  const body: Record<string, unknown> = {
    model: req.model?.model ?? provider.defaultModel,
    messages: toWireMessages(renderMessages(req), provider.label),
    ...provider.reasoningFields(req.model),
    ...(provider.sampling?.(req.model) ?? {}),
  };
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  return provider.finishBody ? provider.finishBody(body, req) : body;
}

/**
 * Map an OpenAI-shaped `finish_reason` onto the shared stop reason.
 *
 * `stop` and `tool_calls` are both a normal finish; `length` means the answer was
 * cut off mid-sentence, which the engine has to be able to tell apart from a real
 * ending. A provider's own vocabulary gets first refusal via `extraStop`, so a
 * non-standard value can never fall through to `"end"` and report an incomplete
 * reply as a clean one.
 */
export function toStop(provider: CompatProvider, reason: string | null | undefined): StopReason {
  if (!reason) return "end";
  const extra = provider.extraStop?.(reason);
  if (extra) return extra;
  switch (reason) {
    case "length":
      return "truncated";
    case "content_filter":
      return "refused";
    default:
      return "end";
  }
}

/**
 * A failure reported INSIDE a successful response.
 *
 * Once a stream has started the HTTP status is already 200 and cannot change, so a
 * router whose upstream dies mid-reply says so in the body: a top-level `error`
 * object, and often `finish_reason: "error"` on the last choice. A buffered response
 * can carry the same object with a 200. Read naively, both look like a model that
 * finished normally, possibly having said nothing.
 *
 * Returned as a ProviderHttpError when the body names a numeric code, so an account
 * refusal (402 out of credits, 429 rate limited) is classified the same whether it
 * arrived as a status line or inside the body.
 */
export function bodyError(provider: CompatProvider, raw: unknown): Error | undefined {
  const error = (raw as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" && message ? message : "the provider reported an error";
  const status = typeof code === "number" ? code : Number(code);
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return new ProviderHttpError(status, text, provider.label, "");
  }
  return upstreamError(`${provider.label} API error: ${text}`);
}

/**
 * An error the PROVIDER reported with no status to classify it by, marked so the
 * screen can say "the provider failed" rather than show a bare red error.
 */
export function upstreamError(message: string): Error {
  return Object.assign(new Error(message), { upstream: true });
}

/** The slice of a streaming chunk we read (OpenAI-compatible SSE shape). */
interface StreamChunk {
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      /** Reasoning channel. Providers disagree on the name; both are read. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
        /** Provider-specific passthrough. Gemini puts a `thought_signature` here and
         *  rejects the next request that omits it — see ToolCall.meta. */
        extra_content?: Record<string, unknown>;
      }[];
    };
  }[];
  usage?: Record<string, unknown>;
  error?: unknown;
}

/**
 * Read an SSE response into a finished turn, emitting each delta along the way.
 *
 * Every `data:` line is a chunk whose `choices[0].delta` carries some of `content`,
 * a reasoning field, or `tool_calls`. Tool calls are FRAGMENTED — the first
 * fragment for an index brings the id and name, later ones append `arguments` text
 * — so they are accumulated by index and only assembled at the end.
 */
export async function consumeStream(
  provider: CompatProvider,
  response: Pick<Response, "body">,
  onEvent?: (event: StreamEvent) => void,
): Promise<StreamResult> {
  let content = "";
  // Tool calls under construction, keyed by streaming index. `started` guards the
  // one-time tool_start emit, fired when the name first appears.
  const tools = new Map<
    number,
    { id: string; name: string; args: string; started: boolean; extra?: Record<string, unknown> }
  >();
  let usage: Usage | undefined;
  let finishReason: string | null | undefined;

  try {
  for await (const data of sseLines(response)) {
    if (data === "[DONE]") break;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      continue; // ignore keep-alive comments / malformed lines
    }

    if (chunk.usage) usage = toUsage(provider, chunk.usage);
    finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
    // A failure after the stream began. Thrown into the salvage path below, so text
    // already shown is kept as an incomplete reply and a stream with nothing in it
    // surfaces the provider's own sentence instead of an empty "finished" turn.
    const failed = bodyError(provider, chunk);
    if (failed) throw failed;
    if (finishReason === "error") throw upstreamError(`${provider.label} API error: the reply ended with an error`);

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      onEvent?.({ type: "reasoning", delta: reasoning });
    }
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onEvent?.({ type: "text", delta: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0;
      let acc = tools.get(index);
      if (!acc) {
        acc = { id: "", name: "", args: "", started: false, extra: undefined };
        tools.set(index, acc);
      }
      if (tc.id) acc.id = tc.id;
      // Carried, never interpreted. It arrives on whichever fragment the provider
      // chooses, so the last non-empty one wins rather than the first.
      if (tc.extra_content) acc.extra = tc.extra_content;
      // The name usually arrives whole in the first fragment, but append
      // defensively in case a provider splits it.
      if (tc.function?.name) acc.name += tc.function.name;
      if (!acc.started && acc.name) {
        acc.started = true;
        onEvent?.({ type: "tool_start", index, id: acc.id, name: acc.name });
      }
      const argFragment = tc.function?.arguments;
      if (argFragment) {
        acc.args += argFragment;
        onEvent?.({ type: "tool_args", index, delta: argFragment });
      }
    }
  }
  } catch (error) {
    if (isAbortLike(error)) throw error;
    return salvagePartialTurn(content, error);
  }

  const assembled: ToolCall[] = [...tools.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id: t.id,
      name: t.name,
      arguments: t.args || "{}",
      ...(t.extra ? { meta: { extra_content: t.extra, provider: provider.label } } : {}),
    }));

  const repaired = repair(provider, content, assembled);
  return { ...repaired, usage, stop: toStop(provider, finishReason) };
}


/**
 * Fold a usage object into the shared shape.
 *
 * The cache split is asked of the provider because the field names are
 * unstandardised. When it reports none, the prompt counts as entirely fresh —
 * an over-estimate, deliberately, since the alternative is inventing a discount
 * the user did not receive.
 */
export function toUsage(provider: CompatProvider, raw: Record<string, unknown>): Usage {
  const num = (key: string): number => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
  const promptTokens = num("prompt_tokens");
  const completionTokens = num("completion_tokens");
  const split = provider.cacheSplit?.(raw);
  return {
    promptTokens,
    completionTokens,
    totalTokens: num("total_tokens") || promptTokens + completionTokens,
    cacheHitTokens: split?.hit ?? 0,
    cacheMissTokens: split?.miss ?? promptTokens,
    ...(split?.write !== undefined ? { cacheWriteTokens: split.write } : {}),
  };
}

/** Pull a finished (non-streamed) response into a turn. */
export function toTurn(provider: CompatProvider, data: unknown): Turn {
  const parsed = data as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: {
          id: string;
          function: { name: string; arguments: string };
          extra_content?: Record<string, unknown>;
        }[];
      };
      finish_reason?: string | null;
    }[];
    usage?: Record<string, unknown>;
  };
  const failed = bodyError(provider, data);
  if (failed) throw failed;
  if (parsed.choices?.[0]?.finish_reason === "error") {
    throw upstreamError(`${provider.label} API error: the reply ended with an error`);
  }
  const message = parsed.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls = (message?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments || "{}",
    ...(tc.extra_content ? { meta: { extra_content: tc.extra_content, provider: provider.label } } : {}),
  }));
  const repaired = repair(provider, content, toolCalls);
  return {
    ...repaired,
    stop: toStop(provider, parsed.choices?.[0]?.finish_reason),
    // Buffered calls are core's internal ones and spend real tokens; without this
    // they are invisible to the meter. Absent when the provider reports nothing,
    // which is not the same as zero.
    usage: parsed.usage ? toUsage(provider, parsed.usage) : undefined,
  };
}

/**
 * Yield each SSE `data:` payload from a streamed response body.
 *
 * Frames are separated by a blank line and may carry more than one `data:` line.
 * Decoding is incremental and a payload is only emitted once a FULL frame has
 * arrived, so one split across network packets is never parsed half-formed.
 */
export async function* sseLines(response: Pick<Response, "body">): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  // `response.body` is a web ReadableStream; Node exposes it as async-iterable.
  for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    let sep: number;
    while ((sep = firstFrameEnd(buffer)) !== -1) {
      const frame = buffer.slice(0, sep).trim();
      buffer = buffer.slice(sep).replace(/^(\r?\n)+/, "");
      const payload = frameData(frame);
      if (payload !== null) yield payload;
    }
  }
}

/** Index just past the first frame separator (blank line) in `buf`, or -1. */
function firstFrameEnd(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4;
  if (crlf === -1) return lf + 2;
  return Math.min(lf + 2, crlf + 4);
}

/** Join the `data:` lines of one SSE frame into its payload, or null if none. */
function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) parts.push(line.slice(5).trimStart());
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** The provider's API key, or a clear setup error if it isn't configured yet. */
export function requireApiKey(provider: CompatProvider): string {
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `No ${provider.apiKeyEnv} found. Add your key to the global config so Mindweave works ` +
        "in every project:\n" +
        `  ~/.mindweave/.env  →  ${provider.apiKeyEnv}=your-key-here\n` +
        "(A per-project .env or an exported shell variable also works.)",
    );
  }
  return apiKey;
}

/** Wait, unless the user cancels first — in which case stop immediately rather than
 *  serving out a backoff nobody is waiting for any more. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One request to the provider, retried through the blips.
 *
 * The response is returned UNREAD: the caller decides whether to parse it as JSON or
 * stream it. That is what keeps this safe to retry — every decision here is made from
 * the status line, before a byte of the body is consumed and before anything reaches
 * the screen, so a second attempt is a second attempt rather than a duplicate.
 */
async function send(provider: CompatProvider, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const started = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${requireApiKey(provider)}`,
          "User-Agent": clientId(),
          ...provider.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return response;
      const detail = await response.text().catch(() => "");
      lastError = new ProviderHttpError(response.status, detail, provider.label, response.statusText);
    } catch (error) {
      // A cancel is not a fault and must never be slept on or tried again.
      if (isAbortLike(error)) throw error;
      lastError = error;
    }

    const status = response ? response.status : null;
    if (!isRetryable(lastError, status)) throw lastError;
    if (attempt === RETRY_MAX_ATTEMPTS) break;

    const delay = nextDelayMs(attempt, Date.now() - started, retryAfterMs(response?.headers.get("retry-after")));
    // Null means the wait would outlast the budget. Surfacing the provider's own
    // sentence, which usually names the cooldown, beats sleeping through it silently.
    if (delay === null) break;
    await sleep(delay, signal);
  }
  throw lastError;
}

/** POST to chat/completions, returning the parsed JSON body. */
async function post(provider: CompatProvider, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return (await send(provider, body, signal)).json();
}

/** POST a streaming request, returning the raw response for SSE reading. */
async function postStream(
  provider: CompatProvider,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return send(provider, body, signal);
}

/** One entry from an OpenAI-compatible `GET /models` listing. */
export interface ListedModel {
  id: string;
  /** Some providers report it here; most do not. Absent means "ask the manifest". */
  context_window?: number;
  owned_by?: string;
}

/**
 * List the models this provider currently serves.
 *
 * The OpenAI-compatible `/models` endpoint, which is what makes a DISCOVERED
 * provider possible: a fast-inference host rotates its catalogue often enough that
 * a list compiled into the driver is wrong within weeks, and the endpoint is the
 * only thing that is never wrong.
 *
 * Deliberately THROWS rather than returning an empty list on failure. The registry
 * treats the two differently and must be able to: an empty list means "serving
 * nothing right now", while a throw means "could not ask", and only the first
 * should replace what the picker is showing.
 */
export async function listModels(provider: CompatProvider): Promise<ListedModel[]> {
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${requireApiKey(provider)}`, "User-Agent": clientId(), ...provider.headers },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ProviderHttpError(response.status, detail, provider.label, response.statusText);
  }
  const body = (await response.json()) as { data?: ListedModel[] };
  return (body.data ?? []).filter((m) => typeof m.id === "string" && m.id.length > 0);
}

/** Ask the model for one turn. */
export async function compatToolTurn(
  provider: CompatProvider,
  req: ModelRequest,
  signal?: AbortSignal,
): Promise<Turn> {
  const body = { ...buildBody(provider, req, provider.bufferedMaxTokens), stream: false };
  return toTurn(provider, await post(provider, body, signal));
}

/**
 * Ask the model for one turn, STREAMING.
 *
 * `stream_options.include_usage` asks for a final chunk carrying the token counts.
 * Providers that don't honour it simply never send one, and usage stays undefined —
 * which the caller already treats as "not reported" rather than as zero.
 */
export async function compatStreamTurn(
  provider: CompatProvider,
  req: ModelRequest,
  onEvent?: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const body = {
    ...buildBody(provider, req, provider.streamMaxTokens),
    stream: true,
    stream_options: { include_usage: true },
  };
  return consumeStream(provider, await postStream(provider, body, signal), onEvent);
}
