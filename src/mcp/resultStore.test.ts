/**
 * resultStore.test.ts — the ceiling on what a server can put in the prompt.
 *
 * The defect this guards is quiet and expensive: before it existed, a `tools/call`
 * result went into the model's context whole, at whatever size a third party chose, and
 * an image went in as base64 the model cannot see. Nothing errored — the turn just got
 * enormous. So the tests here are mostly about the decision (is it too big, what does
 * the model get told) plus one end-to-end run against a real server that returns both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RESULT_CHARS,
  binaryPointer,
  extensionForMime,
  humanSize,
  isOversized,
  oversizedPointer,
  resultsDir,
  safeSlug,
  spill,
  spillFileName,
  sweepOldResults,
} from "./resultStore.js";
import { parseContentBlocks, flattenContent } from "./catalog.js";
import { McpManager } from "./manager.js";
import type { McpServerConfig } from "./config.js";

test("a mime type becomes an extension that opens natively", () => {
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("image/jpeg"), "jpg");
  assert.equal(extensionForMime("application/json"), "json");
  assert.equal(extensionForMime("text/plain; charset=utf-8"), "txt", "parameters are not part of the type");
  assert.equal(extensionForMime("image/svg+xml"), "svg");
  assert.equal(extensionForMime("application/x-parquet"), "parquet");
  assert.equal(extensionForMime(""), "bin");
  assert.equal(extensionForMime("application/vnd.some.absurdly.long.vendor.type"), "bin");
});

test("a server cannot choose an extension that runs or opens as a program", () => {
  for (const mime of [
    "application/bat",
    "application/x-bat",
    "application/cmd",
    "application/x-ps1",
    "application/hta",
    "application/vbs",
    "application/js",
    "application/javascript",
    "application/jar",
    "application/lnk",
    "application/x-sh",
    "application/x-msdownload",
    "application/exe",
    "application/x-scr",
    "application/msi",
  ]) {
    assert.equal(extensionForMime(mime), "bin", mime);
  }
});

test("names are made filesystem-safe without becoming unreadable", () => {
  assert.equal(safeSlug("GitHub"), "github");
  assert.equal(safeSlug("acme.tools/v2"), "acme-tools-v2");
  assert.equal(safeSlug(""), "x");
  assert.match(spillFileName("acme.tools", "read_file", "image/png", 1234, "ab12"), /^acme-tools-read-file-1234-ab12\.png$/);
});

test("size is reported in units a person reads", () => {
  assert.equal(humanSize(12), "12 B");
  assert.equal(humanSize(2_048), "2.0 KB");
  assert.equal(humanSize(3 * 1_024 * 1_024), "3.0 MB");
});

test("the cap is what decides, and it is not near-miss sensitive", () => {
  assert.equal(isOversized("x".repeat(MAX_RESULT_CHARS)), false, "exactly at the cap is fine");
  assert.equal(isOversized("x".repeat(MAX_RESULT_CHARS + 1)), true);
});

test("an oversized result hands back a head, a path, and what to do next", () => {
  const text = "FINDINGS:\n" + "x".repeat(50_000);
  const pointer = oversizedPointer(text, "/tmp/result.txt");
  assert.ok(pointer.startsWith("FINDINGS:"), "the head is kept — it says what the thing IS");
  assert.ok(pointer.length < text.length / 10, "and the bulk is gone");
  assert.match(pointer, /\/tmp\/result\.txt/, "the path must be there or the rest is unreachable");
  assert.match(pointer, /Nothing was lost/, "and the model must know it can still get it");
});

test("a binary block is described and pointed at, never inlined", () => {
  const pointer = binaryPointer("image/png", 1_048_576, "/tmp/shot.png");
  assert.match(pointer, /image\/png/);
  assert.match(pointer, /1\.0 MB/);
  assert.match(pointer, /do not try to read it as text/, "a model reading a PNG as utf8 wastes a turn");
});

test("content blocks are parsed by what we can DO with them", () => {
  const { blocks } = parseContentBlocks({
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///a.md", text: "# doc", mimeType: "text/markdown" } },
      { type: "resource", resource: { uri: "file:///b.bin", blob: "aGk=", mimeType: "application/octet-stream" } },
      { type: "resource_link", uri: "file:///c.txt", name: "notes" },
      { type: "something_new" },
    ],
  });
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["text", "binary", "text", "binary", "link", "text"],
  );
  // An embedded resource carrying TEXT is readable content, not bytes — treating it as
  // binary would spill a perfectly good document to disk for no reason.
  assert.match((blocks[2] as { text: string }).text, /file:\/\/\/a\.md/);
  assert.match((blocks[2] as { text: string }).text, /# doc/);
  assert.match((blocks[5] as { text: string }).text, /something_new/, "an unknown block is named, not dropped");
});

test("the no-disk fallback still never inlines base64", () => {
  const { text } = flattenContent({ content: [{ type: "image", data: "AAAAAAAAAAAAAAAA", mimeType: "image/png" }] });
  assert.ok(!text.includes("AAAAAAAA"), "the payload must not reach the prompt");
  assert.match(text, /image\/png/);
});

test("spilled files are swept once they are stale, and kept while they are not", async () => {
  const project = mkdtempSync(join(tmpdir(), "mw-spill-"));
  const fresh = await spill(project, "srv", "tool", "text/plain", "recent");
  const old = await spill(project, "srv", "tool", "text/plain", "ancient");
  assert.ok(fresh && old);
  // Age the second file past the TTL.
  const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  await fs.utimes(old!, past, past);

  assert.equal(await sweepOldResults(project), 1);
  assert.ok(await fs.readFile(fresh!, "utf8"), "the recent one survives");
  await assert.rejects(() => fs.readFile(old!, "utf8"), "the stale one is gone");
});

test("sweeping a project that never spilled anything is a quiet no-op", async () => {
  const project = mkdtempSync(join(tmpdir(), "mw-spill-"));
  assert.equal(await sweepOldResults(project), 0);
});

/** A server that answers with a huge text result and with an image. */
const BIG_SERVER = [
  'let buf = "";',
  'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (c) => {',
  "  buf += c;",
  "  let nl;",
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);",
  "    if (!line.trim()) continue;",
  "    const msg = JSON.parse(line);",
  "    if (msg.id === undefined) continue;",
  '    if (msg.method === "server/discover") { send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersions: ["2026-07-28"], capabilities: {} } }); continue; }',
  '    if (msg.method === "tools/list") { send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "huge", description: "returns a lot" }, { name: "shot", description: "returns an image" }] } }); continue; }',
  '    if (msg.method === "tools/call") {',
  '      if (msg.params.name === "shot") { send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "image", data: Buffer.alloc(60000, 7).toString("base64"), mimeType: "image/png" }] } }); continue; }',
  '      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "HEAD MARKER\\n" + "z".repeat(200000) }] } });',
  "      continue;",
  "    }",
  '    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });',
  "  }",
  "});",
].join("\n");

const cfg: McpServerConfig = { type: "stdio", name: "srv", command: process.execPath, args: ["-e", BIG_SERVER] };

test("a 200KB result does not go into the prompt — it goes to disk", async () => {
  const project = mkdtempSync(join(tmpdir(), "mw-spill-"));
  const mgr = new McpManager();
  mgr.setProjectRoot(project);
  await mgr.start([cfg]);
  try {
    const result = await mgr.asTool("mcp__srv__huge")!.execute({}, {} as never);
    assert.ok(result.output.length < 10_000, `the model got ${result.output.length} chars, which defeats the point`);
    assert.match(result.output, /HEAD MARKER/, "the head survives");
    assert.match(result.output, /Result truncated here/);

    // And the whole thing is really on disk, in this project's state dir.
    const files = await fs.readdir(resultsDir(project));
    assert.equal(files.length, 1);
    const saved = await fs.readFile(join(resultsDir(project), files[0]!), "utf8");
    assert.ok(saved.length > 200_000, "the full result is recoverable");
    assert.match(saved, /HEAD MARKER/);
  } finally {
    await mgr.dispose();
  }
});

test("an image is saved as a real .png and never reaches the prompt as base64", async () => {
  const project = mkdtempSync(join(tmpdir(), "mw-spill-"));
  const mgr = new McpManager();
  mgr.setProjectRoot(project);
  await mgr.start([cfg]);
  try {
    const result = await mgr.asTool("mcp__srv__shot")!.execute({}, {} as never);
    assert.ok(result.output.length < 1_000, "a pointer, not a payload");
    assert.match(result.output, /image\/png/);
    assert.match(result.output, /58\.6 KB/);

    const files = await fs.readdir(resultsDir(project));
    assert.equal(files.length, 1);
    assert.ok(files[0]!.endsWith(".png"), `saved as ${files[0]} — the extension is what makes it openable`);
    const bytes = await fs.readFile(join(resultsDir(project), files[0]!));
    assert.equal(bytes.byteLength, 60_000, "decoded from base64, not stored as text");
    assert.equal(bytes[0], 7);
  } finally {
    await mgr.dispose();
  }
});
