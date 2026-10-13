/**
 * types.ts — the one thing every MCP transport has to be.
 *
 * MCP runs over a local child process (stdio) or over HTTP (Streamable HTTP). Those are
 * genuinely different animals: one is a pipe you own the lifecycle of, the other is a
 * request/response with streaming bodies and no session. Everything above this file
 * should not care which it got, so the difference stops here.
 *
 * Kept to request/notify/close on purpose. MCP's server-to-client traffic used to need
 * more surface, but 2026-07-28 removed `ping`, removed the HTTP GET channel, and moved
 * change notifications onto an explicit `subscriptions/listen` stream — so a transport
 * no longer needs a general inbound-message channel just to stay alive.
 */

/** A JSON-RPC error surfaced by a transport, carrying the code so callers can classify it. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** The code a request is rejected with when its caller aborted it. */
export const CANCELLED = -32800;

/** A server-initiated message: no id, so nothing is waiting on it. */
export interface Notification {
  method: string;
  params?: Record<string, unknown>;
}

export interface Transport {
  /**
   * Send a request and resolve with its `result`, or reject with `RpcError`.
   *
   * `headers` carries values the caller has already mirrored out of `params` — today the
   * `Mcp-Param-*` set a server asked for via `x-mcp-header`. It is a hint, not a
   * contract: a transport with no headers to speak of ignores it, which is exactly what
   * the spec permits a non-HTTP client to do with those annotations.
   */
  request(
    method: string,
    params?: Record<string, unknown>,
    headers?: Record<string, string>,
    /** Overrides the default limit for THIS request. A tool call can legitimately run for
     *  minutes (a disassembler analysing a binary); the 30s default is for the protocol's
     *  own bookkeeping, where a silent server should be given up on quickly. */
    timeoutMs?: number,
    /** Aborting it abandons THIS request: the caller gets a rejection at once and the
     *  server is told to stop (`notifications/cancelled`). It is how Esc reaches a tool
     *  call that is minutes into slow work. */
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Fire-and-forget notification (no id, no reply). */
  notify(method: string, params?: Record<string, unknown>): void;
  /** Release the underlying resource. Idempotent.
   *  `sync` asks for a blocking kill, required when closing from a process-exit
   *  handler; transports with nothing to reap may ignore it. */
  close(sync?: boolean): Promise<void>;
  /** Resolves when the transport dies on its own (process exit, socket close). */
  readonly closed: Promise<void>;

  /**
   * Receive server-initiated messages.
   *
   * On stdio these simply arrive on the pipe. On HTTP there is no inbound channel at
   * all any more — 2026-07-28 deleted the GET endpoint — so they only arrive on the
   * response stream of a `subscriptions/listen` request, which is why that has to be
   * opened explicitly rather than being implied by connecting.
   */
  onNotification(handler: (notification: Notification) => void): void;

  /**
   * Open a long-lived request whose response stream stays open, delivering
   * notifications through `onNotification` until it ends or `close()` is called.
   * Optional: stdio has no need for it, since its pipe is already long-lived.
   */
  openStream?(method: string, params?: Record<string, unknown>): Promise<void>;
}

/** How long a single request may take before we give up on it. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long one TOOL call may take. Deliberately far above the protocol default: the 30s
 * limit is right for `tools/list` and `server/discover`, and wrong for a tool whose whole
 * job is slow work (analysing a binary, running a query, a long build). Cutting those off
 * at 30s made every slow-but-working tool look broken. Overridable for a server that
 * really does hang: MINDWEAVE_MCP_TOOL_TIMEOUT_MS.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60_000;

export function toolTimeoutMs(): number {
  const raw = Number(process.env.MINDWEAVE_MCP_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_TOOL_TIMEOUT_MS;
}
