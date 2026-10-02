/**
 * manager.ts — the pool of MCP servers, and the only thing the engine talks to.
 *
 * Everything above this file sees tools, not servers. `toolSchemas()` merges into the
 * model's tool list and `asTool()` returns something indistinguishable from a built-in,
 * so an MCP tool is dispatched, displayed, gated and logged by the same machinery as
 * `read_file`. That seam is the whole reason MCP does not leak into the engine.
 *
 * The governing rule is BEST-EFFORT: a server that will not start, will not answer, or
 * dies halfway is skipped, and the session keeps working with the built-in tools. MCP
 * is the user pointing at third-party code; it must never be able to take the agent
 * down with it.
 *
 * On CACHING: tool schemas are rendered before the providers' cache breakpoint, so a
 * catalog that changes invalidates the cached prompt prefix. It cannot be moved out of
 * the way — `tools` is a structural API field, not text, so there is no "volatile tail"
 * to put it in and still have native function-calling work. What we do instead is make
 * the catalog STABLE: a fixed sort order (`sortCatalog`), capped descriptions, and one
 * frozen `snapshot()` per turn. The cost then lands where it should — once per real
 * catalog change — instead of once per turn or, worse, once per step.
 */
import type { Tool, ToolResult, ToolSchema } from "../tools/types.js";
import { outputDetail } from "../tools/detail.js";
import { formatBytes } from "../tools/webFetch.js";
import { formatElapsed } from "../tools/webSearch.js";
import {
  estimateCatalogTokens,
  frameUntrusted,
  mcpToolName,
  normalizeServerName,
  parseContentBlocks,
  parseMcpToolName,
  sortCatalog,
  toolSchemas as schemasFor,
  type McpContentBlock,
  type McpToolDef,
} from "./catalog.js";
import { binaryPointer, isOversized, oversizedPointer, spill, sweepOldResults } from "./resultStore.js";
import { renderPromptMessages, type McpPrompt } from "./prompts.js";
import { sortResources, type McpResource, type McpResourceTemplate } from "./resources.js";
import { McpConnection, type ConnectionStatus } from "./connection.js";
import { searchCatalog, shouldDefer } from "./deferred.js";
import { compareTrust, acceptTools, changedToolsQuestion, fingerprintCatalog, type TrustRecord } from "./trust.js";
import { loadTrust, saveTrust } from "./trustStore.js";
import type { McpServerConfig } from "./config.js";

/**
 * One turn's frozen view of the MCP catalog: what the model is told it can call, and
 * what it can actually call, guaranteed to be the same set.
 */
export interface McpSnapshot {
  /**
   * The tools ADVERTISED to the model right now. Read per step rather than fixed at
   * snapshot time, because activating a deferred tool has to take effect on the very
   * next step — otherwise the model searches, is told it found something, and then
   * still cannot call it.
   */
  exposedSchemas(): ToolSchema[];
  /** Approximate prompt-token cost of what is currently exposed. */
  tokens(): number;
  /** True when the catalog is large enough that tools are held behind search. */
  deferred: boolean;
  /** Everything this server pool had at snapshot time, exposed or not. */
  catalog: readonly McpToolDef[];
  toolCount: number;
  /**
   * Resolve ANY tool in the frozen catalog, exposed or not. Deliberately wider than
   * `exposedSchemas`: a model that guesses a correct name should be allowed to call it
   * rather than be told a tool it named correctly does not exist.
   */
  asTool(name: string): Tool | undefined;
}

/**
 * Wrap one MCP tool def as a runnable Tool. Shared by the live lookup and the per-turn
 * snapshot so both dispatch through exactly the same path.
 */
function buildTool(name: string, def: McpToolDef, connection: McpConnection, spillRoot: () => string): Tool {
  return {
    name,
    description: def.description,
    parameters: def.inputSchema,
    readOnly: def.readOnly,
    async execute(args): Promise<ToolResult> {
      try {
        // Timed at the call site: a remote server's round trip is the one cost in a
        // tool row that nothing else on screen reveals, and it is what tells a slow
        // server apart from a slow query.
        const startedAt = Date.now();
        const result = await connection.callTool(def.name, args);
        const elapsedMs = Date.now() - startedAt;
        const { blocks, isError } = parseContentBlocks(result);
        const text = await renderBlocks(blocks, def, spillRoot());
        // Framed as data, not instruction: this text is written by a third party and
        // lands where the model trusts built-in tool output.
        return {
          output: frameUntrusted(def.server, text),
          summary: `${def.server} · ${def.name}`,
          detail: mcpDetail(def.name, args, text, isError, elapsedMs),
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        // A tool failure is a tool RESULT, not an exception: the model should see it,
        // reason about it, and try something else — the same contract as a failed shell
        // command. This is also where a server that died mid-turn surfaces, which is why
        // the snapshot can keep offering it without lying.
        return {
          output: `Error: MCP tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          summary: `${name} failed`,
        };
      }
    },
  };
}

/** The UI-only detail block under an MCP call row — never sent to the model
 *  (`frameUntrusted`'s `output` is what the model sees). A short args preview
 *  plus how much came back, capped the same way any other tool's output is. */
function mcpDetail(toolName: string, args: Record<string, unknown>, text: string, isError: boolean, elapsedMs?: number): string {
  const argsPreview = Object.keys(args).length > 0 ? JSON.stringify(args).slice(0, 120) : "";
  const lines: string[] = [];
  // "Connected" is implied by having a result at all; the LATENCY is the part worth
  // stating, and it is omitted rather than invented when nothing measured it.
  if (elapsedMs !== undefined) lines.push(`Status: Connected [Latency: ${formatElapsed(elapsedMs)}]`);
  lines.push(`Executed: ${toolName}${argsPreview ? `(${argsPreview})` : "()"}`);
  lines.push(
    isError
      ? "Received an error result"
      : `Received ${formatBytes(Buffer.byteLength(text, "utf8"))} (OK) → ${text.length.toLocaleString("en-US")} chars`,
  );
  return outputDetail(lines.join("\n"));
}

/**
 * Turn a result's blocks into the text the model receives, spilling what does not belong
 * in a prompt.
 *
 * Two things go to disk. BYTES always: an image or a blob is base64 the model cannot
 * look at, and inlining it is money spent on noise. OVERSIZED TEXT past the cap: the
 * model gets the head plus the path, which beats a bare truncation because nothing is
 * actually lost — it can read or grep the file for the part it needs.
 *
 * Failing to write is not fatal. The pointer falls back to naming the content, which is
 * what the old code did for everything, so the worst case is the previous behaviour.
 */
async function renderBlocks(blocks: readonly McpContentBlock[], def: { server: string; name: string }, root: string): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.kind === "link") {
      // A link is already a pointer; it costs nothing and read_mcp_resource can follow it.
      parts.push(`[resource: ${block.uri}${block.label ? ` — ${block.label}` : ""}]`);
      continue;
    }
    const bytes = Buffer.from(block.base64, "base64");
    const path = await spill(root, def.server, def.name, block.mime, bytes);
    parts.push(path ? binaryPointer(block.mime, bytes.byteLength, path) : `[${block.mime} content, ${bytes.byteLength} bytes, could not be saved]`);
  }

  const text = parts.join("\n") || "(no output)";
  if (!isOversized(text)) return text;
  const path = await spill(root, def.server, def.name, "text/plain", text);
  // With nowhere to put it we still must not hand over the whole thing — an unbounded
  // result is the failure this exists to prevent.
  return path ? oversizedPointer(text, path) : oversizedPointer(text, "(could not be saved to disk)");
}

/** The two answers to a changed-description prompt. */
const ALLOW_CHANGED = "Allow the changed tools";
const BLOCK_CHANGED = "Block them this session";

/** How many servers to bring up at once. Enough to start fast, bounded so a config
 *  with twenty servers does not spawn twenty processes in the same instant. */
const CONNECT_BATCH = 6;

let cleanupRegistered = false;
const live = new Set<McpManager>();

export class McpManager {
  private connections = new Map<string, McpConnection>();
  private started = false;
  private onChange: (() => void) | null = null;
  /** Deferred tools the model has searched for and may now call. Session-lived. */
  private activated = new Set<string>();
  /** Fingerprints of tools the user has accepted, loaded from the project's state dir. */
  private trust: TrustRecord = {};
  /** Tools blocked because their description moved and the user declined. */
  private quarantined = new Set<string>();
  /** Tool names the project's governor forbids outright (`forbid_mcp_tool`). */
  private forbidden = new Set<string>();
  /**
   * One-shot messages the user needs to see. Drained by the CLI, never re-sent.
   *
   * Blocking a tool with no visible explanation is barely better than not blocking it:
   * the user sees a shorter tool list, assumes the server is broken, and has nothing to
   * act on. Mirrors `BackgroundShells.takeUiNotifications`, which solved the same
   * problem for finished shells.
   */
  private notices: string[] = [];
  /**
   * The project this pool belongs to: where the trust record is read and written, and
   * where oversized results are spilled. Set as early as the session knows it, so a
   * dispatch that beats the (async, queued) trust check still spills to the right place.
   */
  private trustCwd = "";
  /**
   * Serializes every piece of trust work.
   *
   * The initial verification and a notification-driven recheck can otherwise interleave:
   * both read the record, both write it, and the second write loses whatever the first
   * decided. A chain is enough — this is rare, cheap work, and correctness matters more
   * than concurrency.
   */
  private trustQueue: Promise<void> = Promise.resolve();
  /** Fingerprints as of the last check, so an unchanged catalog costs nothing. */
  private trustSignature = "";

  /**
   * Told whenever any server's state or catalog moves, so the CLI can repaint.
   *
   * Servers connect in the background and can die or revive at any moment, so without
   * this the UI would only ever show whatever was true when the last key was pressed.
   * Mirrors `BackgroundShells.setOnChange`, which solved the same problem.
   */
  setOnChange(handler: (() => void) | null): void {
    this.onChange = handler;
    // Our own handler stays attached even when the UI detaches: it carries the trust
    // recheck, which is a safety gate and not a rendering concern.
    for (const connection of this.connections.values()) connection.setOnChange(() => this.onConnectionChange());
  }

  /**
   * Tell the pool which project it serves, before anything connects.
   *
   * Also the moment to clear out stale spilled results: they are scratch, this runs once
   * per session, and sweeping here keeps the mechanism free of any background timer.
   */
  setProjectRoot(cwd: string): void {
    this.trustCwd = cwd;
    void sweepOldResults(cwd).catch(() => {});
  }

  /** Where spilled results go. Falls back to the process cwd in bare contexts (tests),
   *  which is the same directory the rest of the tool layer defaults to. */
  private spillRoot(): string {
    return this.trustCwd || process.cwd();
  }

  /** Bring up every configured server. Never rejects: failures become states. */
  async start(configs: readonly McpServerConfig[], log?: (message: string) => void): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (configs.length === 0) return;
    registerCleanup();
    live.add(this);

    for (const config of configs) {
      const connection = new McpConnection(config);
      connection.setOnChange(() => this.onConnectionChange());
      this.connections.set(config.name, connection);
    }

    const pending = [...this.connections.values()].filter((c) => !c.config.disabled);
    for (let i = 0; i < pending.length; i += CONNECT_BATCH) {
      await Promise.all(
        pending.slice(i, i + CONNECT_BATCH).map(async (connection) => {
          // `connect` already converts failure into state; this catch is for the
          // genuinely unexpected, so one bad server cannot reject the whole batch.
          await connection.connect().catch(() => {});
          const status = connection.status();
          log?.(
            status.state === "connected"
              ? `mcp ${status.name}: ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} (${status.version}${status.legacy ? ", legacy" : ""})`
              : `mcp ${status.name}: ${status.state}${status.error ? ` — ${status.error}` : ""}`,
          );
        }),
      );
    }
  }

  /**
   * Check the connected catalog against the fingerprints this project accepted before,
   * and quarantine anything whose description or schema moved until the user says
   * otherwise.
   *
   * Called after `start()`, with the project root and the approval channel, so the pool
   * itself stays free of both filesystem and UI concerns. Fail-open on the mechanics
   * (an unreadable record means everything reads as fresh) but fail-CLOSED on the
   * decision: with no approval channel to ask through, changed tools stay blocked.
   */
  async verifyTrust(cwd: string, ask?: (question: string, options: string[]) => Promise<string>): Promise<void> {
    this.trustQueue = this.trustQueue.then(() => this.doVerifyTrust(cwd, ask)).catch(() => {});
    return this.trustQueue;
  }

  private async doVerifyTrust(cwd: string, ask?: (question: string, options: string[]) => Promise<string>): Promise<void> {
    const defs = this.catalog();
    // Remember the root even with nothing to check: a server can connect later, and the
    // recheck below is inert until it knows where the record lives.
    this.trustCwd = cwd;
    if (defs.length === 0) return;
    this.trust = await loadTrust(cwd);
    this.trustSignature = JSON.stringify(fingerprintCatalog(defs));
    const verdict = compareTrust(defs, this.trust);

    // First sight is trusted by construction — there is nothing to compare against.
    // Recording it is what makes the NEXT change detectable.
    if (verdict.fresh.length > 0) {
      this.trust = acceptTools(this.trust, defs, verdict.fresh);
    }

    if (verdict.changed.length > 0) {
      const allow = ask ? await ask(changedToolsQuestion(verdict.changed), [ALLOW_CHANGED, BLOCK_CHANGED]) : BLOCK_CHANGED;
      if (allow === ALLOW_CHANGED) {
        this.trust = acceptTools(this.trust, defs, verdict.changed);
        for (const name of verdict.changed) this.quarantined.delete(name);
      } else {
        // Blocked for the session. The stored fingerprint is left ALONE so the same
        // question is asked again next session rather than the change being forgotten.
        for (const name of verdict.changed) this.quarantined.add(name);
        // Say so. Without this the user just sees fewer tools — which reads as a broken
        // server, not a security decision they can act on. This is also the safety net
        // for the case where there was no approval channel to ask through at all.
        this.notices.push(
          `Blocked ${verdict.changed.length} MCP tool${verdict.changed.length === 1 ? "" : "s"} whose description ` +
            `changed since you last used ${verdict.changed.length === 1 ? "it" : "them"}: ${verdict.changed.join(", ")}. ` +
            `Run /mcp to review.`,
        );
        this.onChange?.();
      }
    }

    if (verdict.fresh.length > 0 || verdict.changed.length > 0) await saveTrust(cwd, this.trust);
  }

  /**
   * Re-verify after the catalog moves UNDERNEATH us, mid-session.
   *
   * This closes the hole the startup check left wide open. `trust.ts` names the rug pull
   * as its whole reason to exist — "a clean server ships an update that poisons a
   * description, and clients reload it silently" — and that is exactly what we did: a
   * `notifications/tools/list_changed` refreshed the catalog and nothing compared the new
   * descriptions against anything. A server therefore only had to connect clean and then
   * announce a change to walk straight past a check built to stop it.
   *
   * It QUARANTINES rather than asking. The trigger arrives whenever the server feels like
   * it, quite possibly mid-turn, and interrupting a running turn with a security question
   * is both jarring and racy. Blocking is the safe direction, the notice says what
   * happened, and `/mcp` already knows how to hand the question back.
   */
  private async recheckTrust(): Promise<void> {
    // Before the startup check has run there is no baseline to compare against, and
    // treating everything as fresh here would record fingerprints we never verified.
    if (!this.trustCwd) return;
    const defs = this.catalog();
    if (defs.length === 0) return;
    const signature = JSON.stringify(fingerprintCatalog(defs));
    if (signature === this.trustSignature) return; // nothing moved; the common case
    this.trustSignature = signature;

    const verdict = compareTrust(defs, this.trust);
    if (verdict.fresh.length === 0 && verdict.changed.length === 0) return;
    // A server that GAINS a tool is trusted on first sight, exactly as at startup —
    // otherwise every ordinary server upgrade would look like an attack.
    if (verdict.fresh.length > 0) this.trust = acceptTools(this.trust, defs, verdict.fresh);
    if (verdict.changed.length > 0) {
      for (const name of verdict.changed) this.quarantined.add(name);
      this.notices.push(
        `An MCP server changed ${verdict.changed.length} tool description${verdict.changed.length === 1 ? "" : "s"} ` +
          `while this session was running: ${verdict.changed.join(", ")}. ` +
          `Blocked for now — run /mcp to review.`,
      );
    }
    await saveTrust(this.trustCwd, this.trust);
    this.onChange?.();
  }

  /**
   * A server's state or catalog moved. Repaint, and check what moved.
   *
   * One handler for both so a catalog refresh can never reach the model without passing
   * the trust gate — the previous wiring repainted and nothing else.
   */
  private onConnectionChange(): void {
    // Catalogs are reloaded here (connect, and again on `list_changed`), so this is the
    // one point every drop passes through, whichever load produced it.
    for (const connection of this.connections.values()) this.notices.push(...connection.takeToolWarnings());
    this.trustQueue = this.trustQueue.then(() => this.recheckTrust()).catch(() => {});
    this.onChange?.();
  }

  /**
   * Re-offer the currently quarantined tools, so a block is recoverable in-session.
   *
   * Needed because the automatic check runs while the pool connects in the background,
   * possibly before the CLI has an approval channel to ask through. That path fails
   * closed and silent by design; this is how the user gets the question back.
   */
  async reviewQuarantine(ask: (question: string, options: string[]) => Promise<string>): Promise<boolean> {
    const blocked = this.quarantinedNames();
    if (blocked.length === 0) return false;
    const answer = await ask(changedToolsQuestion(blocked), [ALLOW_CHANGED, BLOCK_CHANGED]);
    if (answer !== ALLOW_CHANGED) return false;
    this.trust = acceptTools(this.trust, this.catalog(), blocked);
    for (const name of blocked) this.quarantined.delete(name);
    if (this.trustCwd) await saveTrust(this.trustCwd, this.trust);
    this.onChange?.();
    return true;
  }

  /** Drain user-facing notices. One-shot: each is reported exactly once. */
  takeNotices(): string[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  /** How many of a server's tools are currently blocked, for `/mcp`. */
  blockedCountFor(server: string): number {
    const prefix = mcpToolName(server, "");
    return this.quarantinedNames().filter((n) => n.startsWith(prefix)).length;
  }

  /** Apply the project's forbidden-MCP-tool list. Replaces the previous set. */
  setForbidden(names: readonly string[]): void {
    this.forbidden = new Set(names);
    // A tool that becomes forbidden must not linger in the activated set, or a deferred
    // catalog would keep advertising it.
    for (const name of names) this.activated.delete(name);
  }

  /** Tools currently blocked because their description changed. */
  quarantinedNames(): string[] {
    return [...this.quarantined].sort();
  }

  /**
   * Bring one server up NOW, without restarting the session.
   *
   * Adding a server and then being told to restart would make the add path useless —
   * the whole point is that you say what you want and it is there. Replaces any server
   * of the same name, shutting the old one down first so we never leak a child process
   * on a re-add.
   */
  async addServer(config: McpServerConfig): Promise<ConnectionStatus> {
    registerCleanup();
    live.add(this);
    this.started = true;

    const previous = this.connections.get(config.name);
    if (previous) await previous.close().catch(() => {});

    const connection = new McpConnection(config);
    connection.setOnChange(() => this.onConnectionChange());
    this.connections.set(config.name, connection);
    if (!config.disabled) await connection.connect().catch(() => {});
    // A re-added server is a different server as far as trust goes; drop any stale
    // activation so a deferred catalog does not advertise tools it no longer has.
    for (const name of this.activatedNames()) {
      if (name.startsWith(mcpToolName(config.name, ""))) this.activated.delete(name);
    }
    // Fingerprint what it brought. Without this a server added mid-session was never
    // recorded at all, so its very first descriptions became the baseline only on the
    // NEXT session — and anything it changed in between went unnoticed.
    this.onConnectionChange();
    return connection.status();
  }

  /**
   * Every prompt every connected server offers, as slash commands.
   *
   * Synchronous because the CLI reads it while rendering the completion menu — a
   * keystroke cannot wait on a round trip, which is why prompts are fetched at connect.
   */
  promptCatalog(): McpPrompt[] {
    return [...this.connections.values()]
      .filter((c) => c.isConnected())
      .flatMap((c) => [...c.prompts()])
      .sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
  }

  /** Look up one prompt by its server and name. */
  findPrompt(server: string, name: string): McpPrompt | undefined {
    return this.promptCatalog().find((p) => p.server === server && p.name === name);
  }

  /**
   * Render a prompt into the text of a user turn.
   *
   * Errors are returned rather than thrown: the caller is a slash command, and the user
   * needs to be told what went wrong in the chat, not shown a stack.
   */
  async renderPrompt(server: string, name: string, args: Record<string, string>): Promise<{ text: string; error?: string }> {
    const connection = this.connectionFor(server);
    if (!connection) return { text: "", error: `MCP server '${server}' is not connected.` };
    try {
      const rendered = renderPromptMessages(await connection.getPrompt(name, args));
      if (!rendered) return { text: "", error: `'${server}:${name}' returned nothing to run.` };
      return { text: rendered };
    } catch (error) {
      return { text: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * List resources across every connected server, or one of them.
   *
   * Fetches on demand rather than at connect: most projects never touch resources, and
   * two extra round trips per server would be paid by every session to serve the few
   * that do. The per-connection TTL keeps a model that lists twice in one turn from
   * paying twice.
   */
  async listResources(server?: string): Promise<{ resources: McpResource[]; templates: McpResourceTemplate[]; servers: number }> {
    const connections = [...this.connections.values()].filter(
      (c) => c.isConnected() && c.offersResources() && (!server || matchesServer(c.config.name, server)),
    );
    await Promise.all(connections.map((c) => c.loadResources().catch(() => {})));
    return {
      resources: sortResources(connections.flatMap((c) => [...c.resources()])),
      templates: connections.flatMap((c) => [...c.resourceTemplates()]),
      servers: connections.length,
    };
  }

  /**
   * Read one resource, spilling it to disk if it is large or binary.
   *
   * Same treatment as a tool result, for the same reason: a resource is content chosen
   * by a third party, and "read the schema" should not be able to swallow a turn.
   */
  async readResource(server: string, uri: string): Promise<{ text: string; isError: boolean }> {
    const connection = this.connectionFor(server);
    if (!connection) {
      return { text: `No connected MCP server named '${server}'.`, isError: true };
    }
    try {
      const blocks = await connection.readResource(uri);
      if (blocks.length === 0) return { text: `'${uri}' returned no content.`, isError: false };
      const body = await renderBlocks(blocks, { server, name: resourceLabel(uri) }, this.spillRoot());
      return { text: frameUntrusted(server, body), isError: false };
    } catch (error) {
      return { text: `Could not read '${uri}': ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }

  /** Which servers advertise resources at all, for a useful empty-state message. */
  resourceServers(): string[] {
    return [...this.connections.values()]
      .filter((c) => c.isConnected() && c.offersResources())
      .map((c) => c.config.name)
      .sort();
  }

  /** Resolve a server by its config name, tolerating the normalized form the model sees. */
  private connectionFor(server: string): McpConnection | undefined {
    return [...this.connections.values()].find((c) => c.isConnected() && matchesServer(c.config.name, server));
  }

  /** Every server's state, for `/mcp` and for diagnostics. */
  statuses(): ConnectionStatus[] {
    return [...this.connections.values()].map((c) => c.status()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Force a reconnect of one server by name. Returns its state afterwards. */
  async reconnect(name: string): Promise<ConnectionStatus | null> {
    const connection = this.connections.get(name);
    if (!connection) return null;
    await connection.reconnect().catch(() => {});
    this.onChange?.();
    return connection.status();
  }

  /**
   * Sign in to one server and reconnect it. Returns its state afterwards, or throws with
   * the sentence to show — an authorization failure is almost never our bug, and the
   * reason (consent declined, no dynamic registration, the browser never came back) is
   * the only useful thing to put on screen.
   */
  async authenticate(name: string, options: { onUrl?: (url: string) => void; signal?: AbortSignal } = {}): Promise<ConnectionStatus | null> {
    const connection = this.connections.get(name);
    if (!connection) return null;
    await connection.authenticate(options);
    this.onChange?.();
    return connection.status();
  }

  /** Forget one server's stored credential. */
  async signOut(name: string): Promise<ConnectionStatus | null> {
    const connection = this.connections.get(name);
    if (!connection) return null;
    await connection.signOut();
    this.onChange?.();
    return connection.status();
  }

  /** Which servers currently hold a stored credential, so the manage screen can offer
   *  "Sign out" instead of a second "Sign in". Resolved together because the UI asks for
   *  all of them at once and each is a file read. */
  async credentialed(): Promise<Set<string>> {
    const held = await Promise.all(
      [...this.connections.values()].map(async (c) => ((await c.hasCredential()) ? c.config.name : null)),
    );
    return new Set(held.filter((n): n is string => n !== null));
  }

  /** True when there is anything at all to show in `/mcp`. */
  hasServers(): boolean {
    return this.connections.size > 0;
  }

  /**
   * The config a connected server is currently running with, for editing or for flipping
   * its `disabled` flag. Not from disk — from the live connection, which is what is
   * actually true right now and what a config on disk could disagree with (a hand-edit
   * since this session started, say).
   */
  configFor(name: string): McpServerConfig | undefined {
    return this.connections.get(name)?.config;
  }

  /**
   * Stop a server and forget it for the rest of THIS session — the live half of Remove.
   *
   * `removeServerFromConfig` only edits the file, which is why its own caller has always
   * had to say "it stays connected until this session ends": nothing closed the running
   * connection or dropped its tools from what the model is offered. This is that other
   * half, deliberately separate from the file write so a caller can persist without
   * necessarily tearing down what is running (not needed today, kept correct anyway).
   *
   * `false` when there was nothing by that name to stop.
   */
  async removeServer(name: string): Promise<boolean> {
    const connection = this.connections.get(name);
    if (!connection) return false;
    await connection.close().catch(() => {});
    this.connections.delete(name);
    // Same cleanup addServer does on a replace: a removed server's activation is stale,
    // and leaving it would advertise tools to the model that no longer exist to call.
    for (const activated of this.activatedNames()) {
      if (activated.startsWith(mcpToolName(name, ""))) this.activated.delete(activated);
    }
    this.onConnectionChange();
    return true;
  }

  /**
   * A frozen view of the catalog for ONE turn.
   *
   * The engine advertises a tool list to the model and then dispatches whatever it
   * calls, and those were two separate reads of live state. In between, a server can
   * die or send `notifications/tools/list_changed` — so a tool the model was OFFERED at
   * the top of the turn could be gone by the time it called it, and the model would be
   * told "no such tool" for something we had just told it about. That is a confusing
   * failure to debug and an easy one to blame on the model.
   *
   * Taking one snapshot and using it for both halves makes the turn internally
   * consistent: what was offered stays callable. If the underlying server really has
   * gone, the call fails at dispatch with a real error the model can act on, which is
   * an honest outcome rather than a contradiction.
   *
   * It also pins the exact bytes sent as `tools` for the turn, which is what keeps the
   * cached prompt prefix intact across the turn's steps.
   */
  snapshot(readOnlyOnly = false): McpSnapshot {
    const defs = this.allowedCatalog().filter((d) => !readOnlyOnly || d.readOnly);
    // Bind each def to the connection that owned it AT SNAPSHOT TIME, so dispatch does
    // not go looking through a pool that may have changed underneath us.
    const owners = new Map<string, McpConnection>();
    for (const connection of this.connections.values()) {
      for (const def of connection.tools()) owners.set(mcpToolName(def.server, def.name), connection);
    }
    const deferred = shouldDefer(defs.length);
    // Under the threshold everything is exposed; over it, only what has been activated.
    const exposed = (): McpToolDef[] => (deferred ? defs.filter((d) => this.activated.has(mcpToolName(d.server, d.name))) : defs);
    return {
      deferred,
      catalog: defs,
      toolCount: defs.length,
      exposedSchemas: () => schemasFor(exposed(), readOnlyOnly),
      tokens: () => estimateCatalogTokens(exposed()),
      asTool: (name) => {
        const def = defs.find((d) => mcpToolName(d.server, d.name) === name);
        const connection = owners.get(name);
        if (!def || !connection) return undefined;
        return buildTool(name, def, connection, () => this.spillRoot());
      },
    };
  }

  /**
   * Search the catalog and ACTIVATE what matches, so those tools are advertised from
   * the next step onward.
   *
   * Activation is sticky for the session on purpose. A tool the model reached for once
   * it will likely reach for again, and re-hiding it would mean another search round
   * trip and another change to the advertised tool list — which is the thing that costs
   * a prompt-cache prefix. Paying once and keeping it is cheaper than paying repeatedly.
   */
  /**
   * Find deferred tools matching a query. Deliberately does NOT advertise them.
   *
   * It used to, and that was the expensive half of deferral: adding a found tool to the
   * `tools` array changes the bytes the provider hashes, so every request after a search
   * paid to rewrite the whole cached prefix — tools, system AND messages. The saving was
   * a few hundred tokens of schema; the bill was the entire prefix. The caller now hands
   * the model the full schema in the search RESULT instead (see renderResults), which is
   * an appended message the cache does not care about, and `asTool` dispatches against
   * the allowed catalog rather than against what was advertised.
   */
  searchCatalogTools(query: string): McpToolDef[] {
    return searchCatalog(query, this.allowedCatalog());
  }

  /** Tool names currently advertised out of a deferred catalog (for diagnostics). */
  activatedNames(): string[] {
    return [...this.activated].sort();
  }

  /**
   * Roughly what the live catalog costs in prompt tokens.
   *
   * The compaction bars measure the transcript only, so without this correction a large
   * MCP catalog makes every threshold fire that much too late.
   */
  estimatedTokens(): number {
    // What is SENT, not what exists: a deferred catalog costs only its activated part,
    // and counting the hidden remainder would make the compaction bars fire early for
    // tokens the model never receives.
    return this.snapshot().tokens();
  }

  /** Every tool across every connected server, in a stable order. */
  private catalog(): McpToolDef[] {
    return sortCatalog([...this.connections.values()].filter((c) => c.isConnected()).flatMap((c) => [...c.tools()]));
  }

  /**
   * The catalog minus anything the user has blocked. ONE chokepoint for both governance
   * gates, so a blocked tool cannot be advertised, searched, activated or dispatched —
   * there is no path that consults the raw catalog instead.
   */
  private allowedCatalog(): McpToolDef[] {
    return this.catalog().filter((d) => {
      const name = mcpToolName(d.server, d.name);
      return !this.quarantined.has(name) && !this.forbidden.has(name);
    });
  }

  /**
   * One server's tools as a manage screen lists them: every tool it offers, each marked
   * with whether the user's governance is holding it back (changed since it was trusted,
   * or forbidden). A listing only; dispatch still goes through `allowedCatalog`.
   */
  toolsFor(server: string): { def: McpToolDef; blocked: "changed" | "forbidden" | null }[] {
    return this.catalog()
      .filter((d) => d.server === server)
      .map((def) => {
        const name = mcpToolName(def.server, def.name);
        return { def, blocked: this.quarantined.has(name) ? "changed" : this.forbidden.has(name) ? "forbidden" : null };
      });
  }

  /** Accept every changed (quarantined) tool without asking, for a UI that has
   *  already asked the user itself. Same effect as answering "Allow" to `reviewQuarantine`. */
  async allowChanged(): Promise<boolean> {
    return this.reviewQuarantine(async () => ALLOW_CHANGED);
  }

  /** How many tools are currently offered (for status lines and budgeting). */
  toolCount(): number {
    return this.allowedCatalog().length;
  }

  /** Schemas for every MCP tool. `readOnlyOnly` drops mutating tools, mirroring the
   *  built-in registry's behaviour in plan mode and read-only sub-agents. */
  toolSchemas(readOnlyOnly = false): ToolSchema[] {
    return schemasFor(this.allowedCatalog(), readOnlyOnly);
  }

  /**
   * Resolve an advertised MCP name to a runnable Tool, or undefined if we do not serve
   * it. Returning undefined (rather than a tool that errors) is what lets the engine's
   * lookup fall through to its normal "no such tool" path.
   */
  asTool(name: string): Tool | undefined {
    const parsed = parseMcpToolName(name);
    if (!parsed) return undefined;
    // Resolve against the ALLOWED catalog, not the raw connections. Reading the
    // connections directly was a hole: a forbidden or quarantined tool stayed
    // dispatchable through this path even though it was gone from every list. A gate
    // that closes three of four doors is not a gate.
    const def = this.allowedCatalog().find((d) => mcpToolName(d.server, d.name) === name);
    if (!def) return undefined;
    // Config names are normalized on the way INTO a tool name, so a server called
    // "acme.tools" is looked up by its normalized form here.
    const connection = [...this.connections.values()].find(
      (c) => c.isConnected() && mcpToolName(c.config.name, "x") === mcpToolName(parsed.server, "x"),
    );
    if (!connection) return undefined;
    return buildTool(name, def, connection, () => this.spillRoot());
  }

  async dispose(): Promise<void> {
    const closing = [...this.connections.values()].map((c) => c.close().catch(() => {}));
    this.connections.clear();
    live.delete(this);
    await Promise.all(closing);
  }

  /**
   * Teardown for a process-exit handler, where nothing can be awaited.
   *
   * `close(true)` reaps a shelled server with a blocking kill; the synchronous
   * part of each close runs before this returns, which is all the exit handler
   * gets. The returned promises are deliberately dropped.
   */
  disposeSync(): void {
    for (const c of this.connections.values()) void c.close(true).catch(() => {});
    this.connections.clear();
    live.delete(this);
  }
}

/**
 * Does this config name refer to the server the model named?
 *
 * The model only ever sees NORMALIZED names (`acme_tools` for a server configured as
 * `acme.tools`), because that is what survives being embedded in a tool name. So a
 * resource or prompt call naming its server has to be matched through the same
 * normalization, or every server with a dot in its name becomes unreachable.
 */
function matchesServer(configName: string, requested: string): boolean {
  return configName === requested || normalizeServerName(configName) === normalizeServerName(requested);
}

/** A short, filename-ish label for a resource URI, used when spilling it to disk. */
function resourceLabel(uri: string): string {
  const tail = uri.split(/[/?#]/).filter(Boolean).pop() ?? "resource";
  return tail.slice(0, 32);
}

/** Kill any servers still running when the process exits. Child processes do not die
 *  with their parent on every platform, and an orphaned server holds a port or a lock. */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    // Synchronous kill: an async one never reaches the OS from here.
    for (const manager of [...live]) manager.disposeSync();
  });
}
