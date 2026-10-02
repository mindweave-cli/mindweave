/**
 * webSearch.ts — look something up on the web.
 *
 * `web_fetch` reads a page you can already name. This one answers the question
 * that comes before it: which page? Without it "what is the current API for X"
 * is unreachable, and the model answers from training data that has a cutoff.
 *
 * The work belongs to the provider. A model that can search does it inside its
 * own infrastructure, and no amount of core code gives that ability to a model
 * that can't — so this tool is a thin front for `Driver.webSearch`, exactly the
 * way `web_fetch` fronts `toolTurn` for its distillation step. Core owns the
 * tool, its shape, and how it degrades; the driver owns the provider call.
 *
 * Degrading is the common path, not the edge case: the default model is text
 * only and cannot search. When that is the case the tool says so in one line and
 * points at what does work, rather than failing in a way the model reads as a
 * transient error and retries.
 */
import type { Tool, ToolResult } from "./types.js";
import type { SearchResult } from "../drivers/types.js";
import { activeDriver } from "../drivers/registry.js";
import { frameExternal } from "./untrusted.js";
import { outputDetail } from "./detail.js";
import { fail, failQuietly } from "./results.js";

/** Sources listed per answer. Enough to judge the answer, short enough to read. */
const MAX_SOURCES = 8;

const webSearchTool: Tool = {
  name: "web_search",
  readOnly: true,
  description:
    "Search the web and get an answer with its sources. Use it for anything that " +
    "changed after your training data — current library APIs, recent releases, " +
    "version-specific behaviour, whether a package still exists. " +
    "Give a `query` the way you would type it into a search engine. " +
    "You get an answer grounded in the pages found, plus their URLs; follow a URL " +
    "with web_fetch when you need the full page. " +
    "Not every model can search — if this one can't, the tool says so and you " +
    "should ask the user for a URL instead of retrying.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "What to search for, phrased as a search query.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return failQuietly("`query` is required.");

    const driver = activeDriver();
    if (!driver.webSearch) {
      // A fact about the running model, stated once. Deliberately NOT an error:
      // nothing went wrong and retrying will not help.
      return {
        output:
          `${driver.label} models cannot search the web, so this tool is unavailable ` +
          `on the current model. Ask the user for a URL and read it with web_fetch, ` +
          `or suggest switching models with /model.`,
        summary: "web search unavailable on this model",
      };
    }

    try {
      // Timed here rather than inside the driver: the wait is the same wait whichever
      // provider serves it, and measuring it at the one call site keeps every driver
      // free of display bookkeeping.
      const startedAt = Date.now();
      const result = await driver.webSearch(query, { signal: ctx.abortSignal });
      const elapsedMs = Date.now() - startedAt;
      if (!result.answer && result.sources.length === 0) {
        return {
          output: `No results for "${query}". Try different wording, or a narrower query.`,
          summary: `searched "${query}" (nothing found)`,
          web: { kind: "search", query, engine: driver.label, ms: elapsedMs, sources: [] },
        };
      }
      return {
        output: formatSearch(query, result),
        summary: `searched "${query}" (${result.sources.length} source${result.sources.length === 1 ? "" : "s"})`,
        detail: formatSearchDetail(result, driver.label, elapsedMs),
        web: {
          kind: "search",
          query,
          engine: driver.label,
          ms: elapsedMs,
          sources: result.sources.slice(0, MAX_DISPLAY_SOURCES).map((s) => ({ title: s.title, url: s.url })),
          ...(result.partial ? { partial: true } : {}),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Search failed: ${message}`);
    }
  },
};

/** Pages a front end may list under a search. More than the model is shown, because a
 *  list the user opens on purpose can afford it; still bounded. */
const MAX_DISPLAY_SOURCES = 20;

/**
 * Render a result for the model. Pure, so the shape is testable without a
 * provider: answer first because that is what was asked for, sources after so a
 * claim can be checked or followed with web_fetch.
 */
export function formatSearch(query: string, result: SearchResult): string {
  const lines: string[] = [];
  if (result.answer) lines.push(result.answer);

  if (result.sources.length > 0) {
    const shown = result.sources.slice(0, MAX_SOURCES);
    lines.push("", "Sources:");
    for (const [i, source] of shown.entries()) {
      lines.push(`${i + 1}. ${source.title} — ${source.url}`);
    }
    const hidden = result.sources.length - shown.length;
    if (hidden > 0) lines.push(`(+${hidden} more)`);
  }

  if (result.partial) {
    lines.push("", "(The search stopped early, so this may be incomplete.)");
  }

  // Framed as external content. This is the least trustworthy input the agent has:
  // the model picked the query and the open web picked what came back, including the
  // titles, which are attacker-chosen text sitting right next to a real answer.
  return frameExternal({ tag: "web_search", attrs: { query }, what: "a web search" }, lines.join("\n"));
}

/**
 * The UI-only detail block: a numbered source list, never sent to the model
 * (that's `formatSearch`'s job, with its own framing/injection defense) — this
 * is purely what the transcript row shows under the search. Empty when there
 * are no sources, so a bare-answer result shows just its summary line.
 */
export function formatSearchDetail(result: SearchResult, engine?: string, elapsedMs?: number): string {
  if (result.sources.length === 0) return "";
  const shown = result.sources.slice(0, MAX_SOURCES);
  const lines: string[] = [];
  // Which service answered and how long it took. Both are omitted rather than guessed
  // when unknown — a search row is one of the few places where the cost of the call is
  // not otherwise visible, and an invented number would be worse than no number.
  if (engine) lines.push(`Engine: ${engine}`);
  if (elapsedMs !== undefined) lines.push(`Query time: ${formatElapsed(elapsedMs)}`);
  lines.push(`Found ${result.sources.length} source${result.sources.length === 1 ? "" : "s"}`);
  for (const [i, source] of shown.entries()) lines.push(`${i + 1}. ${source.title}`);
  const hidden = result.sources.length - shown.length;
  if (hidden > 0) lines.push(`(+${hidden} more)`);
  return outputDetail(lines.join("\n"));
}

/** A wait, at the precision it is worth reading: `310ms`, `1.4s`. */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}


/** The search half of the merged `web` tool. Logic unchanged. */
export const searchWeb = webSearchTool.execute;

/** Kept for tests that assert on the search description/flags directly. */
export const webSearch = webSearchTool;
