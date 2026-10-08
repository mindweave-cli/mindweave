/**
 * lsp.ts — talk to language servers for compiler-accurate answers.
 *
 * Used for ON-DEMAND precision, not bulk indexing: when the model asks where a
 * symbol is defined or who references it, we ask the real language server (the
 * TypeScript compiler, etc.) via `workspace/symbol` and `textDocument/references`.
 * The tree-sitter tier still builds the bulk graph (outline + ranking); this just
 * upgrades specific answers to `resolved`.
 *
 * Everything is best-effort: a server that won't launch or is slow is marked dead
 * and the chassis falls back to the tree-sitter graph. Servers are launched
 * lazily, shared per spec, and killed on dispose.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { languageIdFor, serverFor, specForLanguage, type ServerSpec } from "./servers.js";
import type { CodeDiagnostic, SymbolKind } from "./types.js";
import { flattenDocSymbols, pickNearest, type LineSpan, type RawDocSymbol } from "../../tools/spanCore.js";
import { killTreeSync, spawnManaged } from "../../tools/killTree.js";

const INIT_TIMEOUT = 15_000;

/**
 * What this client can do, told to every server at initialize.
 *
 * It was `{}`, and a server only sends what the client says it can take: the TypeScript
 * server published no diagnostics at all to a client that did not declare
 * publishDiagnostics, so the diagnostics tool and the after-edit check answered
 * "nothing" for every TypeScript and JavaScript project and spent their full wait doing
 * it. Declared here: exactly the features this client uses. Nothing that would make a
 * server send requests this client does not answer (workspace/configuration, progress
 * tokens), and no hierarchical document symbols, whose different reply shape the symbol
 * code does not parse.
 */
export const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
    publishDiagnostics: { relatedInformation: false, versionSupport: false },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false },
  },
  workspace: { symbol: { dynamicRegistration: false } },
} as const;
const REQUEST_TIMEOUT = 10_000;
/** How long to wait for a server's `shutdown` reply before killing it anyway. */
const SHUTDOWN_TIMEOUT = 2_000;

/**
 * How long a language server may sit idle before it is shut down to reclaim its memory.
 *
 * A pyright or tsserver is spawned on the first symbol query and, without this, lived for
 * the rest of the session holding its whole index — hundreds of megabytes each, resident
 * the entire time whether or not another query ever came. Most of a session is reading,
 * writing and running commands, not looking symbols up, so that memory sat unused far
 * more often than it was needed. A server is lazy (see `session`), so shutting an idle
 * one down costs only a cold respawn the next time code intelligence is actually asked
 * for — the same cost the first query already pays.
 *
 * Two minutes because a respawn re-indexes the project, which is the expensive part: long
 * enough that a burst of related lookups never pays it twice, short enough that the memory
 * is back soon after the model moves on to other work. The check runs on a coarser timer
 * so an idle session is not woken four times a minute to look at a clock.
 */
function lspIdleMs(): number {
  const raw = Number(process.env["MINDWEAVE_LSP_IDLE_MS"]);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
}
const LSP_IDLE_CHECK_MS = 30_000;

/**
 * Ceiling on documents held open in ONE server, across the whole session.
 *
 * `ensureProjectOpen` opens files so `workspace/symbol` has something indexed.
 * Its per-call limit bounds one query's latency but not the total: every query
 * opened another batch, so a long session pushed the entire project into the
 * server one query at a time, and each open sends the file's full text.
 *
 * 300 is a judgment call, not a measurement. The first open already loads the
 * enclosing tsconfig/venv project, which is what makes symbol search work at
 * all; the rest is coverage for files outside it. 300 is comfortably above the
 * per-call batch and far below a repo. Revisit it if someone measures where
 * symbol recall actually stops improving.
 */
const MAX_OPEN_DOCS = 300;
/** Documents opened in a single `ensureProjectOpen` call, to bound its latency. */
const OPEN_BATCH = 50;

/**
 * How long to keep asking a just-opened server for a symbol before believing its
 * empty answer, in milliseconds between attempts.
 *
 * Backing off rather than polling evenly, because the common case is a server that is
 * ready almost at once and the expensive case is one that is not. Six attempts, ~4.6s
 * in total, paid once per server and only when nothing came back — a cold pyright on a
 * loaded four-core machine takes seconds to index where a warm laptop takes
 * milliseconds, which is why a fixed wait tuned on the laptop was never going to hold.
 */
const INDEX_RETRY_DELAYS = [100, 200, 400, 800, 1500, 1600];

export interface LspSymbol {
  name: string;
  kind: SymbolKind;
  file: string; // absolute
  line: number; // 1-based
  character: number; // 0-based (for follow-up references queries)
}
export interface LspLocation {
  file: string;
  line: number;
}

interface Session {
  conn: MessageConnection;
  proc: ChildProcess;
  opened: Set<string>;
}

/**
 * A spawned server plus how it was spawned. `shelled` matters at kill time: a
 * shelled child is `cmd.exe`, not the server, so killing the handle leaves the
 * real server running. Same orphan the MCP stdio transport already guards.
 */
interface Tracked {
  proc: ChildProcess;
  shelled: boolean;
}

export class LspManager {
  private sessions = new Map<string, Promise<Session | null>>();
  private languages = new Set<string>();
  private files = new Set<string>();
  private procs: Tracked[] = [];
  private disposed = false;
  /** Latest diagnostics per file (forward-slashed path), from publishDiagnostics. */
  private diagnosticsByFile = new Map<string, RawDiagnostic[]>();
  /** didChange version counter per file. */
  private versions = new Map<string, number>();
  /** When a query last touched a server, for the idle shutdown below. */
  private lastActivity = Date.now();
  /** The idle-watch timer, unref'd so it never keeps the process alive. */
  private idleTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly root: string) {
    // Watch for idleness from the start. Unref'd, so a session with servers that have
    // already been shut down (or were never started) does not hold the event loop open.
    this.idleTimer = setInterval(() => this.reapIfIdle(), LSP_IDLE_CHECK_MS);
    this.idleTimer.unref?.();
  }

  /**
   * Shut idle servers down, keeping the manager usable.
   *
   * Everything a killed server held — its `opened` documents, its index — dies with it,
   * so this only clears the manager's own handles: the sessions map (so the next query
   * relaunches), the process list, and the diagnostics/versions those servers produced,
   * which a fresh server will republish from scratch. `languages` and `files` stay: they
   * are what a respawn is rebuilt from, and they cost nothing.
   *
   * Public so the idle threshold can be driven from a test without waiting on the timer;
   * it is safe to call at any time because it does nothing unless a server is genuinely
   * idle past the threshold.
   */
  reapIfIdle(): void {
    if (this.disposed || this.procs.length === 0) return;
    if (Date.now() - this.lastActivity < lspIdleMs()) return;
    for (const { proc } of this.procs) {
      try {
        killTreeSync(proc.pid);
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    this.procs = [];
    this.sessions.clear();
    this.diagnosticsByFile.clear();
    this.versions.clear();
  }

  /** Record that the project contains this file (so we know which servers to
   *  consult, and so we can open the project before a workspace query). */
  noteFile(absPath: string): void {
    const lang = languageIdFor(absPath);
    if (lang) {
      this.languages.add(lang);
      this.files.add(absPath);
    }
  }

  /** Compiler-accurate symbols matching `name` across the project. */
  async symbols(name: string): Promise<LspSymbol[]> {
    const out: LspSymbol[] = [];
    for (const spec of this.distinctSpecs()) {
      const session = await this.session(spec);
      if (!session) continue;
      // A server like tsserver won't index a project until a file in it is
      // opened — open the project's files (bounded) before querying navto.
      const opened = await this.ensureProjectOpen(session, spec);
      try {
        // `textDocument/didOpen` is a NOTIFICATION: it returns the moment it is
        // written, while the server is still building its index. A
        // `workspace/symbol` sent immediately after is answered honestly and
        // emptily, which reaches the caller as "no such symbol" rather than "not
        // indexed yet" — a wrong answer, silently, and then a fall back to
        // tree-sitter that nobody asked for. Retried while an empty result is
        // still plausibly a cold index, and ONLY when this call actually opened
        // documents: on a warm session an empty answer is the real one, and
        // waiting for it again would tax every miss.
        const res = await this.querySymbols(session, name, opened > 0);
        for (const s of res ?? []) {
          if (s.name !== name) continue; // workspace/symbol is fuzzy; keep exact
          const loc = s.location;
          if (!loc?.uri) continue;
          out.push({
            name: s.name,
            kind: symbolKind(s.kind),
            file: uriToPath(loc.uri),
            line: (loc.range?.start.line ?? 0) + 1,
            character: loc.range?.start.character ?? 0,
          });
        }
      } catch {
        // server hiccup — skip; chassis falls back to tree-sitter
      }
    }
    return out;
  }

  /** Compiler-accurate references to the symbol at a given position. */
  async references(absPath: string, line1: number, character: number): Promise<LspLocation[]> {
    const spec = serverFor(absPath);
    if (!spec) return [];
    const session = await this.session(spec);
    if (!session) return [];
    try {
      await this.didOpen(session, absPath);
      const res = (await this.request(session, "textDocument/references", {
        textDocument: { uri: pathToFileURL(absPath).toString() },
        position: { line: line1 - 1, character },
        context: { includeDeclaration: false },
      })) as RawLocation[] | null;
      return (res ?? [])
        .filter((l) => l?.uri)
        .map((l) => ({ file: uriToPath(l.uri), line: (l.range?.start.line ?? 0) + 1 }));
    } catch {
      return [];
    }
  }

  /** The full line span (1-based, inclusive) of a symbol named `name` in a file,
   *  from the server's `textDocument/documentSymbol` — compiler-accurate. `nearLine`
   *  disambiguates when the name occurs more than once. Null when unavailable. */
  async symbolRange(absPath: string, name: string, nearLine?: number): Promise<LineSpan | null> {
    const spec = serverFor(absPath);
    if (!spec) return null;
    const session = await this.session(spec);
    if (!session) return null;
    try {
      await this.didOpen(session, absPath);
      const res = (await this.request(session, "textDocument/documentSymbol", {
        textDocument: { uri: pathToFileURL(absPath).toString() },
      })) as RawDocSymbol[] | null;
      const matches = flattenDocSymbols(res).filter((s) => s.name === name);
      return pickNearest(
        matches.map((s) => ({ start: s.start, end: s.end })),
        nearLine,
      );
    } catch {
      return null;
    }
  }

  /** Compiler/linter diagnostics for a file. Syncs the current on-disk contents
   *  to the server first (didChange/didOpen), then waits briefly for the server to
   *  publish. Empty when no server handles the file. */
  async diagnostics(absPath: string): Promise<CodeDiagnostic[]> {
    const spec = serverFor(absPath);
    if (!spec) return [];
    const session = await this.session(spec);
    if (!session) return [];

    let text: string;
    try {
      text = await fs.readFile(absPath, "utf8");
    } catch {
      return [];
    }
    const shown = absPath.split("\\").join("/");
    const key = fileKey(absPath);
    const uri = pathToFileURL(absPath).toString();
    // Clear so we can detect a FRESH publish (an empty array is a valid "clean" result).
    this.diagnosticsByFile.delete(key);
    try {
      if (session.opened.has(absPath)) {
        const version = (this.versions.get(key) ?? 1) + 1;
        this.versions.set(key, version);
        session.conn.sendNotification("textDocument/didChange", {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      } else {
        await this.didOpen(session, absPath);
        this.versions.set(key, 1);
      }
    } catch {
      return [];
    }

    // Wait (bounded) for the server to publish for this file.
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !this.diagnosticsByFile.has(key)) {
      await delay(60);
    }
    return (this.diagnosticsByFile.get(key) ?? []).map((d) => toCodeDiagnostic(shown, d));
  }

  /** Process ids of the servers currently tracked. Lets a caller (and the tests)
   *  check that teardown actually reaped them, rather than that it returned. */
  pids(): number[] {
    return this.procs.map((t) => t.proc.pid).filter((p): p is number => p !== undefined);
  }

  /**
   * Ask every server to stop the way the protocol says to, then kill it.
   *
   * LSP requires `shutdown` (a request), waiting for its reply, then the `exit`
   * notification. Killing the pipe instead is what leaves a server holding its
   * index, and some servers never exit at all without it. Each server gets a
   * short budget; anything slower is killed rather than waited on, because
   * disposal must not be able to hang a session swap.
   *
   * Use this wherever there is still an event loop. The exit handler cannot
   * await, so it calls `dispose()` directly.
   */
  async shutdown(): Promise<void> {
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (pending) => {
        let session: Session | null = null;
        try {
          session = await pending;
        } catch {
          return; // never started
        }
        if (!session) return;
        try {
          await withTimeout(session.conn.sendRequest("shutdown"), SHUTDOWN_TIMEOUT);
        } catch {
          // Too slow, or already dead. Still send `exit`; the kill is the backstop.
        }
        try {
          await session.conn.sendNotification("exit");
        } catch {
          // The server can close the pipe the instant it exits, so a failed write
          // here is the expected case, not an error.
        }
        // Tear the connection down BEFORE killing. Left listening, its writer can
        // flush a queued frame into a pipe the exiting server already closed, which
        // surfaces as an unhandled EPIPE with nothing left to catch it.
        try {
          session.conn.dispose();
        } catch {
          /* already disposed */
        }
      }),
    );
    this.dispose();
  }

  /**
   * Kill all language servers. Synchronous, so it also works from a process-exit
   * handler, where Node runs no async work at all.
   *
   * Always kills the TREE. A shelled server (a Windows `.cmd` shim, which is how
   * npm-installed servers arrive) is `cmd.exe` rather than the server, so
   * `proc.kill()` there kills the wrapper and orphans the real process — and off
   * Windows the same is true of any server launched through `npx` or a venv shim.
   * Gating this on `shelled` meant macOS and Linux never tree-killed at all.
   */
  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const { proc } of this.procs) {
      try {
        killTreeSync(proc.pid);
        proc.kill();
      } catch {
        /* already gone */
      }
    }
    this.procs = [];
    this.sessions.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Kill one server and stop tracking it. */
  private kill(proc: ChildProcess, _shelled: boolean): void {
    this.procs = this.procs.filter((t) => t.proc !== proc);
    try {
      killTreeSync(proc.pid);
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  private distinctSpecs(): ServerSpec[] {
    const byKey = new Map<string, ServerSpec>();
    for (const lang of this.languages) {
      const spec = specForLanguage(lang);
      if (spec) byKey.set(spec.key, spec);
    }
    return [...byKey.values()];
  }

  private session(spec: ServerSpec): Promise<Session | null> {
    if (this.disposed) return Promise.resolve(null);
    // A query, so the idle clock restarts — a server in active use is never reaped.
    this.lastActivity = Date.now();
    let existing = this.sessions.get(spec.key);
    if (!existing) {
      existing = this.launch(spec).catch(() => null);
      this.sessions.set(spec.key, existing);
    }
    return existing;
  }

  private async launch(spec: ServerSpec): Promise<Session | null> {
    // Windows npm-installed servers are .cmd/.bat shims and can't be spawned
    // directly (recent Node rejects them) — run those through the shell.
    const winShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(spec.command);
    const proc = winShim
      ? spawnManaged(`"${spec.command}" ${spec.args.join(" ")}`, [], {
          cwd: this.root,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: true,
        })
      : spawnManaged(spec.command, spec.args, {
          cwd: this.root,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
    // Track BEFORE any early return: a process we spawned but never recorded is
    // one `dispose()` can never reach, and it outlives the session.
    this.procs.push({ proc, shelled: winShim });
    if (!proc.stdout || !proc.stdin) {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      return null;
    }
    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    conn.onError(() => {});
    // Language servers push diagnostics as an unsolicited notification; keep the
    // latest per file so `diagnostics()` can read them after syncing a file.
    conn.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
      const p = params as { uri?: string; diagnostics?: RawDiagnostic[] };
      if (p?.uri) this.diagnosticsByFile.set(fileKey(uriToPath(p.uri)), p.diagnostics ?? []);
    });
    conn.listen();

    const rootUri = pathToFileURL(this.root).toString();
    try {
      await withTimeout(
        conn.sendRequest("initialize", {
          processId: process.pid,
          rootUri,
          capabilities: CLIENT_CAPABILITIES,
          workspaceFolders: [{ uri: rootUri, name: "root" }],
        }),
        INIT_TIMEOUT,
      );
    } catch (err) {
      // A server that never finished initializing is unreachable from here on
      // (the session caches null and nothing retries), but it is very much still
      // running and indexing. Abandoning it leaves it burning CPU for the rest of
      // the session, so kill it on the way out rather than waiting for dispose.
      this.kill(proc, winShim);
      throw err;
    }
    conn.sendNotification("initialized", {});
    return { conn, proc, opened: new Set() };
  }

  /** Open the noted files this server handles, so the project is loaded/indexed.
   *  Bounded per call AND across the session — see `filesToOpen`. */
  /** Opens what this query needs and reports HOW MANY it opened, which is what
   *  tells `symbols` whether an empty result might just be a cold index. */
  private async ensureProjectOpen(session: Session, spec: ServerSpec): Promise<number> {
    let opened = 0;
    for (const path of filesToOpen(this.files, session.opened, spec.key)) {
      const before = session.opened.size;
      await this.didOpen(session, path);
      if (session.opened.size > before) opened++;
    }
    return opened;
  }

  /**
   * `workspace/symbol`, retried while the index may still be filling.
   *
   * The delays back off and stop; the total is bounded and is paid at most once per
   * server, on the first query after documents were opened. A server that has been
   * asked and has nothing is answered on the first attempt — the retry exists for the
   * server that has not finished reading yet, which is indistinguishable from it in
   * the reply and distinguishable in time.
   */
  private async querySymbols(session: Session, name: string, mayBeCold: boolean): Promise<RawSymbol[] | null> {
    const delays = mayBeCold ? INDEX_RETRY_DELAYS : [];
    for (let attempt = 0; ; attempt++) {
      const res = (await this.request(session, "workspace/symbol", { query: name })) as RawSymbol[] | null;
      if ((res?.length ?? 0) > 0 || attempt >= delays.length) return res;
      await new Promise((r) => setTimeout(r, delays[attempt]!));
    }
  }

  private async didOpen(session: Session, absPath: string): Promise<void> {
    if (session.opened.has(absPath)) return;
    const langId = languageIdFor(absPath) ?? "plaintext";
    let text = "";
    try {
      text = await fs.readFile(absPath, "utf8");
    } catch {
      return;
    }
    session.conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri: pathToFileURL(absPath).toString(), languageId: langId, version: 1, text },
    });
    session.opened.add(absPath);
  }

  private request(session: Session, method: string, params: unknown): Promise<unknown> {
    return withTimeout(session.conn.sendRequest(method, params), REQUEST_TIMEOUT);
  }
}

interface RawLocation {
  uri: string;
  range?: { start: { line: number; character: number } };
}

interface RawDiagnostic {
  range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
  severity?: number; // 1=Error 2=Warning 3=Information 4=Hint
  message?: string;
  source?: string;
}

/** Map an LSP diagnostic to our shape (1-based line/col). */
function toCodeDiagnostic(file: string, d: RawDiagnostic): CodeDiagnostic {
  const sev = d.severity;
  const severity = sev === 1 ? "error" : sev === 2 ? "warning" : sev === 3 ? "info" : "hint";
  const startLine = d.range?.start?.line;
  const endLine = d.range?.end?.line;
  // Only carries over when the token doesn't cross a line — a caret under a
  // single source line has no meaning for a genuinely multi-line span.
  const endColumn =
    startLine != null && endLine === startLine && d.range?.end?.character != null
      ? d.range.end.character + 1
      : undefined;
  return {
    file,
    line: (startLine ?? 0) + 1,
    column: (d.range?.start?.character ?? 0) + 1,
    severity,
    message: (d.message ?? "").trim(),
    ...(d.source ? { source: d.source } : {}),
    ...(endColumn != null ? { endColumn } : {}),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
interface RawSymbol {
  name: string;
  kind: number;
  location: RawLocation;
}

/**
 * The key a file's diagnostics are kept under. Windows paths are case-insensitive and
 * servers do not echo the spelling they were sent: the TypeScript server publishes for
 * `file:///c%3A/...` a file opened as `C:\...`. Keyed by the raw path, every publish was
 * stored under a name nobody looked up, and diagnostics() always returned nothing.
 */
function fileKey(path: string): string {
  const slashed = path.split("\\").join("/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri).split("\\").join("/");
  } catch {
    return uri;
  }
}

// LSP SymbolKind (numeric) → our SymbolKind.
function symbolKind(k: number): SymbolKind {
  switch (k) {
    case 5:
      return "class";
    case 6:
    case 9:
      return "method";
    case 8:
      return "field";
    case 10:
      return "enum";
    case 11:
      return "interface";
    case 12:
      return "function";
    case 13:
      return "variable";
    case 14:
      return "constant";
    case 23:
      return "struct";
    case 2:
    case 3:
      return "module";
    default:
      return "other";
  }
}

/**
 * Which files to open for one server on this call, bounded two ways.
 *
 * `OPEN_BATCH` bounds a single query's latency (each open reads a file and ships
 * its whole text). `MAX_OPEN_DOCS` bounds the SESSION: without it every query
 * opened a fresh batch, so a long session fed the entire repo to the server one
 * query at a time, and nothing ever closed a document. The per-call limit alone
 * reads like a bound and is not one.
 *
 * Pure so the bound is testable without spawning a language server.
 */
export function filesToOpen(
  known: Iterable<string>,
  opened: ReadonlySet<string>,
  specKey: string,
  serverKeyFor: (path: string) => string | undefined = (p) => serverFor(p)?.key,
): string[] {
  const room = MAX_OPEN_DOCS - opened.size;
  if (room <= 0) return [];
  const budget = Math.min(room, OPEN_BATCH);
  const out: string[] = [];
  for (const path of known) {
    if (out.length >= budget) break;
    if (serverKeyFor(path) !== specKey || opened.has(path)) continue;
    out.push(path);
  }
  return out;
}

function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lsp timeout")), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
