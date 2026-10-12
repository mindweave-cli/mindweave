/**
 * blockHeights.test.ts — the height table stays bounded, and prunes the right end.
 *
 * Both failure directions are silent. Pruning too little leaks for the length of a
 * session; pruning the wrong end throws away the heights of blocks still on screen,
 * which does not look like a bug, only like the app being slow again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FULL_TAIL_BLOCKS, MAX_TRACKED_HEIGHTS, estimateHeight, needsMeasure, pruneHeights, seedHeights, type HeightEntry } from "./blockHeights.js";
import type { Block } from "./transcript.js";
import { SCROLLBACK_BLOCKS } from "./virtualWindow.js";

function table(ids: number[]): Map<number, string> {
  return new Map(ids.map((id) => [id, `h${id}`]));
}

test("a table under the cap is left completely alone", () => {
  const t = table([1, 2, 3]);
  pruneHeights(t, 10);
  assert.deepEqual([...t.keys()], [1, 2, 3]);
});

test("exactly at the cap is still not pruned", () => {
  // Off-by-one here throws away a height every single time a block is measured.
  const t = table([1, 2, 3]);
  pruneHeights(t, 3);
  assert.equal(t.size, 3);
});

test("the OLDEST ids go, and the newest are kept", () => {
  // The wrong end is the dangerous one: the newest blocks are the ones on screen, so
  // dropping them means laying them out in full again on the very next frame.
  const t = table([10, 11, 12, 13, 14]);
  pruneHeights(t, 3);
  assert.deepEqual([...t.keys()].sort((a, b) => a - b), [12, 13, 14]);
});

test("insertion order does not decide what is kept", () => {
  // A Map iterates in insertion order, and heights are recorded as blocks are measured,
  // which is not id order — a block scrolled back into view is measured after newer
  // ones. Pruning by iteration order would drop whatever happened to be recorded first.
  const t = new Map<number, string>([[99, "new"], [1, "old"], [50, "mid"]]);
  pruneHeights(t, 2);
  assert.deepEqual([...t.keys()].sort((a, b) => a - b), [50, 99]);
});

test("it prunes down to exactly the cap, not below it", () => {
  const t = table(Array.from({ length: 50 }, (_, i) => i));
  pruneHeights(t, 20);
  assert.equal(t.size, 20);
});

test("the cap leaves real room above the scrollback", () => {
  // Pruning must never be able to reach a block that is still rendered. The table was once a flat 600
  // while the scrollback allowed 10,000 blocks, so a session of 633 blocks lost its oldest height, the
  // measured prefix ended at block 0, and every block was laid out in full on every frame.
  assert.ok(MAX_TRACKED_HEIGHTS > SCROLLBACK_BLOCKS, `cap is ${MAX_TRACKED_HEIGHTS}, not above the scrollback`);
});

test("a long session keeps every block's height: 700, 5,000 and a full scrollback are not pruned", () => {
  for (const n of [700, 5000, SCROLLBACK_BLOCKS]) {
    const t = table(Array.from({ length: n }, (_, i) => i));
    pruneHeights(t);
    assert.equal(t.size, n, `${n} blocks`);
    assert.ok(t.has(0), "the oldest block still has its height, so the measured prefix reaches the newest");
  }
});

// ── what still owes a real measurement ──────────────────────────────────────
//
// A width change RESCALES every recorded height by the ratio of the widths, so the
// scroll arithmetic stays roughly right without laying the whole scrollback out again.
// The entry it leaves behind still points at the same block object, so a check for
// "did the block change" answers no — and the estimate was never paid off. It then
// sized a spacer in the virtual window for the rest of the session.
//
// The error is not small and does not average out: a paragraph that wrapped to one row
// does not become 1.4 rows at a narrower width, it becomes two, and every block is
// rounded on its own. Blocks land a row or two from where they belong, worst exactly
// where the terminal is narrowest.

test("a block with no recorded height must be measured", () => {
  const block = { id: 1 };
  assert.equal(needsMeasure(undefined, block), true);
});

test("a block that CHANGED must be measured — the height describes the old content", () => {
  const before = { id: 1 };
  const after = { id: 1 };
  assert.equal(needsMeasure({ height: 4, block: before }, after), true);
});

test("a real measurement of the same block is not repeated", () => {
  const block = { id: 1 };
  assert.equal(needsMeasure({ height: 4, block }, block), false);
});

test("a SCALED height owes a measurement even though the block is identical", () => {
  // The whole bug in one assertion. Same object, so "did it change" says no; the height
  // is an estimate from a resize, so it is not a measurement.
  const block = { id: 1 };
  assert.equal(needsMeasure({ height: 4, block, scaled: true }, block), true);
});

test("recording a measurement clears the debt", () => {
  // What the measuring effect writes back has no `scaled`, so the next pass leaves it
  // alone. Without this the block would be re-measured on every single render.
  const block = { id: 1 };
  const rescaled = { height: 4, block, scaled: true };
  assert.equal(needsMeasure(rescaled, block), true);
  const measured = { height: 7, block };
  assert.equal(needsMeasure(measured, block), false);
});

test("scaled:false is a measurement, not a debt", () => {
  const block = { id: 1 };
  assert.equal(needsMeasure({ height: 4, block, scaled: false }, block), false);
});

// ── opening a long conversation: estimates for what is far above the window ──────────────

function chat(n: number): Block[] {
  return Array.from({ length: n }, (_, i): Block => ({ kind: "assistant", id: i, done: true, text: `message ${i}\n\nsecond paragraph` }));
}

test("only blocks older than the newest few hundred get an estimate, and it is marked as one", () => {
  const blocks = chat(FULL_TAIL_BLOCKS + 50);
  const table = new Map<number, HeightEntry>();
  assert.equal(seedHeights(table, blocks, 0, 100), 50);
  assert.equal(table.size, 50);
  for (let i = 0; i < 50; i++) {
    const e = table.get(i)!;
    assert.equal(e.scaled, true, "an estimate counts as unmeasured, so the first render replaces it with a fact");
    assert.equal(e.block, blocks[i]);
    assert.ok(e.height >= 2);
  }
  assert.equal(table.has(50), false, "the newest blocks are laid out for real, not guessed");
  assert.equal(needsMeasure(table.get(0), blocks[0]), true);
});

test("a conversation no longer than the tail is never estimated", () => {
  const table = new Map<number, HeightEntry>();
  assert.equal(seedHeights(table, chat(FULL_TAIL_BLOCKS), 0, 100), 0);
});

test("a measured block keeps its height, an open block is left alone, and seeding starts at `from`", () => {
  const blocks = chat(FULL_TAIL_BLOCKS + 10);
  blocks[2] = { ...blocks[2]!, done: false } as Block;
  const table = new Map<number, HeightEntry>([[1, { height: 17, block: blocks[1]! }]]);
  seedHeights(table, blocks, 1, 100);
  assert.equal(table.get(1)!.height, 17, "a real measurement is never overwritten");
  assert.equal(table.has(2), false, "an open block changes with every token");
  assert.ok(table.has(3));
  assert.equal(table.has(0), false, "blocks before `from` were not asked about");
});

test("an estimate grows with the text and with what is open, and is never below two rows", () => {
  const short: Block = { kind: "assistant", id: 1, done: true, text: "hi" };
  const long: Block = { kind: "assistant", id: 2, done: true, text: "word ".repeat(400) };
  assert.ok(estimateHeight(long, 100) > estimateHeight(short, 100) + 10);
  assert.ok(estimateHeight(short, 100) >= 2);
  const closed: Block = { kind: "work", id: 3, done: true, items: [{ toolId: "a", name: "Run", status: "ok" }, { toolId: "b", name: "Run", status: "ok" }] };
  const open: Block = { ...closed, open: true } as Block;
  assert.ok(estimateHeight(open, 100) > estimateHeight(closed, 100));
  for (const b of [{ kind: "compaction", id: 9, done: true, report: {} }, { kind: "subagent", id: 8, done: true, agents: [] }, { kind: "notice", id: 7, done: true, title: "t", body: "b" }] as unknown as Block[]) {
    assert.ok(estimateHeight(b, 100) >= 2, b.kind);
  }
});

test("a narrower terminal estimates taller", () => {
  const b: Block = { kind: "assistant", id: 1, done: true, text: "word ".repeat(120) };
  assert.ok(estimateHeight(b, 40) > estimateHeight(b, 140));
});
