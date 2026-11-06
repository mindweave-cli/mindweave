/**
 * catalog.test.ts — namespacing, cost control, and surviving a hostile server.
 *
 * A tool catalog arrives from third-party code and goes straight into the prompt, so
 * these tests are as much about money and safety as correctness: an uncapped
 * description bills the user on every uncached turn, an unstable order breaks the
 * prompt cache, and one malformed entry must not cost the whole session its tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DESCRIPTION_CHARS,
  capDescription,
  estimateCatalogTokens,
  flattenContent,
  isMcpToolName,
  mcpToolName,
  parseMcpToolName,
  parseToolList,
  normalizeServerName,
  sortCatalog,
  toolSchemas,
} from "./catalog.js";

test("tool names namespace by server and round-trip", () => {
  const name = mcpToolName("github", "create_issue");
  assert.equal(name, "mcp__github__create_issue");
  assert.deepEqual(parseMcpToolName(name), { server: "github", tool: "create_issue" });
  assert.equal(isMcpToolName(name), true);
  assert.equal(isMcpToolName("read_file"), false);
});

test("server names that would break the delimiter are normalized", () => {
  // "acme.tools" → underscores; without collapsing runs, "a..b" would manufacture the
  // `__` delimiter and make the round-trip split in the wrong place.
  assert.equal(normalizeServerName("acme.tools"), "acme_tools");
  assert.equal(normalizeServerName("my server"), "my_server");
  assert.equal(normalizeServerName("a..b"), "a_b");
  const name = mcpToolName("a..b", "go");
  assert.deepEqual(parseMcpToolName(name), { server: "a_b", tool: "go" });
});

test("descriptions are capped, because a server picks its own length", () => {
  const huge = "x".repeat(10_000);
  const capped = capDescription(huge);
  assert.ok(capped.length <= MAX_DESCRIPTION_CHARS);
  assert.ok(capped.endsWith("…"), "truncation is visible, not silent");
  assert.equal(capDescription("  short  "), "short");
});

test("the catalog order is stable, because an unstable one is a cache miss", () => {
  const defs = [
    { server: "b", name: "two", description: "", inputSchema: {}, readOnly: false },
    { server: "a", name: "zeta", description: "", inputSchema: {}, readOnly: false },
    { server: "a", name: "alpha", description: "", inputSchema: {}, readOnly: false },
  ];
  const once = sortCatalog(defs).map((d) => `${d.server}/${d.name}`);
  const twice = sortCatalog([...defs].reverse()).map((d) => `${d.server}/${d.name}`);
  assert.deepEqual(once, ["a/alpha", "a/zeta", "b/two"]);
  assert.deepEqual(once, twice, "the same catalog in a different order must serialize identically");
});

test("a malformed tool is dropped without taking the catalog with it", () => {
  const defs = parseToolList("srv", {
    tools: [
      { name: "good", description: "does a thing" },
      { name: "" },
      { description: "nameless" },
      null,
      "not an object",
      { name: "also_good", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
    ],
  });
  assert.deepEqual(
    defs.map((d) => d.name),
    ["also_good", "good"],
  );
});

test("a duplicate tool name is listed once", () => {
  // Some providers reject a tool list containing the same function name twice.
  const defs = parseToolList("srv", { tools: [{ name: "dup" }, { name: "dup" }] });
  assert.equal(defs.length, 1);
});

test("a missing input schema becomes a valid empty object schema", () => {
  const [def] = parseToolList("srv", { tools: [{ name: "t" }] });
  assert.deepEqual(def!.inputSchema, { type: "object" });
});

test("readOnlyHint is a claim by the server and is not believed: no tool counts as read-only", () => {
  const defs = parseToolList("srv", {
    tools: [
      { name: "look", annotations: { readOnlyHint: true } },
      { name: "touch" },
      { name: "lie", annotations: { readOnlyHint: "yes" } },
    ],
  });
  assert.equal(defs.find((d) => d.name === "look")!.readOnly, false, "it would skip Sentinel's question, plan mode and the read-only sub-agent refusal");
  assert.equal(defs.find((d) => d.name === "touch")!.readOnly, false);
  assert.equal(defs.find((d) => d.name === "lie")!.readOnly, false, "only a real boolean counts");

  const readOnly = toolSchemas(defs, true).map((s) => s.function.name);
  assert.deepEqual(readOnly, [], "a read-only turn is offered none of them");
});

test("schemas come out in the shape the engine already speaks", () => {
  const defs = parseToolList("srv", { tools: [{ name: "go", description: "d", inputSchema: { type: "object" } }] });
  assert.deepEqual(toolSchemas(defs), [
    { type: "function", function: { name: "mcp__srv__go", description: "d", parameters: { type: "object" } } },
  ]);
});

test("tools/list garbage yields an empty catalog rather than throwing", () => {
  assert.deepEqual(parseToolList("srv", null), []);
  assert.deepEqual(parseToolList("srv", { tools: "nope" }), []);
  assert.deepEqual(parseToolList("srv", {}), []);
});

test("content blocks flatten to text, naming what we did not inline", () => {
  assert.deepEqual(flattenContent({ content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] }), {
    text: "hello\nworld",
    isError: false,
  });
  // Bytes stay out of the prompt; Phase 6 routes them to disk.
  assert.equal(flattenContent({ content: [{ type: "image" }] }).text, "[image content]");
  assert.equal(flattenContent({ content: [] }).text, "(no output)");
  assert.equal(flattenContent({ content: [{ type: "text", text: "bad" }], isError: true }).isError, true);
});

test("catalog token cost scales with what is actually sent", () => {
  const small = parseToolList("s", { tools: [{ name: "a", description: "hi" }] });
  const big = parseToolList("s", { tools: [{ name: "a", description: "x".repeat(2_000) }] });
  assert.ok(estimateCatalogTokens(small) > 0);
  assert.ok(estimateCatalogTokens(big) > estimateCatalogTokens(small) * 10, "a fat description dominates");
  assert.equal(estimateCatalogTokens([]), 0);
});

test("the description cap bounds what one server can cost", () => {
  // A server picks its own description length, and that text is billed on every
  // uncached turn. The cap is the only thing standing between the user and a server
  // that ships a novel per tool.
  const defs = parseToolList("s", { tools: Array.from({ length: 10 }, (_, i) => ({ name: `t${i}`, description: "x".repeat(50_000) })) });
  const perTool = estimateCatalogTokens(defs) / defs.length;
  assert.ok(perTool < (MAX_DESCRIPTION_CHARS / 3.5) * 1.2, `each tool stays near the cap (was ${perTool})`);
});

test("a tool with a valid x-mcp-header annotation keeps it", () => {
  const [def] = parseToolList(
    "srv",
    { tools: [{ name: "sql", inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } } }] },
    { mirrorsHeaders: true },
  );
  assert.deepEqual(def!.paramHeaders, [{ path: ["region"], header: "Region", type: "string" }]);
});

test("an invalid annotation drops that tool and only that tool, with a reason", () => {
  // The spec's remedy is to exclude the tool from tools/list. A whole server going dark
  // because one definition is malformed would be the worse failure.
  const rejects: string[] = [];
  const defs = parseToolList(
    "srv",
    {
      tools: [
        { name: "good", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
        { name: "bad", inputSchema: { type: "object", properties: { a: { type: "number", "x-mcp-header": "A" } } } },
      ],
    },
    { mirrorsHeaders: true, onReject: (tool, reason) => rejects.push(`${tool}: ${reason}`) },
  );
  assert.deepEqual(defs.map((d) => d.name), ["good"]);
  assert.equal(rejects.length, 1);
  assert.match(rejects[0]!, /^bad: /);
});

test("a transport that sends no headers ignores the annotation entirely", () => {
  // Explicitly allowed for non-HTTP clients. On a pipe the annotation cannot break a
  // call, so dropping the tool would cost the user a working tool for nothing.
  const raw = { tools: [{ name: "bad", inputSchema: { type: "object", properties: { a: { type: "number", "x-mcp-header": "A" } } } }] };
  const defs = parseToolList("srv", raw);
  assert.deepEqual(defs.map((d) => d.name), ["bad"]);
  assert.equal(defs[0]!.paramHeaders, undefined);
});
