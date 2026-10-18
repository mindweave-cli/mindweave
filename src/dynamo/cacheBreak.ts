/**
 * cacheBreak.ts — noticing when the cached prefix stopped matching, and saying why.
 *
 * Every provider caches the same way: it hashes the front of the request and reuses the
 * work if the next request starts with the same bytes. Change one character anywhere in
 * that region and the whole thing is re-read at full price. The region is large — the
 * system prompt plus every tool schema — so a break is one of the most expensive events
 * in a session, and it is completely invisible. Nothing fails. The reply is normal. The
 * only trace is on the bill.
 *
 * Two real ones shipped before this existed, and both were found by reading a session
 * file after the user had already paid: a skill catalog that varied with which files had
 * been read, and a tool search that added its result to the advertised list. Neither
 * announced itself, and neither was findable except in hindsight.
 *
 * So the prefix is hashed on the way out and compared with the last one. When it moves,
 * this says WHICH part moved — the model, the system prompt, a tool appearing or
 * disappearing, or one tool's schema changing under a stable name. That last case is the
 * one worth the per-tool hashes: a tool whose description is built from live state looks
 * identical by name and count while breaking the cache on every request.
 *
 * Provider-neutral by construction. It compares what WE send, so it needs no cache
 * reporting from anyone and works the same on a provider that documents nothing.
 *
 * A break is not automatically a bug — switching model or compacting invalidates the
 * prefix by design. The point is that it should be a decision someone made, not a
 * surprise, and an unexplained one is a defect that has already started costing money.
 */
import { appendFileSync } from "node:fs";
import type { ToolSchema } from "../tools/types.js";
import type { ChatMessage } from "../drivers/types.js";

/** The prefix as a set of comparable fingerprints. Hashes, not content: this is held for
 *  the life of a session and compared every call, so it must stay small. */
export interface PrefixPrint {
  model: string;
  system: number;
  /** Per tool, by name. Named separately so a changed schema can be attributed to the
   *  tool it belongs to rather than reported as "the tools changed". */
  tools: Record<string, number>;
  /** Kept only to describe the size of a system-prompt change in the report. */
  systemChars: number;
  /**
   * One hash per message, in order.
   *
   * The conversation is the OTHER half of the cached prefix, and until this existed it
   * was unwatched — a blind spot big enough to hide the most expensive kind of break.
   * Messages grow every call, which is fine and free; what is not fine is an EARLIER
   * message changing, because that invalidates everything after it. Microcompaction
   * clearing an old tool body, a read being de-duplicated, an image ref being dropped:
   * each rewrites history in place, and none of them would show up in a system or tool
   * hash. Kept per message so the report can say WHICH turn moved rather than that
   * something did.
   */
  messages: number[];
}

/** What moved, in words a person can act on. */
export interface CacheBreak {
  /** Short machine-ish tag: "model", "system", "tools", "tool-schema". */
  kind: "model" | "system" | "tools" | "tool-schema" | "history";
  /** One line naming what changed, specific enough to start looking. */
  detail: string;
}

/**
 * FNV-1a, 32-bit. A non-cryptographic hash is exactly right here: the question is
 * "are these the same bytes", collisions cost a missed report rather than a wrong
 * action, and this runs on every request over the whole system prompt.
 */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fingerprint what is about to be sent. */
export function prefixPrint(
  model: string,
  system: string,
  tools: readonly ToolSchema[],
  messages: readonly ChatMessage[] = [],
): PrefixPrint {
  const byName: Record<string, number> = {};
  for (const tool of tools) {
    byName[tool.function.name] = hashString(JSON.stringify(tool));
  }
  return {
    model,
    system: hashString(system),
    tools: byName,
    systemChars: system.length,
    messages: messages.map((m) => hashString(JSON.stringify(m))),
  };
}

/**
 * Compare two fingerprints and report the FIRST thing that broke the prefix, in the
 * order the provider would hit it.
 *
 * One finding, not a list, and the order is the point: the parts are nested, so a model
 * change makes every downstream difference meaningless to report. Naming the outermost
 * cause is what tells someone where to look.
 */
export function diffPrefix(prev: PrefixPrint, next: PrefixPrint): CacheBreak | null {
  if (prev.model !== next.model) {
    return { kind: "model", detail: `model changed (${prev.model} → ${next.model})` };
  }

  const before = Object.keys(prev.tools);
  const after = Object.keys(next.tools);
  const added = after.filter((n) => !(n in prev.tools));
  const removed = before.filter((n) => !(n in next.tools));
  if (added.length > 0 || removed.length > 0) {
    const parts = [
      added.length > 0 ? `+${added.join(", +")}` : "",
      removed.length > 0 ? `-${removed.join(", -")}` : "",
    ].filter(Boolean);
    return { kind: "tools", detail: `the tool list changed (${parts.join(" ")})` };
  }

  // Same names, same count, different bytes: a description or schema built from live
  // state. Invisible to any check that counts tools, and it breaks the cache every call.
  const changed = after.filter((n) => prev.tools[n] !== next.tools[n]);
  if (changed.length > 0) {
    return {
      kind: "tool-schema",
      detail: `${changed.join(", ")} changed shape without changing name — its schema is built from live state`,
    };
  }

  // The system prompt sits in front of the conversation, so it is checked first: when it
  // changes, every message after it is re-billed too, and reporting "message N was
  // rewritten" would blame the wrong part (a real session's biggest break read that way).
  if (prev.system !== next.system) {
    const delta = next.systemChars - prev.systemChars;
    const size = delta === 0 ? "same length" : `${delta > 0 ? "+" : ""}${delta} chars`;
    return { kind: "system", detail: `the system prompt changed (${size})` };
  }

  // The conversation, compared only over the length they SHARE. Growth is the normal
  // case and costs nothing; what breaks the cache is an earlier message changing, and
  // the first one that did is where the damage starts — everything after it is a
  // consequence, not a second finding.
  const shared = Math.min(prev.messages.length, next.messages.length);
  for (let i = 0; i < shared; i++) {
    if (prev.messages[i] !== next.messages[i]) {
      return {
        kind: "history",
        detail: `message ${i + 1} of ${shared} was rewritten — everything after it is re-billed`,
      };
    }
  }
  // Shrinking is a rewrite too, even when every surviving message matches: a dropped
  // turn moves everything that followed it.
  if (next.messages.length < prev.messages.length) {
    return {
      kind: "history",
      detail: `the conversation shrank (${prev.messages.length} → ${next.messages.length} messages)`,
    };
  }

  return null;
}

/**
 * What one model call did to the cache, as a line for a file.
 *
 * The diagnosis above was computed on every call and thrown away, so a break was still
 * only findable by reading a session file afterwards — the exact position this module
 * exists to end. It is written to a file rather than the screen because the screen is a
 * full-frame TUI, and because the question it answers is asked once, deliberately, by
 * someone chasing a bill.
 *
 * Both halves belong on the same line. A break with a hit of zero is our prefix moving;
 * NO break with a hit of zero is the provider's cache having expired, which is a
 * different problem with a different fix and cannot be told apart from either number
 * alone. The gap since the previous call is on the line for the same reason.
 */
export interface CacheCallReport {
  /** Which call of this turn, from 1. */
  call: number;
  /** Milliseconds since the previous call started, or null when this is the first. */
  gapMs: number | null;
  broke: CacheBreak | null;
  promptTokens: number;
  cacheHitTokens: number;
  model: string;
}

/** Format one report. Pure, so what the file will say can be asserted directly. */
export function cacheCallLine(report: CacheCallReport): string {
  const gap = report.gapMs === null ? "first" : `${(report.gapMs / 1000).toFixed(1)}s`;
  const share = report.promptTokens > 0 ? Math.round((report.cacheHitTokens / report.promptTokens) * 100) : 0;
  const broke = report.broke ? `${report.broke.kind} — ${report.broke.detail}` : "none";
  return (
    `call=${report.call} gap=${gap} prompt=${report.promptTokens} ` +
    `hit=${report.cacheHitTokens} (${share}%) model=${report.model} broke=${broke}`
  );
}

/**
 * Append one line to the file named by `MINDWEAVE_CACHE_LOG`, and do nothing at all
 * without it.
 *
 * Read at call time rather than at import, so a session started before the variable was
 * set is not the reason nothing was recorded. One synchronous append per model call is
 * beneath notice next to the call itself — unlike the frame log, which had to buffer
 * because writing was competing with the thing it measured.
 */
export function writeCacheLog(line: string): void {
  const path = process.env.MINDWEAVE_CACHE_LOG ?? "";
  if (!path || path === "0") return;
  try {
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // A diagnostic must never take a turn down with it.
  }
}
