/**
 * trust.ts — noticing when a server changes what its tools claim to do.
 *
 * A tool description is not documentation. It is text written by a third party that
 * goes straight into the model's prompt and is read as instruction. That makes the
 * description an injection surface, and the 2026 literature on MCP converges on one
 * structural cause for the whole family of attacks: **clients inherit trust from the
 * servers they connect to and never verify it again.**
 *
 * Three named variants:
 *   - Tool poisoning     — hidden instructions in a description or schema.
 *   - Rug pull           — a clean server ships an update that poisons a description,
 *                          and clients reload it silently.
 *   - Cross-server shadow — one server's description manipulates the agent into
 *                          misusing a DIFFERENT server's tools.
 *
 * This module addresses the second one, and only the second one. We fingerprint every
 * tool's description and schema on first sight, persist it, and refuse a tool whose
 * fingerprint has moved until the user looks at the change. That is deterministic and
 * fires regardless of what the model does.
 *
 * WHAT THIS DOES NOT DO, stated plainly here and in SECURITY.md because implying
 * otherwise would be worse than not having it: a server that is malicious on day one
 * passes every check in this file. First sight is trusted by construction — there is no
 * signature to verify, no reputation to consult. This catches CHANGE, not badness. No
 * MCP client currently solves the day-one case, and pretending we do would be the kind
 * of claim that quietly becomes a lie.
 *
 * The decisions are pure; `store.ts` does the disk work.
 */
import { createHash } from "node:crypto";
import type { McpToolDef } from "./catalog.js";
import { mcpToolName, parseMcpToolName } from "./catalog.js";

/** A tool's fingerprint: what it claims to do and what it claims to accept. */
export function fingerprint(def: McpToolDef): string {
  // Description AND schema. A poisoned parameter description is the same attack as a
  // poisoned tool description, and hashing only the latter would miss it entirely.
  const material = JSON.stringify({ d: def.description, s: def.inputSchema });
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** name → fingerprint, as persisted between sessions. */
export type TrustRecord = Record<string, string>;

/** Build the fingerprint record for a whole catalog. */
export function fingerprintCatalog(defs: readonly McpToolDef[]): TrustRecord {
  const out: TrustRecord = {};
  for (const def of defs) out[mcpToolName(def.server, def.name)] = fingerprint(def);
  return out;
}

export interface TrustVerdict {
  /** Tools seen before, unchanged. Safe to use. */
  unchanged: string[];
  /** Tools never seen before. Trusted on first sight — see the caveat above. */
  fresh: string[];
  /** Tools whose description or schema MOVED since we last saw them. */
  changed: string[];
}

/**
 * Compare a live catalog against what we recorded last time (pure).
 *
 * Note what is NOT flagged: a tool that disappeared. A server dropping a tool cannot
 * inject anything, and treating removal as suspicious would make every ordinary server
 * upgrade look like an attack — which trains the user to click through the prompt, which
 * is how a real warning gets ignored.
 */
export function compareTrust(defs: readonly McpToolDef[], known: TrustRecord): TrustVerdict {
  const verdict: TrustVerdict = { unchanged: [], fresh: [], changed: [] };
  for (const def of defs) {
    const name = mcpToolName(def.server, def.name);
    const now = fingerprint(def);
    const before = known[name];
    if (before === undefined) verdict.fresh.push(name);
    else if (before === now) verdict.unchanged.push(name);
    else verdict.changed.push(name);
  }
  verdict.fresh.sort();
  verdict.changed.sort();
  verdict.unchanged.sort();
  return verdict;
}

/**
 * A server's own instructions travel through the trust check as if they were one more tool
 * under this name. No real tool can carry it: it is not a valid tool name.
 */
export const SERVER_INSTRUCTIONS = "(server instructions)";

/** Is this entry in the trust record a server's instructions rather than a tool? */
export function isInstructionsEntry(name: string): boolean {
  return parseMcpToolName(name)?.tool === SERVER_INSTRUCTIONS;
}

/** How one held entry reads to a person: a tool by its name, a server's instructions as such. */
export function changedLabel(name: string): string {
  const parsed = parseMcpToolName(name);
  return parsed?.tool === SERVER_INSTRUCTIONS ? `${parsed.server} instructions` : name;
}

/** What was held, counted: "2 MCP tools", "the instructions of 1 MCP server", or both. */
export function changedPhrase(names: readonly string[]): string {
  const instructions = names.filter(isInstructionsEntry).length;
  const tools = names.length - instructions;
  const parts: string[] = [];
  if (tools > 0) parts.push(`${tools} MCP tool${tools === 1 ? "" : "s"}`);
  if (instructions > 0) parts.push(`the instructions of ${instructions} MCP server${instructions === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

/**
 * The question put to the user when a tool's description, or a server's instructions, has moved (pure).
 *
 * Deliberately concrete about what changed and what the risk is. "Trust this server?"
 * is unanswerable; "this tool's description changed since you last used it, and a
 * description is instructions the agent follows" is a question someone can actually
 * decide.
 */
export function changedToolsQuestion(changed: readonly string[]): string {
  const shown = changed.map(changedLabel);
  const list = shown.length <= 3 ? shown.join(", ") : `${shown.slice(0, 3).join(", ")} and ${shown.length - 3} more`;
  const it = changed.length === 1 ? "it" : "them";
  const instructions = changed.filter(isInstructionsEntry).length;
  if (instructions === 0) {
    return (
      `An MCP server changed what ${changed.length === 1 ? "a tool claims" : "some tools claim"} to do since you last ` +
      `used ${it}: ${list}. Tool descriptions are instructions the agent follows, so ` +
      `a silent change is how a trusted server turns hostile. Allow ${it}?`
    );
  }
  const what =
    instructions === changed.length
      ? changed.length === 1
        ? "what its instructions to the agent say"
        : "what their instructions to the agent say"
      : "what its tools or its instructions to the agent say";
  return (
    `An MCP server changed ${what} since you last used ${it}: ${list}. Tool descriptions and server instructions ` +
    `are both text the agent follows, so a silent change is how a trusted server turns hostile. Allow ${it}?`
  );
}

/** Merge accepted tools into the stored record, leaving refused ones flagged. */
export function acceptTools(known: TrustRecord, defs: readonly McpToolDef[], accept: readonly string[]): TrustRecord {
  const next = { ...known };
  const wanted = new Set(accept);
  for (const def of defs) {
    const name = mcpToolName(def.server, def.name);
    if (wanted.has(name)) next[name] = fingerprint(def);
  }
  return next;
}
