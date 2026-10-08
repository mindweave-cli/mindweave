/**
 * stdio.ts — MCP over a child process's stdin/stdout.
 *
 * The local transport, and the one almost every server in the wild uses. Framing is
 * newline-delimited JSON, one JSON-RPC message per line. Worth stating plainly because
 * it differs from the OTHER JSON-RPC we speak in this codebase: the language servers in
 * `alternator/chassis` use LSP's `Content-Length` header framing. Same wire format,
 * different envelope, and mixing them up produces a silent hang rather than an error.
 *
 * Everything here is defensive about the child, because the child is arbitrary
 * third-party code that may write logs to stdout, die at any moment, or never answer:
 *   - Non-JSON lines are skipped, not fatal. Servers print banners.
 *   - Every request has a timeout; a server that never replies cannot wedge a turn.
 *   - Death rejects all in-flight requests at once instead of leaving them hanging.
 *   - stderr is drained and kept as a tail, because when a server fails to start the
 *     reason is almost always on stderr and is otherwise lost.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killTree, killTreeSync, spawnManaged } from "../../tools/killTree.js";
import { childEnv } from "../../tools/childEnv.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, RpcError, type Notification, type Transport } from "./types.js";

/** How much of the child's stderr to keep for diagnostics. */
const STDERR_TAIL_CHARS = 4_000;

/**
 * Does this command need a shell on Windows (pure)?
 *
 * `spawn` on Windows executes a binary directly and does NOT apply PATHEXT, so it can
 * only find something that is already a real executable. Every npm-installed launcher —
 * `npx`, `pnpm`, `uvx`, `yarn` — is a `.cmd` shim on PATH, so `spawn("npx", …)` fails
 * with ENOENT. That matters more than it sounds: `{"command": "npx", "args": ["-y",
 * "@scope/server"]}` is how essentially every MCP server in the ecosystem is configured,
 * including in this codebase's own config docstring. Checking for a literal `.cmd`/`.bat`
 * suffix (what we did before) only helps the rare user who spelled the extension out.
 *
 * So: anything that is not already a directly-executable image goes through the shell,
 * which is what performs PATHEXT lookup. `.exe`/`.com` and absolute paths to them are
 * spawned directly, because a shell there buys nothing and adds a quoting problem.
 */
export function windowsNeedsShell(command: string): boolean {
  return !/\.(exe|com)$/i.test(command.trim());
}

/**
 * Quote one token for `cmd.exe` (pure).
 *
 * Only when it needs it: an untouched token is easier to read in an error message, and
 * the overwhelming majority (`-y`, `@scope/pkg`) contain nothing special. Internal
 * quotes are doubled, which is the form `cmd` itself understands.
 */
export function quoteForCmd(token: string): string {
  if (token === "") return '""';
  if (!/[\s"^&|<>()%!]/.test(token)) return token;
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build the single command line a shell spawn takes (pure).
 *
 * The previous code interpolated `"${command}" ${args.join(" ")}`, which breaks the
 * moment any argument holds a space — a Windows path with `Program Files` in it, say —
 * because the argument silently splits in two.
 */
export function windowsCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteForCmd).join(" ");
}

export interface StdioOptions {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/** Build a message frame. Exported for the framing test — the bug it guards (a missing
 *  trailing newline) makes a server wait forever rather than fail. */
export function frame(message: unknown): string {
  return JSON.stringify(message) + "\n";
}

/**
 * Split a buffer into complete lines plus the unconsumed remainder (pure).
 *
 * A pipe delivers arbitrary chunks: one read can hold three messages, or half of one.
 * Keeping this pure is what lets the split-frame cases be tested without a process.
 */
export function drainLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  let nl: number;
  while ((nl = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line) lines.push(line);
  }
  return { lines, rest };
}

export class StdioTransport implements Transport {
  private readonly proc: ChildProcess;
  /** True when the child is a shell wrapping the real server (Windows). */
  private readonly shelled: boolean;
  private nextId = 1;
  private buffer = "";
  private stderrTail = "";
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private notificationHandler: ((notification: Notification) => void) | null = null;
  private resolveClosed!: () => void;
  readonly closed: Promise<void>;

  constructor(options: StdioOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });

    const args = [...(options.args ?? [])];
    // The user's environment, not Mindweave's (no provider keys; see tools/childEnv.ts), plus
    // what this server's own config sets.
    const env = childEnv(options.env ?? {});
    // On Windows almost everything has to go through a shell to be found at all; see
    // `windowsNeedsShell`. POSIX spawns directly, where PATH lookup already works and a
    // shell would only add a quoting surface.
    this.shelled = process.platform === "win32" && windowsNeedsShell(options.command);
    // spawnManaged, not spawn: on POSIX it makes the server its own process-group
    // leader, which is what lets `close` take its children down with it. An MCP server
    // is very often a launcher (`npx`, `uvx`, `pnpm dlx`) whose real work happens in a
    // grandchild, and those used to survive Mindweave exiting.
    this.proc = this.shelled
      ? spawnManaged(windowsCommandLine(options.command, args), [], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: true,
          env,
          ...(options.cwd ? { cwd: options.cwd } : {}),
        })
      : spawnManaged(options.command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env,
          ...(options.cwd ? { cwd: options.cwd } : {}),
        });

    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // Both are terminal for us; `error` fires when the command does not exist at all.
    this.proc.on("exit", (code) => this.die(new Error(`mcp server exited (code ${code ?? "unknown"})${this.stderrNote()}`)));
    this.proc.on("error", (e) => this.die(new Error(`mcp server failed to start: ${e.message}${this.stderrNote()}`)));
  }

  onNotification(handler: (notification: Notification) => void): void {
    this.notificationHandler = handler;
  }

  /** The child's recent stderr, if any — usually the actual reason a server failed. */
  stderr(): string {
    return this.stderrTail.trim();
  }

  private stderrNote(): string {
    const tail = this.stderr();
    return tail ? `: ${tail.split("\n").slice(-3).join(" ").slice(0, 300)}` : "";
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const { lines, rest } = drainLines(this.buffer);
    this.buffer = rest;
    for (const line of lines) {
      let msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a banner, a log line, anything — not our problem
      }
      if (typeof msg.id !== "number") {
        // Server-initiated. Nothing awaits it, but `subscriptions/listen` change
        // notifications arrive this way on stdio, so they have to be handed up rather
        // than dropped on the floor the way Phase 1 did.
        const note = msg as { method?: unknown; params?: unknown };
        if (typeof note.method === "string" && this.notificationHandler) {
          this.notificationHandler({
            method: note.method,
            ...(note.params && typeof note.params === "object" ? { params: note.params as Record<string, unknown> } : {}),
          });
        }
        continue;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) {
        const code = typeof msg.error.code === "number" ? msg.error.code : -32603;
        const message = typeof msg.error.message === "string" ? msg.error.message : "mcp error";
        waiter.reject(new RpcError(code, message, msg.error.data));
      } else {
        waiter.resolve(msg.result);
      }
    }
  }

  /** Mirrored headers are accepted and ignored: a pipe has no headers, and the spec lets
   *  a non-HTTP client ignore `x-mcp-header` annotations entirely. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(new RpcError(-32603, "mcp transport is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32603, `mcp timeout after ${this.timeoutMs}ms: ${method}`));
      }, this.timeoutMs);
      // Do not hold the event loop open just to wait on a slow server.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) return;
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private write(message: unknown): void {
    try {
      this.proc.stdin?.write(frame(message));
    } catch {
      // The child is gone; the pending request will time out or be failed by `die`.
    }
  }

  /** Fail everything in flight and mark the transport dead. Idempotent. */
  private die(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.resolveClosed();
  }

  async close(sync = false): Promise<void> {
    if (!this.disposed) this.die(new Error("mcp transport closed"));
    try {
      // Always kill the TREE, on every platform. A shelled child is `cmd.exe` rather
      // than the server, so killing the handle leaves the real process running — but
      // the same is true off Windows whenever the server is a launcher (`npx`, `uvx`)
      // that does its work in a child. This used to be gated on `shelled`, which is
      // Windows-only, so on macOS and Linux only the direct child was ever signalled
      // and its children were orphaned. From a process-exit handler the async path
      // never reaches the OS, so that case has to block instead.
      (sync ? killTreeSync : killTree)(this.proc.pid);
      this.proc.kill();
    } catch {
      // Already gone.
    }
  }
}
