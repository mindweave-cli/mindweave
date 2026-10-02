/**
 * revealPace.test.ts — the tempo, pinned.
 *
 * The value of this module is a property rather than a calculation: the beat is the
 * SAME every time. That is easy to state and easy to lose, because every instinct
 * about latency pushes toward speeding up later reveals, and any such change reads
 * on screen as the tool getting impatient with itself. So the constancy is asserted
 * directly, over a long turn, rather than left implied by a one-line function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { REVEAL_GAP_MS, narrationPending, revealWait } from "./revealPace.js";

// ── the beat never changes ────────────────────────────────────────────────────

test("every reveal in a long turn waits exactly the same beat", () => {
  // THE property. A decaying gap would pass a test that only checked the first two
  // reveals, so this walks a forty-block turn — deep enough that any decay curve or
  // budget cap would have tripped — and asserts the gap is identical throughout.
  const waits: number[] = [];
  for (let i = 0; i < 40; i++) waits.push(revealWait({ flush: false }));
  assert.deepEqual(
    [...new Set(waits)],
    [REVEAL_GAP_MS],
    `the beat changed across the turn: ${[...new Set(waits)].join(", ")}`,
  );
});

test("the beat ADDS to the model's own thinking, it is not absorbed by it", () => {
  // The correction. This used to subtract elapsed time, which meant a model that
  // paused between calls produced no beat at all: the turns that already read calmly
  // stayed calm, and the batches that actually needed spacing got nothing. It also
  // made the rhythm a function of model speed, which is the one thing a reader should
  // never be able to feel. However long the model just spent, the beat is still owed.
  assert.equal(revealWait({ flush: false }), REVEAL_GAP_MS);
});

test("the beat is a real pause, so a burst cannot land in one paint", () => {
  // Asserted as a floor rather than an exact number because the value is a question
  // of feel and is env-tunable; what must not silently return is zero.
  assert.ok(REVEAL_GAP_MS > 0, "the beat is back to zero: a concurrent burst will land in one paint again");
  assert.ok(revealWait({ flush: false }) > 0, "two blocks arriving in the same instant must not reveal together");
});

test("a burst of eight spaces out instead of landing at once", () => {
  // The shape of the actual complaint: eight rows that all finished within the same
  // millisecond. Each waits its own beat, so the eighth is seven beats after the
  // first rather than in the same frame.
  let t = 0;
  const revealedAt: number[] = [];
  for (let i = 0; i < 8; i++) {
    t += revealWait({ flush: false });
    revealedAt.push(t);
  }
  assert.equal(revealedAt[7]! - revealedAt[0]!, REVEAL_GAP_MS * 7);
  assert.equal(new Set(revealedAt).size, 8, "two rows shared a reveal instant");
});

test("the first block of a turn is paced like every other", () => {
  // It used to be exempt, on the theory that a gap before anything is on screen is
  // dead time. In practice the turn it follows is the model's thinking, which is
  // already occupied time the reader watched — so the first block arriving on the
  // beat reads as part of the same rhythm rather than as a stall.
  assert.equal(revealWait({ flush: false }), REVEAL_GAP_MS);
});

test("Esc drops the beat to nothing", () => {
  // The user asking to see the rest outranks the rhythm, and it is the signposted
  // escape a long operation is required to have.
  assert.equal(revealWait({ flush: true }), 0);
});

test("a finished turn drains at the same beat as a running one", () => {
  // Explicitly required: the queue must not speed up once the work is done. Nothing
  // in the wait depends on whether the stream ended, so this is a pin against a
  // future "drain faster at the end" optimisation, which would read as the interface
  // getting impatient with itself.
  assert.equal(revealWait({ flush: false }), revealWait({ flush: false }));
});

// ── narration gets its own beat ───────────────────────────────────────────────

test("text waiting to be sealed is worth a beat of its own", () => {
  assert.equal(narrationPending({ openAsstId: 7, raw: "Checking the driver seam.", narrated: false }), true);
});

test("nothing is pending when no assistant block is open", () => {
  assert.equal(narrationPending({ openAsstId: null, raw: "", narrated: false }), false);
  // raw can outlive its block; the open id is what says a block exists to seal.
  assert.equal(narrationPending({ openAsstId: null, raw: "leftover", narrated: false }), false);
});

test("whitespace is not narration", () => {
  assert.equal(narrationPending({ openAsstId: 7, raw: "   \n  ", narrated: false }), false);
});

test("every sentence in a turn gets its own beat, not only the first", () => {
  // Narration used to be capped at one line per turn, so a second sentence sealed to nothing and
  // was not paced. The cap is gone: the second and third sentences are visible blocks, and when
  // they were not paced they landed in the same paint as the tool row under them.
  assert.equal(narrationPending({ openAsstId: 9, raw: "And now the other file.", narrated: true }), true);
});
