/**
 * bannerFit.test.ts — the header is one row at every width, with every model and mode, and it
 * gives things up in order instead of breaking a word.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitBanner, type BannerParts } from "./bannerFit.js";

const SHORT: BannerParts = { title: "Mindweave 1", mode: "LIGHTNING", model: "GLM-5.3", effort: "STANDARD", shuttle: 6 };
const LONG: BannerParts = { title: "Mindweave 1", mode: "ARCHITECT", model: "anthropic/claude-sonnet-5.5-preview-extended", effort: "THINKING · HIGH", shuttle: 6 };

/** The row as drawn: title, a space and the animation, the gap, then the status. */
function drawn(width: number, p: BannerParts): string {
  const f = fitBanner(width, p);
  const left = f.title + (f.title && f.showShuttle ? " " : "") + (f.showShuttle ? "─".repeat(p.shuttle) : "");
  return left + " ".repeat(f.gap) + [f.mode, f.model, f.effort].filter(Boolean).join(" | ");
}

test("every width, both lengths: exactly the width, never more", () => {
  for (const p of [SHORT, LONG]) {
    for (let w = 1; w <= 200; w++) {
      const row = drawn(w, p);
      assert.ok(row.length <= Math.max(w, 1), `${w} columns drew ${row.length}: ${JSON.stringify(row)}`);
      if (w >= 30) assert.equal(row.length, w, `${w} columns: the status should sit against the right edge`);
    }
  }
});

test("wide enough: everything, as before", () => {
  const f = fitBanner(108, SHORT);
  assert.deepEqual([f.title, f.showShuttle, f.mode, f.model, f.effort], ["Mindweave 1", true, "LIGHTNING MODE ON", "GLM-5.3", "STANDARD"]);
});

test("things go in order, least useful first, and no word is ever split", () => {
  // MODE ON goes first.
  assert.equal(fitBanner(52, SHORT).mode, "LIGHTNING");
  assert.equal(fitBanner(52, SHORT).showShuttle, true);
  // A long model name is shortened before the animation or the effort go.
  const mid = fitBanner(80, LONG);
  assert.match(mid.model, /…$/);
  assert.equal(mid.effort, "THINKING · HIGH");
  // Narrower: animation, then effort, then the title.
  const narrow = fitBanner(30, SHORT);
  assert.equal(narrow.showShuttle, false);
  const tiny = fitBanner(20, SHORT);
  assert.equal(tiny.title, "");
  // Whatever is shown is whole words or an explicit "…", never "Mindwe".
  for (let w = 1; w <= 120; w++) {
    const f = fitBanner(w, SHORT);
    assert.ok(f.title === "" || f.title === "Mindweave 1", `title cut at ${w}: ${f.title}`);
  }
});
