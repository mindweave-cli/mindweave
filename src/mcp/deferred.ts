/**
 * deferred.ts — showing the model a few good tools instead of every tool.
 *
 * Why this exists, stated carefully, because the usual justification is wrong for us:
 * it is NOT about running out of context. DeepSeek V4 stores 1M tokens, so even a
 * 30,000-token catalog is a few percent of the window. The reason is **selection
 * accuracy**. A model choosing among 300 tools chooses worse than one choosing among
 * 40, at any context length, and that degradation does not care how much room is left.
 * The token saving is a real but secondary benefit.
 *
 * The mechanism: past a threshold, MCP tools are held back from the advertised list and
 * the model gets one search tool instead. Searching ACTIVATES the matches, which join
 * the advertised list from the next step onward and stay for the rest of the session.
 *
 * That interacts with the per-turn catalog freeze from Phase 3, and the trade is
 * deliberate: activating a tool changes the `tools` array and therefore costs one
 * prompt-cache invalidation. It is worth it because it happens when the model actually
 * reaches for something, once, rather than paying for the whole catalog on every turn.
 * Activation being sticky is what keeps it to once.
 *
 * Everything here is pure. The ranking is the part most likely to need tuning against
 * real behaviour, so it must be adjustable without a live server.
 */
import type { McpToolDef } from "./catalog.js";
import { mcpToolName } from "./catalog.js";

/**
 * Catalogs at or below this many tools are advertised in full.
 *
 * Below the threshold, deferral is strictly WORSE: the model pays a search round trip
 * to reach tools it could simply have been shown, and a small catalog costs little to
 * send. The point is to fix the many-tools case, not to hide three tools behind a menu.
 */
export const DEFER_THRESHOLD = 25;

/** How many results one search returns. Enough to choose from, few enough to read. */
export const MAX_SEARCH_RESULTS = 8;
/** The most one search may be asked for. Each tool costs its full schema. */
export const MAX_SEARCH_RESULTS_ASKED = 30;

/** Should this catalog be held back behind search? */
export function shouldDefer(toolCount: number, threshold = DEFER_THRESHOLD): boolean {
  return toolCount > threshold;
}

/** Split a tool name into lowercase parts: `mcp__github__create_issue` → github, create, issue. */
export function nameParts(def: McpToolDef): string[] {
  return `${def.server} ${def.name}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Score one tool against the query terms (pure).
 *
 * Weights are deliberately blunt. This is keyword matching, not retrieval: the model
 * already knows roughly what it wants and usually queries with a server name ("github"),
 * an action ("create issue"), or the tool name itself. Precision matters less than never
 * returning nothing useful for a reasonable query.
 */
export function scoreTool(def: McpToolDef, terms: readonly string[]): number {
  const parts = nameParts(def);
  const description = def.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (parts.includes(term)) score += 10; // whole word in the name: the strongest signal
    else if (parts.some((p) => p.includes(term))) score += 5;
    // A description match is weak on its own — descriptions are long and mention a lot.
    if (description.includes(term)) score += 2;
  }
  return score;
}

/** The names in a `select:a,b` query, or null when it is not one (pure). */
export function selectedNames(query: string): string[] | null {
  const m = /^select:(.*)$/i.exec(query.trim());
  if (!m) return null;
  return m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The line that says how much of what matched is being shown (pure). First in the result, ahead of the
 * schemas: at the end it came after thousands of tokens, and a model read eight tools as all it had.
 */
export function searchHeadline(shown: number, matched: number, connected: number): string {
  const total = `${connected} MCP tool${connected === 1 ? "" : "s"} connected in all`;
  if (shown < matched) {
    return `Showing ${shown} of the ${matched} MCP tools that match (${total}). The rest exist and are not shown: pass max_results, narrow the search, or load exact names with select:name1,name2.`;
  }
  return `Loaded ${shown} MCP tool${shown === 1 ? "" : "s"}, every one that matches (${total}). You can call ${shown === 1 ? "it" : "them"} now:`;
}

/**
 * Find tools matching a query (pure).
 *
 * The two special cases at the top are not politeness, they are the failure modes this
 * kind of search actually hits. A model that already knows the exact tool name will
 * pass it verbatim rather than describing it, and a model that knows the server will
 * pass `mcp__server`. Both look like zero-scoring queries to a keyword ranker and would
 * return nothing, which reads to the model as "that tool does not exist" — so it stops
 * asking and guesses instead. Handling them is what keeps search from being a dead end.
 */
export function searchCatalog(query: string, defs: readonly McpToolDef[], max = MAX_SEARCH_RESULTS): McpToolDef[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  // Exact advertised name, or exact bare name.
  const exact = defs.find((d) => mcpToolName(d.server, d.name).toLowerCase() === q || d.name.toLowerCase() === q);
  if (exact) return [exact];

  // A server prefix: give back that server's tools.
  if (q.startsWith("mcp__")) {
    const prefixed = defs.filter((d) => mcpToolName(d.server, d.name).toLowerCase().startsWith(q));
    if (prefixed.length > 0) return prefixed.slice(0, max);
  }

  // A bare server name: same idea, without the prefix.
  const byServer = defs.filter((d) => d.server.toLowerCase() === q);
  if (byServer.length > 0) return byServer.slice(0, max);

  const terms = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored = defs
    .map((def) => ({ def, score: scoreTool(def, terms) }))
    .filter((s) => s.score > 0)
    // Ties break on name so results are stable between identical searches.
    .sort((a, b) => b.score - a.score || mcpToolName(a.def.server, a.def.name).localeCompare(mcpToolName(b.def.server, b.def.name)));

  return scored.slice(0, max).map((s) => s.def);
}

/**
 * Render search results for the model: each match's full callable definition.
 *
 * The FULL schema, not a summary line, and that is what makes deferral pay. A summary
 * only tells the model a tool exists; it then has to be added to the advertised `tools`
 * array before it can be called, and that rewrites the provider's cached prefix — tools,
 * system and messages — at full price. Delivered here instead, the schema rides in an
 * appended message: every earlier byte is untouched, the cache survives, and the schema
 * is itself cached from the next call onward. Dispatch resolves against the catalog
 * rather than against what was advertised, so a name and a schema is all it takes.
 */
export function renderResults(defs: readonly McpToolDef[]): string {
  return defs
    .map((d) =>
      `<function>${JSON.stringify({
        name: mcpToolName(d.server, d.name),
        description: d.description,
        parameters: d.inputSchema,
      })}</function>`,
    )
    .join("\n");
}
