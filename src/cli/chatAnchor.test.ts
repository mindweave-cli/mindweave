/**
 * chatAnchor.test.ts — where the transcript sits, and what must not move.
 *
 * Half of these tests exist to pin the NEW behaviour (a short conversation rests on
 * the input box). The other half exist to prove the change cannot reach the
 * scrolling mechanism, which is deliberately frozen: every scrolled frame must come
 * out byte-identical to what the old `-shift` arithmetic produced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatLayout, viewportScroll } from "./chatAnchor.js";

/** Exactly what App computed before this module existed. The scrolled regime must
 *  still agree with it, line for line.
 *
 * The `|| 0` is not a fudge: negating zero yields `-0`, and `assert.strictEqual`
 * uses `Object.is`, which separates it from `0`. They are the same frame to Yoga
 * and to a terminal, so the artifact is normalised here rather than papered over at
 * the call sites — the comparison is about position, not about the sign of nothing. */
function legacyOffset(contentHeight: number, chatRows: number, scrollUp: number): number {
  const maxScroll = Math.max(0, contentHeight - chatRows);
  const scrolled = Math.min(scrollUp, maxScroll);
  return -(maxScroll - scrolled) || 0;
}

// ── The new behaviour ─────────────────────────────────────────────────────────

test("a short transcript is marked as resting on the footer", () => {
  // The reported symptom: a few lines of conversation stranded at the top with a
  // growing void between the last reply and the input. The flag is what makes the
  // view put a flex spacer above it; see chatAnchor.ts for why it is a flag and not
  // a row count.
  const { restsOnFooter, marginTop } = chatLayout(4, 20, 0);
  assert.equal(restsOnFooter, true);
  assert.equal(marginTop, 0, "resting is done by the spacer, never by an offset");
});

test("an empty transcript rests too", () => {
  assert.equal(chatLayout(0, 20, 0).restsOnFooter, true);
});

test("a transcript that exactly fills the viewport rests, and is not offset", () => {
  // The boundary between the two regimes: nothing overflows, so nothing scrolls.
  const { restsOnFooter, marginTop } = chatLayout(20, 20, 0);
  assert.equal(restsOnFooter, true);
  assert.equal(marginTop, 0);
});

test("one line past the viewport stops resting and starts scrolling", () => {
  const { restsOnFooter, marginTop } = chatLayout(21, 20, 0);
  assert.equal(restsOnFooter, false, "there is now something to scroll to");
  assert.equal(marginTop, -1);
});

test("the offset is NEVER positive — the spacer owns the resting case entirely", () => {
  // The failure this guards: a positive offset derived from a lagging `chatRows`
  // pushed the whole transcript past the clip edge on the first frame.
  for (const content of [0, 1, 5, 19, 20, 21, 100]) {
    for (const scroll of [0, 3, 10_000]) {
      const { marginTop } = chatLayout(content, 20, scroll);
      assert.ok(marginTop <= 0, `content ${content} at scroll ${scroll} produced ${marginTop}`);
    }
  }
});

// ── What must not move ────────────────────────────────────────────────────────

test("every SCROLLED frame is identical to the old arithmetic", () => {
  // The frozen mechanism. If this ever disagrees, the change has leaked out of the
  // short-transcript case it was meant to stay inside.
  for (const contentHeight of [21, 30, 100, 500]) {
    for (const chatRows of [5, 10, 20]) {
      for (const scrollUp of [0, 1, 5, 50, 10_000]) {
        assert.equal(
          chatLayout(contentHeight, chatRows, scrollUp).marginTop,
          legacyOffset(contentHeight, chatRows, scrollUp),
          `overflowing content ${contentHeight} in ${chatRows} rows at scrollUp ${scrollUp} moved`,
        );
      }
    }
  }
});

test("a scrolling transcript never claims to rest", () => {
  for (const scroll of [0, 5, 10_000]) {
    assert.equal(chatLayout(100, 20, scroll).restsOnFooter, false, `scroll ${scroll}`);
  }
});

test("pinned to the newest, an overflowing transcript still shows its bottom", () => {
  // scrollUp 0 means "newest", which is a NEGATIVE offset sliding content up.
  const { marginTop } = chatLayout(100, 20, 0);
  assert.equal(marginTop, -80);
});

test("scrolling all the way back brings the top edge on screen, not past it", () => {
  const { marginTop, scrolled, maxScroll } = chatLayout(100, 20, 10_000);
  assert.equal(maxScroll, 80);
  assert.equal(scrolled, 80, "scroll is clamped to what exists");
  assert.equal(marginTop, 0, "the first line lands at the top, never below it");
});

test("the two regimes cannot overlap", () => {
  // Resting and scrolling are mutually exclusive by construction, which is what
  // makes the spacer safe to put in front of a frozen mechanism.
  for (const contentHeight of [0, 5, 20, 21, 25, 200]) {
    const { restsOnFooter, maxScroll } = chatLayout(contentHeight, 20, 0);
    assert.equal(restsOnFooter, maxScroll === 0, `content ${contentHeight}`);
  }
});

test("a negative or absurd scrollUp cannot push content off the top", () => {
  assert.equal(chatLayout(100, 20, -5).marginTop, -80);
  assert.equal(chatLayout(4, 20, -5).marginTop, 0);
});

test("a footer that grows moves the scroll by the rows the chat gave up", () => {
  assert.equal(viewportScroll(10, 15, 12), 13);
});

test("a footer that shrinks gives the rows back", () => {
  assert.equal(viewportScroll(13, 12, 15), 10);
});

test("pinned to the newest is left alone, and so is a viewport that did not change", () => {
  assert.equal(viewportScroll(0, 15, 12), 0);
  assert.equal(viewportScroll(10, 15, 15), 10);
});

test("the scroll never goes negative", () => {
  assert.equal(viewportScroll(2, 12, 20), 0);
});
