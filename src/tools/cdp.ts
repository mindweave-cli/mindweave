/**
 * cdp.ts — talk to a Chromium page over the DevTools protocol.
 *
 * The page route of `ui` drives web content directly: a headless browser the tool starts,
 * or an Electron / WebView2 app started with a debugging port. The protocol runs over
 * Node's built-in WebSocket (Node 24, the supported floor, and the Node the desktop app's
 * Electron embeds).
 *
 * Only ever connects to 127.0.0.1. A debugging port is full control of whatever is behind
 * it, and nothing here has a reason to reach another machine's.
 */
import { request } from "node:http";

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

/** One live protocol connection to a page (or the browser). */
export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  closed = false;
  /** Why it closed, when it did on its own (the app quit, the page went away). */
  closeReason = "";
  private onCloseHandlers: (() => void)[] = [];

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => this.dispatch(typeof ev.data === "string" ? ev.data : String(ev.data)));
    ws.addEventListener("close", () => this.shut("the connection closed"));
    ws.addEventListener("error", () => this.shut("the connection failed"));
  }

  /** Open a connection to a `ws://127.0.0.1:port/...` debugger URL. */
  static open(wsUrl: string, timeoutMs = 10_000): Promise<CdpConnection> {
    let url: URL;
    try {
      url = new URL(wsUrl);
    } catch {
      return Promise.reject(new Error("not a debugger address"));
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return Promise.reject(new Error("only local debugging ports can be used"));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("the page did not answer"));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new CdpConnection(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("the debugger refused the connection"));
        },
        { once: true },
      );
    });
  }

  /** Send a command and wait for its answer. */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error(this.closeReason || "the connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, fn: (params: Record<string, unknown>) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  onClose(fn: () => void): void {
    this.onCloseHandlers.push(fn);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      // Already gone; closing is all that was wanted.
    }
    this.shut("closed");
  }

  private shut(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const p of this.pending.values()) p.reject(new Error(`the page went away (${reason})`));
    this.pending.clear();
    for (const fn of this.onCloseHandlers) fn();
  }

  /** Route one message: an answer to a command, or an event. */
  private dispatch(text: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "the page refused the command"));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
  }
}

/** One debuggable target a port offers. */
export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** The targets behind a local debugging port. */
export async function listTargets(port: number, timeoutMs = 3000): Promise<CdpTarget[]> {
  return await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/json/list", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as CdpTarget[]);
        } catch {
          reject(new Error(`port ${port} is not a debugging port`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`nothing answered on port ${port}`)));
    req.on("error", (e: NodeJS.ErrnoException) =>
      reject(e.code === "ECONNREFUSED" ? new Error(`nothing is listening on port ${port}`) : e),
    );
    req.end();
  });
}

/**
 * The pages worth driving, best first (pure). DevTools windows, service workers and
 * extension pages are never the app.
 */
export function pageTargets(targets: CdpTarget[]): CdpTarget[] {
  return targets.filter(
    (t) =>
      t.type === "page" &&
      !!t.webSocketDebuggerUrl &&
      !/^(devtools|chrome-extension|chrome|edge):/i.test(t.url),
  );
}
