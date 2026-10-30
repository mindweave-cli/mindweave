/**
 * searchSources.test.ts — a web search's opened list holds every source that was saved, and the image-viewing row is never drawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSearchDetail } from "./rebuildDetail.js";
import { neverShown } from "../cli/toolDisplay.js";

const block = (n: number, listed: number) =>
  ["Engine: DeepSeek", "Query time: 20.9s", `Found ${n} sources`, ...Array.from({ length: listed }, (_, i) => `${i + 1}. Title ${i + 1}`), `(+${n - listed} more)`].join("\n");

test("a search saved with eight titles and a record of twenty lists all twenty", () => {
  const web = { kind: "search", sources: Array.from({ length: 20 }, (_, i) => ({ title: `Title ${i + 1}`, url: `https://x/${i}` })) };
  const row = compactSearchDetail(block(23, 8), web)!;
  const full = row.detailFull!;
  assert.ok(full.includes("20. Title 20"), "the twentieth is listed");
  assert.match(full, /\(3 more sources were not kept in this chat\)/, "only the three that were never saved are reported missing");
});

test("with no record beyond the block, the old behaviour stands", () => {
  const full = compactSearchDetail(block(23, 8))!.detailFull!;
  assert.match(full, /\(15 more sources were not kept in this chat\)/);
});

test("when every source was recorded nothing is reported missing", () => {
  const web = { sources: Array.from({ length: 23 }, (_, i) => ({ title: `T${i}` })) };
  assert.doesNotMatch(compactSearchDetail(block(23, 8), web)!.detailFull!, /not kept/);
});

test("the tool that looks at an image is never drawn as a row", () => {
  assert.equal(neverShown("view_image"), true);
});
