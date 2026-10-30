/**
 * discover.ts — deciding, once per connection, which MCP a server actually speaks.
 *
 * 2026-07-28 added `server/discover`, a required RPC that reports a server's supported
 * protocol versions, capabilities and identity before any other call. That is the happy
 * path. The problem is everything else: the overwhelming majority of servers deployed
 * today predate the revision, have never heard of the method, and expect the
 * `initialize` handshake that 2026-07-28 deleted.
 *
 * So connecting is a PROBE, not an assumption:
 *
 *   1. Call `server/discover`. If it answers, take the newest version we both know
 *      and speak that dialect.
 *   2. If it comes back "method not found", that IS the compatibility signal — the
 *      server is pre-stateless. Fall back to `initialize`, and speak whatever version
 *      it reports back.
 *   3. If neither works, the server is not usable; the pool records it as failed and
 *      the session carries on without it.
 *
 * The decision itself (`negotiate`) is a pure function over two version lists, so the
 * whole matrix is unit-tested rather than discovered against live servers. Only the
 * probe does I/O.
 */
import {
  PREFERRED_VERSION,
  SUPPORTED_VERSIONS,
  dialectFor,
  isMethodNotFound,
  type ClientCapabilities,
  type ClientIdentity,
  type Dialect,
} from "./protocol.js";

/** What a completed probe tells the connection layer. */
export interface Negotiated {
  version: string;
  dialect: Dialect;
  /** Server-reported identity, when it gave one. */
  serverInfo?: { name: string; version?: string };
  /** What the server says about how to use it, when it says anything. */
  instructions?: string;
  capabilities: Record<string, unknown>;
  /** True when we got here through the legacy `initialize` path. */
  legacy: boolean;
}

/**
 * Pick the best protocol version we and the server both support (pure).
 *
 * "Best" is NEWEST, not first-listed: a server may advertise in any order, and taking
 * its preference would silently pin us to an old dialect whenever a server lists
 * chronologically. Returns null when there is no overlap at all, which is a real
 * outcome (`UnsupportedProtocolVersionError`) and not an error to swallow.
 */
export function negotiate(
  serverVersions: readonly string[],
  clientVersions: readonly string[] = SUPPORTED_VERSIONS,
): string | null {
  const ours = new Set(clientVersions);
  const shared = serverVersions.filter((v) => ours.has(v));
  if (shared.length === 0) return null;
  // ISO dates sort lexicographically, so this is a plain descending sort.
  return shared.sort().reverse()[0]!;
}

/**
 * A single version string reported by a legacy `initialize` (pure).
 *
 * Old servers answer with one `protocolVersion`, not a list. If we know it, use it. If
 * we do not, the server is speaking something outside our range and we do NOT guess:
 * pretending to speak an unknown revision is how a client ends up sending fields a
 * server rejects halfway through a session.
 */
export function acceptLegacyVersion(reported: unknown, clientVersions: readonly string[] = SUPPORTED_VERSIONS): string | null {
  if (typeof reported !== "string" || !reported.trim()) return null;
  return clientVersions.includes(reported) ? reported : null;
}

/** The RPC surface the probe needs, so it can be driven by any transport (or a test). */
export interface ProbeRpc {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
}

/** Raised when a server answers but shares no protocol revision with us. */
export class UnsupportedProtocolVersionError extends Error {
  constructor(readonly serverVersions: readonly string[]) {
    super(
      `no shared MCP protocol version (server offers ${serverVersions.join(", ") || "nothing"}; ` +
        `this client speaks ${SUPPORTED_VERSIONS.join(", ")})`,
    );
    this.name = "UnsupportedProtocolVersionError";
  }
}

/**
 * Run the probe against a live server and settle on a dialect.
 *
 * Note the ORDER: `server/discover` first, always. Trying `initialize` first would
 * work against everything today and quietly rot, because a 2026-07-28 server has no
 * `initialize` to answer. Leading with the new method and treating method-not-found as
 * the legacy signal is the direction that ages correctly.
 */
export async function probe(rpc: ProbeRpc, identity: ClientIdentity, capabilities: ClientCapabilities): Promise<Negotiated> {
  try {
    const result = (await rpc.request("server/discover")) as {
      protocolVersions?: unknown;
      capabilities?: unknown;
      serverInfo?: { name?: unknown; version?: unknown };
      instructions?: unknown;
    };
    const offered = Array.isArray(result?.protocolVersions) ? result.protocolVersions.filter((v): v is string => typeof v === "string") : [];
    const chosen = negotiate(offered);
    if (!chosen) throw new UnsupportedProtocolVersionError(offered);
    return {
      version: chosen,
      dialect: dialectFor(chosen),
      capabilities: asRecord(result?.capabilities),
      legacy: false,
      ...(serverInfoOf(result?.serverInfo) ? { serverInfo: serverInfoOf(result?.serverInfo)! } : {}),
      ...instructionsOf(result?.instructions),
    };
  } catch (error) {
    // A version mismatch is a real answer, not a reason to try the old path.
    if (error instanceof UnsupportedProtocolVersionError) throw error;
    if (!looksLikeMethodNotFound(error)) throw error;
  }

  // Legacy path: this server predates `server/discover`.
  const init = (await rpc.request("initialize", {
    protocolVersion: PREFERRED_VERSION,
    capabilities,
    clientInfo: { name: identity.name, version: identity.version },
  })) as { protocolVersion?: unknown; capabilities?: unknown; serverInfo?: { name?: unknown; version?: unknown }; instructions?: unknown };

  const version = acceptLegacyVersion(init?.protocolVersion);
  if (!version) {
    throw new UnsupportedProtocolVersionError(typeof init?.protocolVersion === "string" ? [init.protocolVersion] : []);
  }
  rpc.notify("notifications/initialized");
  return {
    version,
    dialect: dialectFor(version),
    capabilities: asRecord(init?.capabilities),
    legacy: true,
    ...(serverInfoOf(init?.serverInfo) ? { serverInfo: serverInfoOf(init?.serverInfo)! } : {}),
    ...instructionsOf(init?.instructions),
  };
}

/** Does a thrown transport error carry a JSON-RPC "method not found"? */
function looksLikeMethodNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "number" ? e.code : NaN;
  const message = typeof e?.message === "string" ? e.message : "";
  return isMethodNotFound(code, message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function instructionsOf(value: unknown): { instructions?: string } {
  return typeof value === "string" && value.trim() ? { instructions: value.trim() } : {};
}

function serverInfoOf(info: { name?: unknown; version?: unknown } | undefined): { name: string; version?: string } | undefined {
  if (!info || typeof info.name !== "string" || !info.name.trim()) return undefined;
  return { name: info.name, ...(typeof info.version === "string" ? { version: info.version } : {}) };
}
