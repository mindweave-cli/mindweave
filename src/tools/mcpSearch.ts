/**
 * mcpSearch.ts — the one door to any capability that is not in the tool list.
 *
 * Two pools sit behind it, for the same reason and with the same mechanics:
 *
 *  - MCP tools. A project wiring up several servers can reach into the hundreds, and a
 *    model choosing among hundreds chooses worse, so past a threshold they are held back.
 *  - Mindweave's OWN occasional tools (`deferred: true` in the registry). Their schemas
 *    were being paid for on every uncached request in every session, including the many
 *    that never touch them.
 *
 * One door rather than two because the model's question is the same either way — "I need
 * to do X and I cannot see a tool for it" — and it has no reason to know which side of
 * the native/external line the answer falls on. Searching ACTIVATES what it finds, for
 * the rest of the session, so the cost is one round trip per capability rather than per
 * call, and the tool list changes once instead of never being right.
 *
 * Registered as an ordinary built-in, so it is always present and costs one tool's worth
 * of schema rather than a catalog's worth.
 */
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { MAX_SEARCH_RESULTS, renderResults } from "../mcp/deferred.js";
import { DEFERRED_TOOLS, matchDeferred, renderToolSchema } from "./deferredNative.js";


export const findTools: Tool = {
  name: "find_tools",
  readOnly: true,
  // Two corrections. It searches the WHOLE catalog, not just the unloaded part, so the
  // old "that aren't already loaded" was simply wrong. And the result cap was invisible
  // — see the note at the call site for why that one is worse than it sounds.
  description:
    "Search for a tool you cannot see in your list, and load the matches so you can call " +
    "them. Covers both your own occasional tools (saving a memory, creating or deleting a " +
    "skill, standing rules and forbidding paths/commands and lifting either, adding or " +
    "disabling an MCP server, what version and model are running, past sessions, workspace " +
    "folders, screenshots) and this project's external MCP integrations (issue trackers, " +
    "databases, cloud APIs, docs systems). Use it whenever a task needs a capability " +
    "you cannot already see a tool for, rather than concluding you do not have it. " +
    "Query with a plain capability word ('memory', 'skill', 'rule', 'screenshot'), " +
    "a server name " +
    "('github'), an action ('create issue', 'search'), or the exact tool name if you " +
    "know it — an exact name and a bare server name are both handled specially, so " +
    "neither is a wasted guess. Matching is on names and descriptions, not meaning: if " +
    "a sensible term finds nothing, try the server's name on its own before concluding " +
    `the integration is absent. One search returns at most ${MAX_SEARCH_RESULTS} tools ` +
    "and tells you when it hit that limit, so a full result is a reason to search again " +
    "more narrowly rather than to assume you have seen everything. Loaded tools stay " +
    "available for the rest of the session: search once per capability, not once per call.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "What you need: a server name, an action, or an exact tool name.",
      },
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { output: "Error: `query` is required.", isError: true, summary: "no query" };

    // BOTH pools are searched, and the native one does NOT short-circuit. It used to,
    // and the tests caught what that costs: "create issue" name-matches the native
    // the native `skill` tool on the word "create", which would swallow a query plainly aimed at
    // an MCP issue tracker and report success while never touching the catalog. A weak
    // keyword hit in one pool must never hide a strong hit in the other, so results are
    // gathered from both and reported together.
    // The FULL schema goes in the result, and nothing is "activated". A result is an
    // appended message, so the cached prefix is untouched and the schema itself is cached
    // from the next call onward. Adding the tool to the advertised list instead rewrites
    // the whole prefix — tools, system AND messages — at full price, which cost several
    // times what the deferral saved. Dispatch resolves against the registry, so a name
    // and a schema is everything the model needs. See deferredNative.renderToolSchema.
    const native = matchDeferred(query);
    // Activate what was found: from now on these are added to the advertised tool list
    // (registry.toolSchemas), so a strict function-calling model can actually emit the
    // call. Without this the schema below is callable in name only — the model sees it and
    // cannot invoke it, because it is not in the request's `tools` array.
    for (const t of native) ctx.activatedTools?.add(t.name);
    const nativeBlock =
      native.length > 0
        ? `${native.length} of your own tool${native.length === 1 ? "" : "s"}, callable from now on:\n\n<functions>\n` +
          native.map(renderToolSchema).join("\n") +
          `\n</functions>`
        : "";

    const mcp = ctx.mcp;
    const snapshot = mcp?.snapshot();

    // No MCP at all: the native pool is the whole answer, for better or worse.
    if (!mcp || !snapshot || snapshot.toolCount === 0) {
      if (nativeBlock) {
        // The native hits are reported, AND the absence of MCP is still stated. A query
        // aimed at an integration ("github") can keyword-match a native tool, and
        // answering with only that match lets the model conclude it got what it asked
        // for — when in fact no server is connected and the thing it wanted is not here.
        return {
          output: `${nativeBlock}\n\nNo MCP servers are connected in this project, so there is nothing else to search.`,
          summary: `loaded ${native.map((t) => t.name).join(", ")}`,
        };
      }
      return {
        output:
          `Nothing matches "${query}". No MCP servers are connected in this project, and none of your own ` +
          `deferred tools (${DEFERRED_TOOLS.map((t) => t.name).join(", ")}) match either. Solve it with the ` +
          `tools you already have rather than guessing a tool name.`,
        summary: `no match for "${query}"`,
      };
    }

    // Under the deferral threshold nothing is hidden. Say so plainly rather than
    // returning results that are already in the tool list — a model that searches here
    // and gets a list back may reasonably conclude it had to.
    if (!snapshot.deferred) {
      const note =
        `All ${snapshot.toolCount} MCP tool${snapshot.toolCount === 1 ? " is" : "s are"} already loaded and visible in ` +
        `your tool list — nothing is hidden there, so you don't need this tool for them. Call the one you want directly.`;
      return {
        output: nativeBlock ? `${nativeBlock}\n\n${note}` : note,
        summary: nativeBlock ? `loaded ${native.map((t) => t.name).join(", ")}` : "nothing deferred",
      };
    }

    const found = mcp.searchCatalogTools(query);
    if (found.length === 0) {
      const note =
        `No MCP tool matches "${query}". There ${snapshot.toolCount === 1 ? "is" : "are"} ${snapshot.toolCount} ` +
        `available in total — try a broader term, or a server name on its own. If nothing fits, this project ` +
        `has no integration for that and you should solve it another way rather than guessing a tool name.`;
      return {
        output: nativeBlock ? `${nativeBlock}\n\n${note}` : note,
        summary: nativeBlock ? `loaded ${native.map((t) => t.name).join(", ")}` : `no match for "${query}"`,
      };
    }

    // A capped search looks exactly like an exhaustive one. That matters more here than
    // anywhere else: search is the ONLY door to a deferred catalog, so a model that gets
    // 8 of a server's 40 tools and no hint of the rest concludes the other 32 do not
    // exist — and they stay hidden AND unactivated. Both sibling MCP listings already
    // announce their cut; this one did not.
    const capped =
      found.length === MAX_SEARCH_RESULTS
        ? `\n\nThat is the top ${MAX_SEARCH_RESULTS}, which is all one search returns — there may be more. ` +
          `If what you need is not here, search again with a narrower term or the server's name.`
        : "";
    const mcpBlock =
      `Loaded ${found.length} MCP tool${found.length === 1 ? "" : "s"} — you can call ` +
      `${found.length === 1 ? "it" : "them"} now:\n\n${renderResults(found)}${capped}`;
    return {
      output: nativeBlock ? `${nativeBlock}\n\n${mcpBlock}` : mcpBlock,
      summary: `loaded ${found.length + native.length} tool${found.length + native.length === 1 ? "" : "s"}`,
    };
  },
};
