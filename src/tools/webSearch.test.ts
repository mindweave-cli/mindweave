/**
 * webSearch.test.ts — the web_search tool and the Anthropic side of it.
 *
 * Nothing here touches the network. The two halves that can be tested honestly
 * offline are the pure ones: how a result is rendered for the model, and how an
 * Anthropic reply is read. The provider call itself is one SDK line and is not
 * worth a mock that only asserts the mock.
 *
 * The case worth having a test for at all is the error branch of
 * `extractSearch`: a failed search arrives on a SUCCESSFUL response with an
 * error object where the results array normally is, so the shape is easy to
 * index blind and hard to notice going wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext } from "./types.js";
import type { SearchResult } from "../drivers/types.js";
import { webSearch, formatSearch } from "./webSearch.js";
import { extractSearch } from "../drivers/searchBlocks.js";
import { ensureDriver } from "../drivers/registry.js";

function ctx(): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [] };
}

/** A finished message, shaped enough for `extractSearch` to read. */
function message(content: unknown[], stopReason = "end_turn"): Anthropic.Message {
  return { content, stop_reason: stopReason } as unknown as Anthropic.Message;
}

function hit(title: string, url: string) {
  return { type: "web_search_result", title, url, encrypted_content: "x", page_age: null };
}

function resultBlock(content: unknown) {
  return { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content };
}

// ── formatSearch ─────────────────────────────────────────────────────────────

test("formatSearch leads with the answer and lists sources after it", () => {
  const out = formatSearch("current react version", {
    answer: "React 19.2 is current.",
    sources: [
      { title: "React releases", url: "https://react.dev/versions" },
      { title: "Changelog", url: "https://github.com/facebook/react/releases" },
    ],
  });
  // The query rides on the frame's tag now, rather than a "Search:" line of its own.
  assert.match(out, /<web_search query="current react version">/);
  // The answer must come before the sources, not after them.
  assert.ok(out.indexOf("React 19.2 is current.") < out.indexOf("Sources:"));
  assert.match(out, /1\. React releases — https:\/\/react\.dev\/versions/);
  assert.match(out, /2\. Changelog — /);
});

test("formatSearch caps the source list and says how many it dropped", () => {
  const sources = Array.from({ length: 12 }, (_, i) => ({
    title: `Page ${i}`,
    url: `https://example.com/${i}`,
  }));
  const out = formatSearch("q", { answer: "a", sources });
  assert.match(out, /8\. Page 7/);
  assert.doesNotMatch(out, /9\. Page 8/);
  assert.match(out, /\(\+4 more\)/);
});

test("formatSearch flags a search that stopped early", () => {
  const partial: SearchResult = { answer: "a", sources: [], partial: true };
  assert.match(formatSearch("q", partial), /stopped early/);
  assert.doesNotMatch(formatSearch("q", { answer: "a", sources: [] }), /stopped early/);
});

// ── extractSearch ────────────────────────────────────────────────────────────

test("extractSearch pulls the answer text and the cited pages", () => {
  const result = extractSearch(
    message([
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
      resultBlock([hit("React releases", "https://react.dev/versions")]),
      { type: "text", text: "React 19.2 is current." },
    ]),
  );
  assert.equal(result.answer, "React 19.2 is current.");
  assert.deepEqual(result.sources, [
    { title: "React releases", url: "https://react.dev/versions" },
  ]);
  assert.equal(result.partial, false);
});

test("extractSearch survives a failed search, which arrives as an error OBJECT", () => {
  // The regression this guards: `content` is not an array here, so anything that
  // iterates it blind produces garbage instead of throwing.
  const result = extractSearch(
    message([
      resultBlock({ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }),
      { type: "text", text: "I could not complete the search." },
    ]),
  );
  assert.deepEqual(result.sources, []);
  assert.equal(result.answer, "I could not complete the search.");
});

test("extractSearch lists a page once even when several searches hit it", () => {
  const result = extractSearch(
    message([
      resultBlock([hit("Docs", "https://example.com/a"), hit("Other", "https://example.com/b")]),
      resultBlock([hit("Docs", "https://example.com/a")]),
      { type: "text", text: "answer" },
    ]),
  );
  assert.deepEqual(
    result.sources.map((s) => s.url),
    ["https://example.com/a", "https://example.com/b"],
  );
});

test("extractSearch drops a result the provider sent without a usable URL", () => {
  // Found by running a real DeepSeek search, not by reading: one returned result
  // carried neither title nor url despite the SDK's types promising both, and it
  // rendered to the model as "undefined — undefined".
  const result = extractSearch(
    message([
      resultBlock([
        hit("Real page", "https://example.com/a"),
        { type: "web_search_result", encrypted_content: "x", page_age: null },
        { type: "web_search_result", title: "", url: "   ", encrypted_content: "x", page_age: null },
      ]),
      { type: "text", text: "answer" },
    ]),
  );
  assert.deepEqual(result.sources, [{ title: "Real page", url: "https://example.com/a" }]);
});

test("extractSearch falls back to the URL when a result has no title", () => {
  const result = extractSearch(
    message([
      resultBlock([{ type: "web_search_result", url: "https://example.com/x", encrypted_content: "x", page_age: null }]),
      { type: "text", text: "answer" },
    ]),
  );
  assert.deepEqual(result.sources, [{ title: "https://example.com/x", url: "https://example.com/x" }]);
});

test("extractSearch marks a turn the provider paused as partial", () => {
  const result = extractSearch(
    message([resultBlock([hit("Docs", "https://example.com/a")]), { type: "text", text: "so far" }], "pause_turn"),
  );
  assert.equal(result.partial, true);
});

// ── the tool ─────────────────────────────────────────────────────────────────

test("web_search rejects an empty query", async () => {
  const result = await webSearch.execute({ query: "   " }, ctx());
  assert.equal(result.isError, true);
  assert.match(result.output, /`query` is required/);
});

test("DeepSeek can search, over its own endpoint", async () => {
  // It serves native search on an Anthropic-protocol endpoint rather than the
  // OpenAI-compatible one its chat uses, with the same key. Declaring the
  // capability is what core reads; the transport is the driver's business.
  const driver = await ensureDriver("deepseek-v4-flash");
  assert.equal(typeof driver.webSearch, "function");
});

test("web_search degrades on a provider without search, without erroring", async () => {
  // Every installed provider can search today, so the degrade path is reached by
  // taking the capability away from a real driver rather than by inventing one.
  // The path still matters: it is what a future provider without search gets, and
  // it must not read as a transient failure the model should retry.
  const driver = await ensureDriver("deepseek-v4-flash");
  const saved = driver.webSearch;
  delete driver.webSearch;
  try {
    const result = await webSearch.execute({ query: "anything" }, ctx());
    assert.equal(result.isError, undefined);
    assert.match(result.output, /cannot search the web/);
    assert.match(result.output, /web_fetch/);
  } finally {
    driver.webSearch = saved;
  }
});

test("web_search is offered to the model as a read-only tool", () => {
  assert.equal(webSearch.readOnly, true);
});

test("a search hands a front end its pages as facts: query, service, time, each page's title and address", async () => {
  const driver = await ensureDriver("deepseek-v4-flash");
  const saved = driver.webSearch;
  driver.webSearch = async () => ({
    answer: "It is v2.",
    sources: [
      { title: "API Documentation", url: "https://www.steamgriddb.com/api/v2" },
      { title: "steamgriddb-api", url: "https://github.com/SteamGridDB/node-steamgriddb" },
    ],
  });
  try {
    const result = await webSearch.execute({ query: "SteamGridDB API v2" }, ctx());
    assert.equal(result.web?.kind, "search");
    assert.ok(result.web?.kind === "search");
    assert.equal(result.web.query, "SteamGridDB API v2");
    assert.equal(typeof result.web.ms, "number");
    assert.deepEqual(result.web.sources.map((s) => s.url), [
      "https://www.steamgriddb.com/api/v2",
      "https://github.com/SteamGridDB/node-steamgriddb",
    ]);
    // Display only: the model's text is unchanged by it.
    assert.doesNotMatch(result.output, /"kind"/);
  } finally {
    driver.webSearch = saved;
  }
});
