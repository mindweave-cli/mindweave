/**
 * scrollPill.test.ts — the rules the scrolled-back chip follows.
 *
 * Each test here corresponds to a way the chip can be wrong that nothing else would
 * catch: it appears when there is nothing to scroll, it names a key that is switched
 * off, it counts tool rows as answers, or it paints past the right edge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrollPill, countNewReplies, progressPercent } from "./scrollPill.js";

const WIDE = 80;
const base = { scrolled: 5, newReplies: 0, overlayOpen: false, width: WIDE };

test("pinned to the newest shows nothing", () => {
  assert.equal(scrollPill({ ...base, scrolled: 0 }), null);
});

test("scrolled back offers the way out, and names the key", () => {
  const pill = scrollPill(base);
  assert.ok(pill);
  assert.match(pill, /Catch up/);
  assert.match(pill, /ctrl\+End/);
  assert.match(pill, /↓/);
});

test("a chip is padded on both sides, so it reads as a chip", () => {
  const pill = scrollPill(base);
  assert.ok(pill);
  assert.ok(pill.startsWith(" ") && pill.endsWith(" "), `expected padding, got ${JSON.stringify(pill)}`);
});

test("replies that landed while you were reading are counted, not just announced", () => {
  const pill = scrollPill({ ...base, newReplies: 3 });
  assert.ok(pill);
  assert.match(pill, /Catch up — 3 new/);
});

test("one reply still reads as a count, not a plural mismatch", () => {
  const pill = scrollPill({ ...base, newReplies: 1 });
  assert.ok(pill);
  assert.match(pill, /Catch up — 1 new/);
});

test("an open overlay hides it — the key it names is switched off there", () => {
  assert.equal(scrollPill({ ...base, overlayOpen: true }), null);
  // And with a count, which is the case most tempting to keep on screen.
  assert.equal(scrollPill({ ...base, overlayOpen: true, newReplies: 4 }), null);
});

// ── it must never paint past the right edge ────────────────────────────────

test("a chip always leaves a column of margin on each side", () => {
  for (let width = 10; width <= 60; width++) {
    const pill = scrollPill({ ...base, width });
    if (pill === null) continue;
    assert.ok(pill.length + 2 <= width, `at width ${width} the chip is ${pill.length} wide: ${pill}`);
  }
});

test("a narrow terminal drops the chord rather than the chip", () => {
  // Wide enough for " Catch up ↓ " (12) + 2, not for the full form with the chord.
  const pill = scrollPill({ ...base, width: 24 });
  assert.ok(pill, "the state is still worth saying without the chord");
  assert.match(pill, /Catch up/);
  assert.doesNotMatch(pill, /ctrl\+End/);
  assert.match(pill, /↓/, "the arrow is what makes it legible as 'more below'");
});

test("narrower than the shortest honest form shows nothing at all", () => {
  assert.equal(scrollPill({ ...base, width: 12 }), null);
});

// ── counting ───────────────────────────────────────────────────────────────

const blocks = [
  { id: 1, kind: "user" },
  { id: 2, kind: "assistant" },
  { id: 3, kind: "tools" },
  { id: 4, kind: "assistant" },
  { id: 5, kind: "tool" },
  { id: 6, kind: "assistant" },
];

test("no mark means not scrolled back, so nothing is new", () => {
  assert.equal(countNewReplies(blocks, null), 0);
});

test("only what arrived after the mark counts", () => {
  assert.equal(countNewReplies(blocks, 4), 1);
  assert.equal(countNewReplies(blocks, 2), 2);
  assert.equal(countNewReplies(blocks, 6), 0);
});

test("tool rows are not answers", () => {
  // Three blocks landed after the mark; ONE of them is the reply the reader is
  // waiting for. "3 new" would be a number about the app's internals.
  assert.equal(countNewReplies(blocks, 3), 2);
  assert.equal(countNewReplies([{ id: 9, kind: "tools" }, { id: 10, kind: "tool" }], 8), 0);
});

test("the scan stops at the mark instead of walking the whole session", () => {
  // A long session, scrolled back one block. Reading past the mark would be the
  // difference between a constant cost and a per-render walk of everything.
  const long = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, kind: "assistant" }));
  let seen = 0;
  const counted = countNewReplies(
    new Proxy(long, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) seen++;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
    4998,
  );
  assert.equal(counted, 2);
  assert.ok(seen <= 4, `expected to touch only the tail, touched ${seen} blocks`);
});

test("the chip says how far through the conversation the view is", () => {
  // 500 lines of scroll range, 125 scrolled back from the newest: a quarter of the way up,
  // so three quarters of the way through.
  assert.match(scrollPill({ ...base, scrolled: 125, maxScroll: 500 })!, /Catch up · 75% \(ctrl\+End\)/);
  assert.match(scrollPill({ ...base, scrolled: 500, maxScroll: 500 })!, /· 0%/, "the very start");
  assert.match(scrollPill({ ...base, scrolled: 1, maxScroll: 500, newReplies: 2 })!, /Catch up — 2 new · 99%/);
});

test("the percentage is never invented or out of range", () => {
  assert.equal(progressPercent(0, 500), null, "pinned to the newest: nothing to say");
  assert.equal(progressPercent(5, undefined), null, "range unknown");
  assert.equal(progressPercent(5, 0), null);
  assert.equal(progressPercent(900, 500), 0, "more scrolled than there is clamps to the start");
  assert.equal(progressPercent(1, 100000), 99, "a line from the end is not called 100");
});

test("on a narrow terminal the place is the first thing to give way, then the chord", () => {
  const withPct = scrollPill({ ...base, scrolled: 125, maxScroll: 500, width: WIDE })!;
  const tighter = scrollPill({ ...base, scrolled: 125, maxScroll: 500, width: withPct.length + 1 })!;
  assert.ok(!tighter.includes("%"), "no room for the percent, so the chord stays and the percent goes");
  assert.match(tighter, /ctrl\+End/);
});
