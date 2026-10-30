/**
 * webRow.probe.test.tsx — a search or a fetch is a title and one line, live and finished; the list opens on a click.
 *
 *   ● WebSearch(Clypra video editor Tauri React open source)
 *     └ DeepSeek · 7.5s · 13 sources
 */
process.env.FORCE_COLOR = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink";
import { ToolLine } from "./components/ToolLine.js";
import { formatSearchDetail, formatSearchDetailFull } from "../tools/webSearch.js";
import { fetchRows } from "../tools/webFetch.js";

function frame(node: React.ReactElement): string {
  const out: string[] = [];
  const stream = { write: (s: string) => void out.push(s), columns: 100, rows: 30, on: () => {}, off: () => {}, removeListener: () => {} } as unknown as NodeJS.WriteStream;
  const app = render(node, { stdout: stream, patchConsole: false, interactive: true });
  app.unmount();
  return out.join("").replace(new RegExp(String.fromCharCode(27) + "\[[0-9;?]*[A-Za-z]", "g"), "");
}

const sources = Array.from({ length: 13 }, (_, i) => ({ title: `Source title ${i + 1}`, url: `https://example.test/${i}` }));
const result = { answer: "x", sources } as never;
const detail = formatSearchDetail(result, "DeepSeek", 7500);
const detailFull = formatSearchDetailFull(result, "DeepSeek", 7500);
const props = { id: 1, name: "WebSearch", arg: "Clypra video editor Tauri React open source", action: "websearch" as const, columns: 100, live: false };

test("a finished search is its title and one summary line, with no hint line under it", () => {
  const out = frame(<ToolLine {...props} status="ok" summary="searched (13 sources)" detail={detail} full={detailFull} />);
  assert.match(out, /WebSearch\(Clypra video editor/);
  assert.match(out, /[⎿└] DeepSeek · 7\.5s · 13 sources/);
  assert.doesNotMatch(out, /Source title 1\b/, "the list is not shown until it is clicked");
  assert.doesNotMatch(out, /click to show/, "nothing under the line");
});

test("clicked, it opens on the whole list and says how to fold it", () => {
  const out = frame(<ToolLine {...props} status="ok" summary="x" detail={detail} full={detailFull} expanded />);
  assert.match(out, /Source title 1\b/);
  assert.match(out, /Source title 13/);
  assert.match(out, /click to fold/);
});

test("a running search is the title and `DeepSeek · Ns`, counting", () => {
  const out = frame(<ToolLine {...props} status="running" live detail="DeepSeek" startedAt={Date.now() - 3000} />);
  assert.match(out, /WebSearch\(/);
  assert.match(out, /[⎿└] DeepSeek · 3s/);
});

test("a running fetch says it is fetching", () => {
  const out = frame(<ToolLine {...props} name="WebFetch" arg="https://example.test/page" status="running" live detail="fetching" startedAt={Date.now() - 2000} />);
  assert.match(out, /WebFetch\(https:\/\/example\.test\/page\)/);
  assert.match(out, /[⎿└] fetching · 2s/);
});

test("a fetch closed is one line: size, status, time; the old block opens behind it", () => {
  const rows = fetchRows("https://example.test/page", 200, ["Extracted 900 tokens"], 25_400, 1200);
  assert.equal(rows.detail, "24.8 KB · HTTP 200 · 1.2s");
  assert.match(rows.detailFull, /Received 24\.8 KB from https:\/\/example\.test\/page \(HTTP 200\)/);
  assert.match(rows.detailFull, /Extracted 900 tokens/);
});

test("the closed search block is the summary line alone", () => {
  assert.equal(detail.split("\n").length, 1);
  assert.match(detailFull, /13\. Source title 13/);
});
