import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchDetail, formatBytes, pageTitle, fetchWeb } from "./webFetch.js";

test("fetchDetail leads with the URL and status", () => {
  const d = fetchDetail("https://docs.deepseek.com/api/endpoints", 200, []);
  assert.ok(d.startsWith("Received https://docs.deepseek.com/api/endpoints (HTTP 200)"));
});

test("fetchDetail appends the extra lines given to it", () => {
  const d = fetchDetail("https://example.com", 200, ["Extracted 1,450 chars", "Redirected from example.org"]);
  assert.ok(d.includes("Extracted 1,450 chars"));
  assert.ok(d.includes("Redirected from example.org"));
});

test("fetchDetail with no extra lines is just the received line", () => {
  const d = fetchDetail("https://example.com", 404, []);
  assert.equal(d, "Received https://example.com (HTTP 404)");
});

test("the size of what came off the wire leads the line when it is known", () => {
  // The number that answers "was that page worth the round trip".
  const d = fetchDetail("https://docs.deepseek.com/api", 200, [], 25_395);
  assert.ok(d.startsWith("Received 24.8 KB from https://docs.deepseek.com/api (HTTP 200)"), d);
});

test("byte sizes are scaled to something a person reads", () => {
  assert.equal(formatBytes(412), "412 B");
  assert.equal(formatBytes(25_395), "24.8 KB");
  assert.equal(formatBytes(3_500_000), "3.3 MB");
});

test("the page's own title is pulled out, collapsed and capped", () => {
  // What the page calls itself is how you tell the right doc from a login wall.
  assert.equal(pageTitle("<html><head><title>DeepSeek API\n  Docs</title>"), "DeepSeek API Docs");
  assert.equal(pageTitle("<TITLE >Upper</TITLE>"), "Upper");
  assert.ok(pageTitle(`<title>${"x".repeat(200)}</title>`).endsWith("…"));
});

test("a page with no title contributes no Title line at all", () => {
  // Better an absent line than "Title: " with nothing after it.
  assert.equal(pageTitle("<html><body>no head here</body></html>"), "");
});

test("a fetch hands a front end the page it read: where, its title, its size, what it was read for", async () => {
  const page = "<html><head><title>API Documentation</title></head><body><p>Grids by game id.</p></body></html>";
  const saved = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(page, {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  try {
    const result = await fetchWeb(
      { url: "https://www.steamgriddb.com/api/v2", prompt: "how to fetch grids" },
      { cwd: process.cwd(), roots: [process.cwd()], reads: new Map(), todos: [], planMode: false } as never,
    );
    assert.deepEqual(result.web, {
      kind: "fetch",
      url: "https://www.steamgriddb.com/api/v2",
      finalUrl: "https://www.steamgriddb.com/api/v2",
      status: 200,
      bytes: Buffer.byteLength(page, "utf8"),
      title: "API Documentation",
      focus: "how to fetch grids",
    });
  } finally {
    globalThis.fetch = saved;
  }
});
