import { test } from "node:test";
import assert from "node:assert/strict";
import { toolKind, toolDisplay, dotColorFor, ERROR_COLOR, OK_COLOR, UNKNOWN_TOOL, narrationShown, noteReads } from "./toolDisplay.js";
import { TOOLS } from "../tools/registry.js";
import { toPathList } from "../tools/pathList.js";

test("an mcp__ prefixed name is detected as the mcp kind by prefix, not a static map entry", () => {
  assert.equal(toolKind("mcp__sqlite-local__execute_query"), "mcp");
  assert.equal(toolKind("mcp__anything__at_all"), "mcp");
});

test("web_fetch and web_search share the websearch kind, not codebase search", () => {
  assert.equal(toolKind("web_fetch"), "websearch");
  assert.equal(toolKind("web_search"), "websearch");
});

test("screenshot has its own kind", () => {
  assert.equal(toolKind("screenshot"), "screenshot");
});

test("an unknown tool name still falls back to meta", () => {
  assert.equal(toolKind("something_nobody_registered"), "meta");
});

test("a row's dot is red when it failed, green when work went through, and plain otherwise", () => {
  const kinds = ["read", "search", "edit", "write", "run", "check", "agent", "websearch", "screenshot", "mcp", "checkpoint", "governor", "meta"] as const;
  for (const k of kinds) {
    assert.equal(dotColorFor(k, "error"), ERROR_COLOR, `${k} failing is red`);
    assert.equal(dotColorFor(k, "running"), undefined, `${k} still running is not coloured`);
  }
  for (const k of ["edit", "write", "check", "run"] as const) assert.equal(dotColorFor(k, "ok"), OK_COLOR, `${k} done is green`);
  for (const k of ["read", "search", "agent", "websearch", "screenshot", "mcp", "checkpoint", "governor", "meta"] as const) {
    assert.equal(dotColorFor(k, "ok"), undefined, `${k} done stays plain: only changes and runs are green`);
  }
  assert.equal(dotColorFor(undefined, "ok"), undefined);
});

test("mcp__server__tool parses back into MCPServer(server) for the header", () => {
  const d = toolDisplay("mcp__sqlite-local__execute_query", {});
  assert.equal(d.name, "MCPServer");
  assert.equal(d.arg, "sqlite-local");
  assert.equal(d.kind, "mcp");
});

test("web_search's arg is its query, not the generic path/symbol fallback", () => {
  const d = toolDisplay("web_search", { query: "DeepSeek V4 Flash context window" });
  assert.equal(d.arg, "DeepSeek V4 Flash context window");
});

test("a long web_search query is clipped like other long args", () => {
  const d = toolDisplay("web_search", { query: "x".repeat(80) });
  assert.ok(d.arg!.length <= 48);
  assert.ok(d.arg!.endsWith("…"));
});

test("screenshot's arg is the window title, not the generic fallback", () => {
  const d = toolDisplay("screenshot", { window: "Chrome — DeepSeek API Documentation" });
  assert.equal(d.arg, "Chrome — DeepSeek API Documentation");
});

test("screenshot with no window arg has no arg, not an empty string", () => {
  const d = toolDisplay("screenshot", {});
  assert.equal(d.arg, undefined);
});

test("web_fetch's display name and arg extraction are unchanged by the kind fix", () => {
  const d = toolDisplay("web_fetch", { url: "https://docs.deepseek.com/api/endpoints" });
  assert.equal(d.name, "Fetch");
  assert.equal(d.arg, "https://docs.deepseek.com/api/endpoints");
  assert.equal(d.kind, "websearch");
});

test("EVERY registered tool has a display name — no snake_case can reach a row", () => {
  // The defect this closes was on screen: a tool with no entry fell through to the
  // capitalize-the-raw-name fallback, so `replace_symbol_body` would have rendered as
  // `Replace_symbol_body`. The fallback is now reserved for names that are not tools
  // at all, which only works while every real tool is covered here.
  const missing = TOOLS.filter((t) => toolDisplay(t.name, {}).name === UNKNOWN_TOOL).map((t) => t.name);
  assert.deepEqual(missing, [], `these registered tools have no DISPLAY_NAME entry: ${missing.join(", ")}`);
});

test("a tool the model invented renders under a plain name, not title-cased snake_case", () => {
  // Seen live: the model called `index_results`, which does not exist, and the row
  // read "Index_results". The call still gets a row — it happened and it failed — but
  // the invented name belongs in the argument, not in the header.
  const d = toolDisplay("index_results", {});
  assert.equal(d.name, UNKNOWN_TOOL);
  assert.equal(d.arg, "index_results");
  assert.equal(d.kind, "meta");
});

test("an MCP server's tool is never mistaken for an invented one", () => {
  // mcp__ names are generated per-server, so they can't be in the static map.
  const d = toolDisplay("mcp__sqlite-local__execute_query", {});
  assert.equal(d.name, "MCPServer");
  assert.equal(d.arg, "sqlite-local");
});

test("a multi-file read names the files and says how many it covers", () => {
  // The defect on screen: the group header counted CALLS and called them files, so
  // three files read in one call announced "Reading 1 file" directly above its own row
  // saying "Read 3 files". The header and its contents disagreed, and the header was
  // the one that was wrong.
  const d = toolDisplay("read_file", { paths: ["src/a/index.html", "docs/changelog.html", "b/docs.html"] });
  assert.equal(d.covers, 3, "the group header has to count files, not calls");
  assert.equal(d.arg, "index.html, changelog.html, docs.html");
});

test("a single-file read covers nothing extra and reads as its name", () => {
  const d = toolDisplay("read_file", { paths: ["docs/changelog.html"] });
  assert.equal(d.covers, undefined);
  assert.equal(d.arg, "changelog.html");
});

test("a multi-file read no longer just repeats the count back", () => {
  // "3 files" said the same thing as the header above it and named none of them, so a
  // burst of reads was arithmetic instead of information.
  const d = toolDisplay("read_file", { paths: ["a.ts", "b.ts", "c.ts"] });
  assert.doesNotMatch(d.arg ?? "", /^\d+ files$/);
});

// ── the row must name every file the tool will actually read ───────────────
//
// `read_file` accepts the list under `paths` or the older singular `path`, as a
// list or as a bare string, because a resumed session replays calls made under the
// previous schema. The row read a narrower set, so a call passing four files under
// `path` read all four and rendered as "Reading 1 file" with no filenames — the
// header contradicting its own result line, and the one thing worth showing absent.

test("a list under the older singular `path` is still counted and named", () => {
  const d = toolDisplay("read_file", { path: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] });
  assert.equal(d.covers, 4, "the group header counts this call as four files");
  assert.equal(d.arg, "a.ts, b.ts, c.ts, d.ts");
});

test("a list under `paths` is counted and named the same way", () => {
  const d = toolDisplay("read_file", { paths: ["src/a.ts", "src/b.ts"] });
  assert.equal(d.covers, 2);
  assert.equal(d.arg, "a.ts, b.ts");
});

test("one file is one file — no count, just the name", () => {
  assert.equal(toolDisplay("read_file", { paths: ["src/cli/App.tsx"] }).covers, undefined);
  assert.equal(toolDisplay("read_file", { paths: ["src/cli/App.tsx"] }).arg, "App.tsx");
  assert.equal(toolDisplay("read_file", { path: "src/cli/App.tsx" }).arg, "App.tsx");
});

test("a bare string under `paths` is one file, not a character list", () => {
  const d = toolDisplay("read_file", { paths: "src/cli/App.tsx" });
  assert.equal(d.arg, "App.tsx");
  assert.equal(d.covers, undefined);
});

test("blank entries are not files", () => {
  const d = toolDisplay("read_file", { paths: ["src/a.ts", "", "   ", "src/b.ts"] });
  assert.equal(d.covers, 2, "two real files, not four");
  assert.equal(d.arg, "a.ts, b.ts");
});

test("the display and the tool agree about every shape", () => {
  // The invariant the shared reader exists for: whatever the tool will read, the row
  // names. Asserted against the reader itself so a change to either side is caught
  // here rather than by a header that disagrees with its own result on screen.
  const shapes: Record<string, unknown>[] = [
    { paths: ["a.ts", "b.ts"] },
    { path: ["a.ts", "b.ts", "c.ts"] },
    { paths: "a.ts" },
    { path: "a.ts" },
    { paths: [] },
    {},
  ];
  for (const args of shapes) {
    const files = toPathList(args);
    const d = toolDisplay("read_file", args);
    // What the row claims: `covers` when it names a count, otherwise one file if it
    // named one and none if it named nothing.
    const claimed = d.covers ?? (d.arg ? 1 : 0);
    assert.equal(claimed, files.length, `the row claims ${claimed} for ${JSON.stringify(args)}, the tool reads ${files.length}`);
  }
});

test("the combined web tool names what it is doing: the page it reads, or what it searches for", () => {
  const read = toolDisplay("web", { url: "https://www.steamgriddb.com/api/v2", prompt: "auth" });
  assert.equal(read.name, "Fetch");
  assert.equal(read.arg, "https://www.steamgriddb.com/api/v2");
  const search = toolDisplay("web", { query: "SteamGridDB API v2" });
  assert.equal(search.name, "WebSearch");
  assert.equal(search.arg, "SteamGridDB API v2");
});

test("words before only unseen tools are left out; before a visible tool they stay", () => {
  const none = new Set<string>();
  assert.equal(narrationShown([{ name: "search", args: { pattern: "x" } }], none), false);
  assert.equal(narrationShown([{ name: "search", args: {} }, { name: "outline", args: { path: "a.ts" } }], none), false);
  assert.equal(narrationShown([{ name: "todo_write", args: {} }], none), false);
  assert.equal(narrationShown([{ name: "search", args: {} }, { name: "edit", args: { path: "a.ts" } }], none), true);
  assert.equal(narrationShown([{ name: "run_command", args: { command: "npm test" } }], none), true);
});

test("a first read of a file is visible; reading it again in the same turn is not", () => {
  const read = new Set<string>();
  const first = [{ name: "read_file", args: { paths: ["src/Main.js"] } }];
  assert.equal(narrationShown(first, read), true);
  noteReads(first, read);
  assert.equal(narrationShown([{ name: "read_file", args: { path: "src\\main.js", offset: 200 } }], read), false);
  assert.equal(narrationShown([{ name: "read_file", args: { paths: ["src/main.js", "src/other.js"] } }], read), true);
});
