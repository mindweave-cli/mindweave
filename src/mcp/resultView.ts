/**
 * resultView.ts — how an MCP tool call reads on screen (pure).
 *
 * What the model gets is the server's text, framed as untrusted data (see manager.ts). What
 * a PERSON gets is a different job: say whether it worked, say why it did not, and keep the
 * arguments and the answer one click away. The row used to print "Status: Connected
 * [Latency: 5ms] / Executed: x() / Received an error result" in red: "Connected" described
 * the pipe, not the call, so a failed call read as a success that was painted red, and the
 * one sentence that mattered (the server's own explanation) was nowhere on the screen.
 *
 * Servers answer an error in two shapes. Most put plain text in the content; the better ones
 * return JSON such as `{"error":{"code":"target_unavailable","message":"No app is open."}}`.
 * Both are reduced here to the one line a person would want.
 */

/** Longest a single reason is kept, so a server that returns a paragraph still gets a row. */
const REASON_MAX = 400;

/** Lines of a result kept for the row's own block, and for the opened one. */
export const RESULT_LINES_SHOWN = 14;
export const RESULT_LINES_FULL = 400;

function tryJson(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** The message inside a JSON error, in whichever of the common shapes it came. */
function jsonReason(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  const inner = o.error ?? o.err;
  if (typeof inner === "string" && inner.trim()) return inner.trim();
  if (inner && typeof inner === "object") {
    const e = inner as Record<string, unknown>;
    const message = typeof e.message === "string" ? e.message.trim() : "";
    const code = typeof e.code === "string" || typeof e.code === "number" ? String(e.code) : "";
    if (message) return message;
    if (code) return code;
  }
  if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
  return undefined;
}

/**
 * The one-line reason a call failed (pure): the server's own message when it gave one,
 * otherwise the first line it printed, without a leading "Error:". Never empty.
 */
export function mcpErrorReason(text: string): string {
  const fromJson = jsonReason(tryJson(text));
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  const reason = (fromJson ?? first ?? "the server reported an error and said nothing more").replace(/^error:\s*/i, "");
  return reason.length > REASON_MAX ? reason.slice(0, REASON_MAX - 1) + "…" : reason;
}

/** How long a call took, as a person reads it: `5ms`, `1.4s`, `2m 10s` (pure). */
export function elapsedLabel(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * The row's verdict text (pure): how long it took when it worked, why it did not when it
 * did not. The screen puts the mark (✓ or ✗) in front of it.
 */
export function mcpSummary(isError: boolean, text: string, elapsedMs?: number): string {
  if (isError) return mcpErrorReason(text);
  return elapsedMs === undefined ? "" : elapsedLabel(elapsedMs);
}

/** The arguments on one line, clipped (pure). `no arguments` when there are none. */
export function argsLine(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return "no arguments";
  const json = JSON.stringify(args);
  return json.length > 300 ? json.slice(0, 299) + "…" : json;
}

/** A result's lines for reading (pure): JSON laid out, anything else as it came. */
export function resultLines(text: string): string[] {
  const parsed = tryJson(text);
  const body = parsed !== undefined ? JSON.stringify(parsed, null, 2) : text;
  const lines = body.split("\n").map((l) => l.replace(/\s+$/, ""));
  // No run of blank lines, none at either end.
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * What opens under a call (pure): what it was asked, then what came back. `limit` cuts the
 * result with the same "… (N more lines)" note every other cut block uses, so the row can
 * say how much is behind it.
 */
export function mcpDetailText(args: Record<string, unknown>, text: string, limit: number): string {
  const lines = resultLines(text);
  const shown = lines.length > limit ? [...lines.slice(0, limit), `  … (${lines.length - limit} more line${lines.length - limit === 1 ? "" : "s"})`] : lines;
  return [`asked  ${argsLine(args)}`, ...(shown.length > 0 ? ["", ...shown] : ["", "(it returned nothing)"])].join("\n");
}
