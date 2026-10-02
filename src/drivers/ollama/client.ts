/**
 * client.ts — the Ollama wire layer, on Ollama's own `/api/chat`.
 *
 * Not the OpenAI-compatible endpoint Ollama also serves, although every other local-first client
 * reaches for it first, because on that endpoint two things this agent needs are measured not to
 * work (Ollama 0.35):
 *   - the context window cannot be set. The model loads with Ollama's default of 4,096 tokens and
 *     a longer prompt is cut to fit, silently: a 6,000-word prompt arrived as 2,050 tokens. An
 *     agent's instructions and tools come close to that on their own.
 *   - thinking cannot be turned off. `think: false` is ignored, so Standard still thinks.
 * `/api/chat` takes both (`options.num_ctx`, `think`), and its request is the same messages and
 * tools, so the conversation is rendered exactly as for every other provider (`renderMessages`)
 * and only reshaped at the end.
 */
import type {
  ChatMessage,
  ModelConfig,
  ModelRequest,
  StreamEvent,
  StreamOptions,
  StreamResult,
  ToolCall,
  Turn,
  TurnOptions,
  Usage,
} from "../types.js";
import { ProviderHttpError, renderMessages, toStop, type CompatProvider } from "../openaiCompat/wire.js";
import { salvagePartialTurn } from "../partialTurn.js";
import { isAbortLike } from "../retryPolicy.js";
import { clientId } from "../clientId.js";
import { manifestForModel } from "../registry.js";
import { baseUrl } from "./endpoint.js";
import { BUFFERED_OUTPUT_TOKENS, localWindow, wireId } from "./manifest.js";

/** For the shared stop-reason and error vocabulary only; this driver does not use the OpenAI wire. */
const AS_PROVIDER = { label: "Ollama" } as CompatProvider;

/** One message in `/api/chat`'s shape. */
interface NativeMessage {
  role: string;
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

/** Tool arguments are a JSON string everywhere else; `/api/chat` wants the object. */
function argsObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The shared rendering, reshaped: images as bare base64, tool calls with object arguments, and a
 * tool result carrying the name of the tool it answers (Ollama matches results by name, not id).
 */
export function toNativeMessages(messages: ChatMessage[]): NativeMessage[] {
  const names = new Map<string, string>();
  return messages.map((m) => {
    const out: NativeMessage = { role: m.role, content: m.content };
    if (m.images?.length) out.images = m.images.map((i) => i.data);
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c) => {
        names.set(c.id, c.function.name);
        return { function: { name: c.function.name, arguments: argsObject(c.function.arguments) } };
      });
    }
    if (m.role === "tool" && m.tool_call_id && names.has(m.tool_call_id)) out.tool_name = names.get(m.tool_call_id)!;
    return out;
  });
}

/** Whether the chosen model has a thinking switch at all (from what discovery reported). */
function canThink(config: ModelConfig | undefined): boolean {
  return !!config && manifestForModel(config.model).thinkLevels(config.model).some((l) => l.thinking);
}

export function buildRequest(req: ModelRequest, stream: boolean, maxTokens?: number): Record<string, unknown> {
  const model = req.model?.model ?? "";
  const window = manifestForModel(model).contextWindow(model) || localWindow();
  const body: Record<string, unknown> = {
    model: wireId(model),
    messages: toNativeMessages(renderMessages(req)),
    stream,
    // Every request states its window: otherwise Ollama's default applies and the rest is cut.
    options: { num_ctx: window, ...(maxTokens ? { num_predict: maxTokens } : {}) },
  };
  // Stated either way for a model that has the switch: one that thinks by default (Qwen3) would
  // otherwise think on every turn the user chose Standard for.
  if (canThink(req.model)) body.think = req.model?.thinking === true;
  if (req.tools?.length) body.tools = req.tools;
  return body;
}

/** One line of the reply (streamed or whole). */
interface NativeChunk {
  message?: NativeMessage & { tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function toUsage(chunk: NativeChunk): Usage {
  const promptTokens = chunk.prompt_eval_count ?? 0;
  const completionTokens = chunk.eval_count ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitTokens: 0,
    cacheMissTokens: promptTokens,
  };
}

function toToolCall(c: { id?: string; function: { name: string; arguments: unknown } }, index: number): ToolCall {
  const args = c.function.arguments;
  return {
    id: c.id || `call_${index}`,
    name: c.function.name,
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  };
}

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": clientId() },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ProviderHttpError(response.status, detail, "Ollama", response.statusText);
  }
  return response;
}

/** Each JSON line of a streamed reply (Ollama streams newline-delimited JSON, not SSE). */
async function* jsonLines(response: Response): AsyncGenerator<NativeChunk> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(piece, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as NativeChunk;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as NativeChunk;
}

export async function toolTurn(req: ModelRequest, options: TurnOptions = {}): Promise<Turn> {
  const response = await post(buildRequest(req, false, BUFFERED_OUTPUT_TOKENS), options.signal);
  const chunk = (await response.json()) as NativeChunk;
  if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
  return {
    content: chunk.message?.content ?? "",
    toolCalls: (chunk.message?.tool_calls ?? []).map(toToolCall),
    stop: toStop(AS_PROVIDER, chunk.done_reason),
    usage: toUsage(chunk),
  };
}

export async function streamTurn(req: ModelRequest, options: StreamOptions = {}): Promise<StreamResult> {
  const onEvent: (e: StreamEvent) => void = options.onEvent ?? (() => {});
  const response = await post(buildRequest(req, true), options.signal);
  let content = "";
  const calls: ToolCall[] = [];
  let usage: Usage | undefined;
  let reason: string | undefined;
  try {
    for await (const chunk of jsonLines(response)) {
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const m = chunk.message;
      if (m?.thinking) onEvent({ type: "reasoning", delta: m.thinking });
      if (m?.content) {
        content += m.content;
        onEvent({ type: "text", delta: m.content });
      }
      // Ollama sends each tool call whole, in one line, rather than in fragments.
      for (const c of m?.tool_calls ?? []) {
        const call = toToolCall(c, calls.length);
        onEvent({ type: "tool_start", index: calls.length, id: call.id, name: call.name });
        onEvent({ type: "tool_args", index: calls.length, delta: call.arguments });
        calls.push(call);
      }
      if (chunk.done) {
        reason = chunk.done_reason;
        usage = toUsage(chunk);
      }
    }
  } catch (error) {
    if (isAbortLike(error)) throw error;
    return salvagePartialTurn(content, error);
  }
  return { content, toolCalls: calls, usage, stop: toStop(AS_PROVIDER, reason) };
}
