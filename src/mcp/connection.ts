/**
 * connection.ts — one MCP server, and what state it is in.
 *
 * The previous implementation had no notion of state: a server was in a map or it was
 * not. That makes three ordinary situations indistinguishable — still starting, failed
 * to start, and waiting on the user to authenticate — so nothing could report anything
 * useful and a dead server stayed dead for the session.
 *
 * So a connection is a small state machine:
 *
 *   pending ──► connected ──► (dies) ──► pending ──► …
 *      │                                    │
 *      ├──► failed          (cap reached) ◄─┘
 *      └──► needs-auth
 *
 * `needs-auth` is deliberately separate from `failed`. A 401 is not a broken server, it
 * is a server waiting on the user, and collapsing the two would make the eventual auth
 * flow look like an outage.
 *
 * Reconnection is capped at 3 consecutive failures, the same number used by the
 * repeat-failure breaker in the engine. Past the cap we STOP and surface the state
 * rather than retrying forever: a server that cannot start will not start on the
 * fourth try, and quietly burning attempts is how a session ends up slow for a reason
 * the user cannot see. `/mcp` can always retry by hand.
 */
import { appVersion } from "../cli/version.js";
import { capDescription, parseToolList, type McpToolDef } from "./catalog.js";
import { paramHeaders } from "./paramHeaders.js";
import type { McpServerConfig } from "./config.js";
import { probe, UnsupportedProtocolVersionError, type Negotiated } from "./discover.js";
import { buildMeta, DEFAULT_CLIENT_CAPABILITIES, cacheDirectiveOf, readInputRequired, type CacheDirective } from "./protocol.js";
import { hasPrompts, parsePromptList, type McpPrompt } from "./prompts.js";
import {
  hasResources,
  parseResourceList,
  parseResourceRead,
  parseTemplateList,
  type McpResource,
  type McpResourceTemplate,
} from "./resources.js";
import type { McpContentBlock } from "./catalog.js";
import { authenticate, authHeaders, hasCredential, parseWwwAuthenticate, signOut, type AuthChallenge } from "./oauth/index.js";
import { HttpTransport } from "./transport/http.js";
import { StdioTransport } from "./transport/stdio.js";
import { RpcError, toolTimeoutMs, type Transport } from "./transport/types.js";
import { isPromptsChanged, isResourcesChanged, isToolsChanged, subscriptionsFor } from "./subscriptions.js";

/** Consecutive failed connect attempts before we stop trying on our own. */
export const MAX_CONNECT_ATTEMPTS = 3;

/**
 * Backoff between automatic reconnects, in ms.
 *
 * Deliberately short and deliberately finite. A server that dies mid-session is usually
 * a crash or a restart, and getting it back within a few seconds is the difference
 * between a blip and losing its tools for the rest of the session. But retrying forever
 * is the pattern the repeat-failure breaker exists to prevent: a server that will not
 * come back does not come back on the tenth attempt either, and quietly burning them is
 * how a session gets slow for a reason the user cannot see. After the last one we stop
 * and say so; `/mcp` can always retry by hand.
 */
export const RECONNECT_BACKOFF_MS = [1_000, 4_000, 10_000];

/**
 * How many extra round trips one MRTR call may take before we give up.
 *
 * A server is explicitly allowed to keep answering `input_required` "if they want to
 * repeatedly prompt the user for information until they have what they need", so nothing
 * on the server side ever has to stop. Terminating is therefore the client's job. Four
 * is well past any ordinary exchange (which is one, occasionally two) and small enough
 * that a server looping on us costs a moment rather than a session.
 */
export const MAX_INPUT_ROUNDS = 4;

export type ConnectionState = "pending" | "connected" | "failed" | "needs-auth" | "disabled";

/** Everything the UI and the pool need to know about one server. */
export interface ConnectionStatus {
  name: string;
  /** Which transport this server uses. Surfaced because only an http server can be signed
   *  in to: a local command server has no authorization server to send anyone to, so the
   *  manage screen must be able to tell the two apart without reaching for the config. */
  type: McpServerConfig["type"];
  state: ConnectionState;
  toolCount: number;
  /** Prompts this server offers as slash commands (the user's half of MCP). */
  promptCount: number;
  /** Whether it exposes readable resources, which have no count until they are listed. */
  offersResources: boolean;
  /** Why it is failed, when it is. */
  error?: string;
  /** Negotiated protocol revision, once connected. */
  version?: string;
  /** True when we reached the server through the legacy `initialize` path. */
  legacy?: boolean;
  serverInfo?: { name: string; version?: string };
  attempts: number;
}

/** Is this error the server telling us it wants credentials? */
export function isAuthError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === "number" && e.code === -32001) return true;
  return typeof e?.message === "string" && /\b401\b|\b403\b|unauthor|forbidden/i.test(e.message);
}

export class McpConnection {
  private transport: Transport | null = null;
  private negotiated: Negotiated | null = null;
  private toolDefs: McpToolDef[] = [];
  /** Tools dropped from the last catalog load, with the reason. Drained by the manager
   *  into user-facing notices — a tool that silently does not exist is the failure mode
   *  quarantine already taught us to avoid. */
  private toolWarnings: string[] = [];
  private promptDefs: McpPrompt[] = [];
  private resourceDefs: McpResource[] = [];
  private templateDefs: McpResourceTemplate[] = [];
  private cache: CacheDirective = {};
  private toolsFetchedAt = 0;
  /** When the resource listing was last fetched (0 = never). Resources are loaded lazily,
   *  so this is the only thing standing between a curious model and a refetch per call. */
  private resourcesFetchedAt = 0;
  private resourceCache: CacheDirective = {};
  private state: ConnectionState;
  private lastError = "";
  private attempts = 0;
  private connecting: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private onChange: (() => void) | null = null;
  /**
   * What the last 401 said about authorizing, if anything.
   *
   * Held on the connection rather than thrown with the error because the two moments are
   * far apart: the header exists only on the rejected response, and the person who acts
   * on it does so minutes later by choosing "Sign in". Empty is normal and usable — the
   * flow falls back to the well-known locations when the server named none.
   */
  private challenge: AuthChallenge = {};

  constructor(readonly config: McpServerConfig) {
    this.state = config.disabled ? "disabled" : "pending";
  }

  /** Told whenever this server's state or catalog moves, so the UI can repaint. */
  setOnChange(handler: (() => void) | null): void {
    this.onChange = handler;
  }

  private changed(): void {
    this.onChange?.();
  }

  status(): ConnectionStatus {
    return {
      name: this.config.name,
      type: this.config.type,
      state: this.state,
      toolCount: this.toolDefs.length,
      promptCount: this.promptDefs.length,
      offersResources: this.offersResources(),
      attempts: this.attempts,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(this.negotiated ? { version: this.negotiated.version, legacy: this.negotiated.legacy } : {}),
      ...(this.negotiated?.serverInfo ? { serverInfo: this.negotiated.serverInfo } : {}),
    };
  }

  tools(): readonly McpToolDef[] {
    return this.toolDefs;
  }

  /** What the server said at the handshake about how to use it, under the same cap as a tool description. */
  instructions(): string {
    return capDescription(this.negotiated?.instructions ?? "");
  }

  /** This server's prompts, fetched at connect (they have to exist before the command
   *  list is rendered, and there is no way to discover them lazily from a keystroke). */
  prompts(): readonly McpPrompt[] {
    return this.promptDefs;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  /**
   * Connect, handshake or discover, and load the tool catalog.
   *
   * Concurrent callers share one attempt: the pool starts every server in parallel and
   * a `/mcp` retry can land on top of that, and two transports for one server would
   * leak a child process.
   */
  async connect(): Promise<void> {
    if (this.state === "disabled") return;
    if (this.state === "connected") return;
    if (this.connecting) return this.connecting;
    if (this.attempts >= MAX_CONNECT_ATTEMPTS && this.state !== "pending") return;
    this.connecting = this.attempt().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * Sign in to this server, then connect with the token that produced.
   *
   * Only ever called because a person asked. The flow opens a browser and holds a local
   * port, which is not something a background retry may do on its own — a window
   * appearing for a server the user forgot they configured is worse than a row that says
   * it needs signing in and waits.
   */
  async authenticate(options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {}): Promise<void> {
    await authenticate({
      name: this.config.name,
      config: this.config,
      challenge: this.challenge,
      ...(options.onUrl ? { onUrl: options.onUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await this.reconnect();
  }

  /** Forget this server's token. The connection is left alone: it will keep working until
   *  the current request fails, and the next 401 puts it back to `needs-auth` honestly. */
  async signOut(): Promise<void> {
    await signOut(this.config.name, this.config);
    this.challenge = {};
  }

  /** Whether a credential is stored, so the manage screen can offer "Sign out" rather
   *  than a second "Sign in". */
  async hasCredential(): Promise<boolean> {
    return hasCredential(this.config.name, this.config);
  }

  /** Force a retry even past the cap — what `/mcp` reconnect does. */
  async reconnect(): Promise<void> {
    this.clearRetry();
    await this.closeTransport();
    this.closed = false;
    this.attempts = 0;
    this.state = this.config.disabled ? "disabled" : "pending";
    this.lastError = "";
    await this.connect();
  }

  private async attempt(): Promise<void> {
    this.attempts++;
    this.state = "pending";
    try {
      const transport = this.open();
      this.transport = transport;
      // If the server dies later, drop back to pending so a future call can revive it
      // instead of dispatching into a corpse.
      void transport.closed.then(() => {
        if (this.transport === transport) this.onDied();
      });

      const identity = { name: "mindweave", version: appVersion() };
      this.negotiated = await probe(
        {
          request: (method, params) => this.raw(transport, method, params),
          notify: (method, params) => transport.notify(method, params),
        },
        identity,
        DEFAULT_CLIENT_CAPABILITIES,
      );

      await this.loadTools();
      // Prompts are eager, resources are not, and the difference is deliberate. A prompt
      // has to exist before the user presses `/`, so there is no lazy moment to fetch it
      // in. A resource listing is only ever wanted when the model goes looking, and
      // fetching every server's on connect would slow every session down for a feature
      // most projects never touch.
      await this.loadPrompts();
      transport.onNotification((note) => this.onNotify(note));
      await this.subscribe(transport);
      this.state = "connected";
      this.lastError = "";
      this.attempts = 0; // a success clears the budget for the next outage
      this.changed();
    } catch (error) {
      await this.closeTransport();
      this.lastError = describeError(error);
      // A server asking for credentials is waiting on the user, not broken — and
      // retrying cannot help, so it does not consume the attempt budget's meaning.
      this.state = isAuthError(error) ? "needs-auth" : "failed";
      this.changed();
    }
  }

  /**
   * Opt into the change notifications we can actually act on.
   *
   * Best-effort by design: a server that does not support `subscriptions/listen` (every
   * pre-2026 one) or refuses the request is still perfectly usable. Letting a failed
   * subscription fail the whole connection would drop most servers in existence for the
   * sake of an optimization.
   *
   * Be precise about what is lost, because an earlier version of this comment was not:
   * there is NO periodic refresh. `ttlMs` is only ever read as permission to SKIP a
   * refetch, never as a timer, so nothing polls. Without a subscription the catalog moves
   * only when the server pushes `notifications/tools/list_changed` on its own (which
   * stdio servers do regardless of dialect, and many pre-2026 ones send) or when the user
   * reconnects it from `/mcp`. A poller is deliberately not built: it would re-fetch every
   * server on a timer to catch a case the push path already covers, and each refresh that
   * did find a change would cost a prompt-cache prefix.
   */
  private async subscribe(transport: Transport): Promise<void> {
    if (!this.negotiated || this.negotiated.dialect !== "stateless") return;
    const types = subscriptionsFor(this.negotiated.capabilities);
    if (types.length === 0) return;
    try {
      if (transport.openStream) await transport.openStream("subscriptions/listen", { types });
      else await this.call("subscriptions/listen", { types });
    } catch {
      // No subscription. The catalog is then whatever the server pushes unprompted, or
      // what a `/mcp` reconnect fetches — see above.
    }
  }

  /** A server telling us one of its lists moved. */
  private onNotify(note: { method: string }): void {
    // Force past the TTL in every case: the server just told us the cached answer is wrong.
    const refresh = isToolsChanged(note.method)
      ? this.loadTools(true)
      : isPromptsChanged(note.method)
        ? this.loadPrompts()
        : isResourcesChanged(note.method)
          ? this.loadResources(true)
          : null;
    if (!refresh) return;
    void refresh
      .then(() => this.changed())
      .catch(() => {
        // A refresh that fails leaves the previous list in place, which is strictly
        // better than dropping it because one notification could not be served.
      });
  }

  private open(): Transport {
    if (this.config.type === "http") {
      return new HttpTransport({
        url: this.config.url,
        ...(this.config.headers ? { headers: this.config.headers } : {}),
        // A stored OAuth token, refreshed if it has gone stale, resolved per request. No
        // credential yields no header, which is how an unauthenticated call earns the
        // 401 that tells us what to sign in to.
        authHeaders: () => authHeaders(this.config.name, this.config),
        onAuthChallenge: (header) => {
          this.challenge = parseWwwAuthenticate(header);
        },
      });
    }
    return new StdioTransport({
      command: this.config.command,
      args: this.config.args,
      ...(this.config.env ? { env: this.config.env } : {}),
    });
  }

  /** A request that has NOT yet negotiated a dialect (the probe itself). */
  private raw(transport: Transport, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return transport.request(method, params);
  }

  /**
   * A request on the negotiated dialect: `_meta` is attached on stateless servers and
   * omitted on handshake ones, where it would be an unknown field.
   */
  /**
   * A call that may take several round trips (MRTR, 2026-07-28).
   *
   * A server that cannot finish in one go does not hold a connection open and does not
   * ask us a question over a side channel — both of those are gone. It returns
   * `resultType: "input_required"` with an opaque `requestState`, and the client calls
   * again, echoing that state back. Each attempt is a genuinely independent request with
   * its own id; nothing on this side is resumed.
   *
   * Two rules of the echo are easy to get subtly wrong, so they are explicit below: the
   * state is whatever THIS round returned, never a value carried over from an earlier
   * one, and a round that returns no state must be retried with no state rather than
   * with the last one we happened to hold.
   *
   * We answer no `inputRequests`, and that is a consequence of declaring no elicitation
   * capability rather than an omission here — a conforming server is forbidden from
   * sending them (see `ClientCapabilities`). If one arrives anyway we fail the call and
   * say what was asked for. Returning the half-finished result instead, which is what
   * happened before this existed, told the model the tool had answered.
   */
  private async callMultiRound(
    method: string,
    params: Record<string, unknown>,
    mirrored?: Record<string, string>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let requestState: string | undefined;
    for (let round = 0; round <= MAX_INPUT_ROUNDS; round++) {
      const body = requestState === undefined ? params : { ...params, requestState };
      const result = await this.call(method, body, mirrored, timeoutMs, signal);
      const pending = readInputRequired(result);
      if (!pending) return result;

      const asked = Object.values(pending.inputRequests).map((r) => r.method);
      if (asked.length > 0) {
        throw new RpcError(
          -32603,
          `mcp server '${this.config.name}' asked for input this client cannot provide (${[...new Set(asked)].join(", ")}). ` +
            `Mindweave declares no elicitation capability, so a conforming server should not have requested it.`,
        );
      }
      requestState = pending.requestState;
    }
    // A server MAY ask again on every attempt, so terminating is our job, not its own.
    throw new RpcError(
      -32603,
      `mcp server '${this.config.name}' still needed more input after ${MAX_INPUT_ROUNDS + 1} attempts at ${method}`,
    );
  }

  private async call(
    method: string,
    params?: Record<string, unknown>,
    mirrored?: Record<string, string>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.transport || !this.negotiated) throw new RpcError(-32603, this.notRunningMessage());
    const meta = buildMeta(this.negotiated.dialect, this.negotiated.version, { name: "mindweave", version: appVersion() });
    const body = meta ? { ...(params ?? {}), _meta: meta } : params;
    return this.transport.request(method, body, mirrored, timeoutMs, signal);
  }

  /**
   * Why a call cannot go out, in words that say what to do.
   *
   * "is not connected" alone sent an agent into a loop of disabling and re-enabling a
   * server: it said nothing about the state, the reason, or that the way out was a
   * status check and a reconnect rather than a rewrite of the config.
   */
  notRunningMessage(): string {
    const name = this.config.name;
    if (this.state === "disabled") return `mcp server '${name}' is disabled. Enable it with mcp_server action "enable".`;
    if (this.state === "needs-auth") return `mcp server '${name}' needs signing in. The user does that in /mcp (open the server, choose Sign in).`;
    const why = this.lastError ? `: ${this.lastError}` : "";
    return (
      `mcp server '${name}' is not running (${this.state}${why}). ` +
      `Use mcp_server action "status" to see why, and "reconnect" to start it again; do not disable, enable or remove it.`
    );
  }

  /**
   * Make this connection usable NOW, if it can be. Called by a tool call that finds the
   * server down, so a server that died, or that was still starting, is brought back by
   * the call that needs it instead of failing it.
   *
   * Shares an attempt already in flight (a second transport would leak a child process),
   * cancels a pending automatic retry so it cannot race this one, and never touches a
   * server that is waiting on the user (disabled, needs-auth): those are not outages.
   */
  async ensureConnected(): Promise<void> {
    if (this.state === "connected" || this.state === "disabled" || this.state === "needs-auth") return;
    if (this.connecting) return this.connecting;
    this.clearRetry();
    if (this.state === "failed") return this.reconnect();
    return this.connect();
  }

  /** Fetch (or refresh) the tool catalog, honouring the server's own `ttlMs`. */
  async loadTools(force = false): Promise<void> {
    if (!force && this.toolsFetchedAt && this.cache.ttlMs !== undefined) {
      if (Date.now() - this.toolsFetchedAt < this.cache.ttlMs) return; // still fresh
    }
    const result = await this.call("tools/list");
    this.toolDefs = parseToolList(this.config.name, result, {
      mirrorsHeaders: this.config.type === "http",
      onReject: (tool, reason) => {
        this.toolWarnings.push(`'${this.config.name}' tool '${tool}' was dropped: ${reason}`);
      },
    });
    this.cache = cacheDirectiveOf(result);
    this.toolsFetchedAt = Date.now();
  }

  /**
   * Fetch this server's prompts, if it has any.
   *
   * Best-effort in both directions: a server that does not advertise prompts is not
   * asked, and one that advertises them but fails the call simply has none. A broken
   * `prompts/list` must not cost the user the server's tools, which are the main event.
   */
  async loadPrompts(): Promise<void> {
    if (!this.negotiated || !hasPrompts(this.negotiated.capabilities)) return;
    try {
      this.promptDefs = parsePromptList(this.config.name, await this.call("prompts/list"));
    } catch {
      this.promptDefs = [];
    }
  }

  /** Render one of this server's prompts. Rejects, because the caller is a command the
   *  user just typed and silence would be worse than an error. */
  async getPrompt(name: string, args: Record<string, string>): Promise<unknown> {
    return this.callMultiRound("prompts/get", { name, ...(Object.keys(args).length > 0 ? { arguments: args } : {}) });
  }

  /**
   * Fetch (or refresh) this server's resources and templates.
   *
   * Honours the server's own `ttlMs` the same way the tool catalog does, which matters
   * more here: the model can call the listing tool repeatedly within one turn, and
   * without the cache each call would be two round trips to every server.
   */
  async loadResources(force = false): Promise<void> {
    if (!this.negotiated || !hasResources(this.negotiated.capabilities)) return;
    if (!force && this.resourcesFetchedAt && this.resourceCache.ttlMs !== undefined) {
      if (Date.now() - this.resourcesFetchedAt < this.resourceCache.ttlMs) return;
    }
    try {
      const listed = await this.call("resources/list");
      this.resourceDefs = parseResourceList(this.config.name, listed);
      this.resourceCache = cacheDirectiveOf(listed);
      this.resourcesFetchedAt = Date.now();
    } catch {
      this.resourceDefs = [];
    }
    try {
      // Separate try: templates are optional even for a server that has resources, and a
      // server that has never heard of `resources/templates/list` must not lose its list.
      this.templateDefs = parseTemplateList(this.config.name, await this.call("resources/templates/list"));
    } catch {
      this.templateDefs = [];
    }
  }

  resources(): readonly McpResource[] {
    return this.resourceDefs;
  }

  resourceTemplates(): readonly McpResourceTemplate[] {
    return this.templateDefs;
  }

  /** True when this server declared a resources capability at all. */
  offersResources(): boolean {
    return Boolean(this.negotiated && hasResources(this.negotiated.capabilities));
  }

  /** Read one resource by URI. */
  async readResource(uri: string): Promise<McpContentBlock[]> {
    return parseResourceRead(await this.callMultiRound("resources/read", { uri }));
  }

  /** Invoke a tool on this server.
   *
   *  Any parameter the server annotated with `x-mcp-header` is repeated in the headers.
   *  Not an optimisation: a server MUST reject a call whose annotated value is in the
   *  body but absent from the headers, so a tool with an annotation is simply uncallable
   *  without this. The annotations were validated when the catalog was parsed, which is
   *  why nothing here can fail. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const annotations = this.toolDefs.find((d) => d.name === name)?.paramHeaders;
    const mirrored = annotations?.length ? paramHeaders(annotations, args) : undefined;
    return this.callMultiRound("tools/call", { name, arguments: args }, mirrored, toolTimeoutMs(), signal);
  }

  /** Drain warnings about tools dropped from this server's catalog. One-shot. */
  takeToolWarnings(): string[] {
    const out = this.toolWarnings;
    this.toolWarnings = [];
    return out;
  }

  /**
   * The server went away on its own. Drop the catalog and schedule a revival.
   *
   * Automatic, because the alternative is that a server which crashed once is gone for
   * the rest of the session and the user has no way to know why their tools vanished.
   * Bounded, because a server that cannot come back never does.
   */
  private onDied(): void {
    this.transport = null;
    this.negotiated = null;
    this.toolDefs = [];
    this.promptDefs = [];
    this.resourceDefs = [];
    this.templateDefs = [];
    this.toolsFetchedAt = 0;
    this.resourcesFetchedAt = 0;
    if (this.state === "connected") {
      this.state = "pending";
      this.lastError = "server exited";
      this.attempts = 0; // this is a NEW outage, not a continuation of the last one
      this.scheduleRetry();
    }
    this.changed();
  }

  private scheduleRetry(): void {
    if (this.closed || this.config.disabled) return;
    const delay = RECONNECT_BACKOFF_MS[this.attempts];
    if (delay === undefined) {
      // Out of automatic attempts. Say so plainly rather than sitting in `pending`
      // forever, which reads as "still trying".
      this.state = "failed";
      this.lastError = `${this.lastError || "server exited"} (gave up after ${RECONNECT_BACKOFF_MS.length} reconnect attempts; /mcp to retry)`;
      this.changed();
      return;
    }
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Through `connecting`, like every other attempt: a tool call that arrives while this
      // one is running must join it rather than open a second transport.
      const run = this.attempt().finally(() => {
        if (this.connecting === run) this.connecting = null;
      });
      this.connecting = run;
      void run.then(() => {
        if (this.state !== "connected") this.scheduleRetry();
      });
    }, delay);
    // Never hold the process open just to retry a background server.
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Tear down the transport but keep this connection revivable.
   *  `sync` is forwarded so an exit-handler teardown kills synchronously. */
  private async closeTransport(sync = false): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.negotiated = null;
    this.toolDefs = [];
    this.promptDefs = [];
    this.resourceDefs = [];
    this.templateDefs = [];
    this.toolsFetchedAt = 0;
    this.resourcesFetchedAt = 0;
    if (transport) await transport.close(sync).catch(() => {});
  }

  /**
   * Shut down for good: no more retries, no more tools.
   *
   * `sync` must be set when closing from a process-exit handler. The kill that
   * reaps a shelled server spawns `taskkill`, and an async spawn never reaches
   * the OS during exit, so the server would outlive us.
   */
  async close(sync = false): Promise<void> {
    this.closed = true;
    this.clearRetry();
    await this.closeTransport(sync);
  }
}

function describeError(error: unknown): string {
  if (error instanceof UnsupportedProtocolVersionError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
