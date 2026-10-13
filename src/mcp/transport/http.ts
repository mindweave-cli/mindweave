/**
 * http.ts — MCP over Streamable HTTP.
 *
 * The remote transport, and the one 2026-07-28 changed most. What it is NOT, any more:
 *
 *  - No session. The `Mcp-Session-Id` header is gone; there is nothing to establish,
 *    echo back, or re-establish on a 404. Each POST stands alone.
 *  - No GET channel. Server-to-client notifications moved to an explicit
 *    `subscriptions/listen` stream, which is a POST like everything else.
 *  - No resumability. SSE event ids and `Last-Event-ID` were removed. A broken stream
 *    LOSES the in-flight request, and the spec says to re-issue it as a new request
 *    with a new id. So we do not try to reconnect mid-request and pretend nothing
 *    happened; we fail it and let the caller decide.
 *
 * What remains is refreshingly plain: POST a JSON-RPC frame, get back either a single
 * JSON body or an SSE stream, and read the response for THIS request off that stream.
 * The server chooses which; the client says it accepts both.
 *
 * HTTP+SSE (the old two-endpoint transport) is deliberately not implemented. It was
 * deprecated in 2025-03-26 and its sunset has already passed.
 */
import { META_PROTOCOL_VERSION } from "../protocol.js";
import { encodeHeaderValue } from "./headerValue.js";
import { CANCELLED, DEFAULT_REQUEST_TIMEOUT_MS, RpcError, type Notification, type Transport } from "./types.js";

export { encodeHeaderValue };

export interface HttpOptions {
  url: string;
  headers?: Record<string, string>;
  /**
   * Headers resolved FRESH on every request, merged over the static ones.
   *
   * This is where an OAuth token arrives, and it cannot be a static header: an access
   * token expires mid-session and is replaced by a refresh, so a value captured when the
   * transport was built would be correct for an hour and then 401 forever. Async because
   * producing one may mean spending a refresh token first.
   *
   * Kept separate from `headers` rather than replacing it: the configured headers are the
   * user's (an API key, a tenant id) and must not be recomputed or lost.
   */
  authHeaders?: () => Promise<Record<string, string>>;
  /**
   * Told what a 401's `WWW-Authenticate` said, whenever one arrives.
   *
   * The header names the metadata document that the whole authorization flow starts from,
   * and it is only ever sent with the rejection itself — by the time a person clicks
   * "Sign in" the response is long gone. So it is captured here, at the only moment it
   * exists, and remembered by the connection.
   */
  onAuthChallenge?: (header: string) => void;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Parse an SSE body into its `data:` payloads (pure).
 *
 * Events are separated by a blank line and a single event's data may span several
 * `data:` lines, which are joined with a newline. We deliberately ignore `id:` fields:
 * they exist in older streams, but resumability was removed and honouring them would
 * imply a redelivery guarantee the protocol no longer makes.
 */
export function parseSseEvents(body: string): string[] {
  const out: string[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) out.push(data);
  }
  return out;
}

/**
 * Pick the JSON-RPC message answering `id` out of a decoded body (pure).
 *
 * A response stream can carry progress notifications and log messages alongside the
 * actual result, so "the last message" is not good enough — matching on the id is what
 * stops a progress notification being mistaken for a result.
 */
export function findResponse(messages: unknown[], id: number): { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } } | null {
  for (const msg of messages) {
    const m = msg as { id?: unknown; result?: unknown; error?: unknown } | null;
    if (m && typeof m === "object" && m.id === id && ("result" in m || "error" in m)) {
      return m as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    }
  }
  return null;
}

/**
 * Incrementally pull complete SSE events out of a growing buffer (pure).
 *
 * `parseSseEvents` is fine for a body that has finished arriving. A subscription stream
 * never finishes, so it has to be consumed as it goes: this returns whatever whole
 * events are already present and the partial tail still waiting for its blank line.
 */
export function drainSseEvents(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  // The final segment has not been terminated by a blank line yet, so it may be half
  // an event. Everything before it is complete.
  const rest = parts.pop() ?? "";
  const events: string[] = [];
  for (const block of parts) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) events.push(data);
  }
  return { events, rest };
}

/**
 * The metadata headers Streamable HTTP mirrors out of the body so that intermediaries
 * can route and inspect a request without parsing it (2026-07-28).
 *
 * A conforming server checks every one of these against the body and MUST answer a
 * mismatch, or a missing required header, with 400 and `-32020 HeaderMismatch`. That
 * cuts both ways, and both directions are load-bearing here: `Mcp-Name` carries
 * `params.name` or `params.uri` — never the method, which would disagree with the body
 * on every single `tools/call` — and it is omitted outright when the request has no
 * target rather than being padded with something that cannot match.
 *
 * The body stays the source of truth, which is why the protocol version is read back out
 * of `_meta` rather than passed in alongside it. Two sources drift; one cannot.
 */
export function metadataHeaders(method: string, params?: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = { "mcp-method": method };

  // `tools/call` and `prompts/get` name their target; `resources/read` addresses one by
  // uri. Deriving from the value rather than from a list of methods covers those three
  // and stays correct for anything later that mirrors a target the same way.
  const target = params?.name ?? params?.uri;
  if (typeof target === "string") headers["mcp-name"] = encodeHeaderValue(target);

  const meta = params?._meta as Record<string, unknown> | undefined;
  const version = meta?.[META_PROTOCOL_VERSION];
  // Absent on the handshake dialect, where the version was agreed once in `initialize`
  // and there is no `_meta` to mirror. Asserting a version we did not take from the body
  // would manufacture the very disagreement this header exists to prevent.
  if (typeof version === "string") headers["mcp-protocol-version"] = version;

  return headers;
}

export class HttpTransport implements Transport {
  private nextId = 1;
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private notificationHandler: ((notification: Notification) => void) | null = null;
  private readonly streams = new Set<AbortController>();
  private resolveClosed!: () => void;
  readonly closed: Promise<void>;

  constructor(private readonly options: HttpOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  /** The configured headers with any live credential merged over them. Resolved per
   *  request; a failure to produce one is not fatal, because a request WITHOUT a token is
   *  exactly how a server gets the chance to tell us it wants one. */
  private async liveHeaders(): Promise<Record<string, string>> {
    const base = this.options.headers ?? {};
    if (!this.options.authHeaders) return base;
    try {
      return { ...base, ...(await this.options.authHeaders()) };
    } catch {
      return base;
    }
  }

  /** Remember what a rejection said about how to authorize, before the response is gone. */
  private noteChallenge(response: Response): void {
    if (response.status !== 401 && response.status !== 403) return;
    const header = response.headers.get("www-authenticate");
    if (header) this.options.onAuthChallenge?.(header);
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    mirrored?: Record<string, string>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed) throw new RpcError(-32603, "mcp transport is closed");
    if (signal?.aborted) throw new RpcError(CANCELLED, `mcp request cancelled: ${method}`);
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
    const limit = timeoutMs ?? this.timeoutMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();

    let response: Response;
    try {
      const configured = await this.liveHeaders();
      response = await this.fetchImpl(this.options.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          // The client says it takes either shape; the SERVER picks. A single result
          // comes back as JSON, a long-running call upgrades to a stream.
          accept: "application/json, text/event-stream",
          ...configured,
          // Mirrored last, so configuration cannot overwrite them. These are not
          // settings — they are a restatement of the body, checked against it by the
          // server, and a configured header that disagreed would earn a -32020 on every
          // call with no way for the user to see why.
          ...metadataHeaders(method, params),
          ...(mirrored ?? {}),
        },
        body: JSON.stringify(message),
      });
    } catch (error) {
      if (signal?.aborted) throw new RpcError(CANCELLED, `mcp request cancelled: ${method}`);
      const reason = controller.signal.aborted ? `timeout after ${limit}ms` : String((error as Error)?.message ?? error);
      throw new RpcError(-32603, `mcp request failed: ${method}: ${reason}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!response.ok) {
      // 401/403 are the auth signal the connection layer turns into `needs-auth`
      // rather than `failed`, so the code has to survive as more than a message.
      this.noteChallenge(response);
      throw new RpcError(httpErrorCode(response.status), `mcp http ${response.status} ${response.statusText || ""}`.trim());
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const messages = contentType.includes("text/event-stream")
      ? parseSseEvents(body).map(safeParse)
      : [safeParse(body)];

    const answer = findResponse(messages.filter((m) => m !== undefined), id);
    if (!answer) {
      // A stream that ended without answering is exactly the "broken response stream"
      // case: the spec's remedy is a NEW request, not a resume, so we surface it.
      throw new RpcError(-32603, `mcp response stream ended without a result for ${method}`);
    }
    if (answer.error) {
      const code = typeof answer.error.code === "number" ? answer.error.code : -32603;
      const msg = typeof answer.error.message === "string" ? answer.error.message : "mcp error";
      throw new RpcError(code, msg, answer.error.data);
    }
    return answer.result;
  }

  /** Notifications have no id and no reply, so failure is not actionable. */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) return;
    void this.liveHeaders()
      .then((configured) =>
        this.fetchImpl(this.options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...metadataHeaders(method, params),
            ...configured,
          },
          body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
        }),
      )
      .catch(() => {
        /* nothing awaits a notification */
      });
  }

  onNotification(handler: (notification: Notification) => void): void {
    this.notificationHandler = handler;
  }

  /**
   * Open a long-lived response stream and pump notifications off it until it ends.
   *
   * This is how `subscriptions/listen` works after 2026-07-28 removed the GET endpoint:
   * one POST whose response never completes. It cannot go through `request()`, which
   * buffers the whole body and would therefore wait forever.
   *
   * Resolves once the stream is ESTABLISHED, not when it ends — the caller wants to know
   * the subscription took, and then get on with its life. There is no resumability, so a
   * stream that drops is simply over; reviving it is the connection layer's business.
   */
  async openStream(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this.disposed) throw new RpcError(-32603, "mcp transport is closed");
    const controller = new AbortController();
    this.streams.add(controller);

    const streamHeaders = await this.liveHeaders();
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...metadataHeaders(method, params),
        ...streamHeaders,
      },
      // No id: nothing resolves this, and a stream is not a request/response pair.
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, ...(params ? { params } : {}) }),
    }).catch((error: unknown) => {
      this.streams.delete(controller);
      throw new RpcError(-32603, `mcp subscription failed: ${String((error as Error)?.message ?? error)}`);
    });

    if (!response.ok) {
      this.streams.delete(controller);
      this.noteChallenge(response);
      throw new RpcError(httpErrorCode(response.status), `mcp http ${response.status} on ${method}`);
    }

    const body = response.body;
    if (!body) {
      this.streams.delete(controller);
      throw new RpcError(-32603, `mcp subscription returned no stream for ${method}`);
    }

    // Pump in the background. Deliberately not awaited: the subscription is live from
    // here on, and awaiting it would block the caller until the server goes away.
    void this.pump(body, controller);
  }

  private async pump(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = drainSseEvents(buffer);
        buffer = rest;
        for (const event of events) {
          const msg = safeParse(event) as { method?: unknown; params?: unknown } | undefined;
          // Only server-initiated messages matter here; anything with an id on this
          // stream is not something we are waiting on.
          if (msg && typeof msg.method === "string" && this.notificationHandler) {
            this.notificationHandler({
              method: msg.method,
              ...(msg.params && typeof msg.params === "object" ? { params: msg.params as Record<string, unknown> } : {}),
            });
          }
        }
      }
    } catch {
      // A dropped stream is not recoverable at this layer: resumability was removed, so
      // there is nothing to resume. The connection layer decides whether to re-subscribe.
    } finally {
      this.streams.delete(controller);
      reader.releaseLock?.();
    }
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Long-lived subscription streams would otherwise hold the process open.
    for (const controller of this.streams) controller.abort();
    this.streams.clear();
    // No DELETE and no session teardown: there is no server-side session to end.
    this.resolveClosed();
  }
}

/** Map an HTTP status onto a JSON-RPC-ish code the connection layer can classify. */
export function httpErrorCode(status: number): number {
  if (status === 401 || status === 403) return -32001; // auth: implementation-defined range
  if (status === 404) return -32601; // no such endpoint reads as no such method
  return -32603;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
