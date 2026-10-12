/**
 * lineDiff.test.ts — the line diff shows what changed and nothing else, with the right numbers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffHunks, type DiffLine } from "./lineDiff.js";

const text = (lines: string[]): string => lines.join("\n");
const mark = (l: DiffLine): string => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`;

test("identical text has no hunks", () => {
  assert.deepEqual(diffHunks("a\nb\nc", "a\nb\nc"), []);
});

test("only the lines that changed are marked, with two lines of context", () => {
  const before = text(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  const after = text(["1", "2", "3", "4", "FIVE", "6", "7", "8", "9"]);
  const hunks = diffHunks(before, after)!;
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0]!.map(mark), [" 3", " 4", "-5", "+FIVE", " 6", " 7"]);
});

test("line numbers follow each side: a removed line by its old number, an added one by its new number", () => {
  const before = text(["a", "b", "c", "d"]);
  const after = text(["a", "X", "Y", "c", "d"]);
  const [h] = diffHunks(before, after, 1)!;
  const by = (k: string, t: string) => h!.find((l) => l.kind === k && l.text === t)!;
  assert.equal(by("del", "b").oldNo, 2);
  assert.equal(by("add", "X").newNo, 2);
  assert.equal(by("add", "Y").newNo, 3);
  assert.equal(by("same", "c").oldNo, 3);
  assert.equal(by("same", "c").newNo, 4, "after one net line was added, c is line 4");
});

test("a paragraph that only gained two lines is not shown twice", () => {
  const para = Array.from({ length: 11 }, (_, i) => `line ${i}`);
  const before = text(["head", ...para, "tail"]);
  const after = text(["head", ...para, "", "### new", "", "tail"]);
  const hunks = diffHunks(before, after)!;
  const marked = hunks.flat().filter((l) => l.kind !== "same");
  assert.deepEqual(marked.map(mark), ["+", "+### new", "+"], "three new lines, not twenty-two");
});

test("changes far apart are separate hunks; changes close together share one", () => {
  const base = Array.from({ length: 40 }, (_, i) => `l${i}`);
  const far = base.slice();
  far[3] = "A";
  far[30] = "B";
  assert.equal(diffHunks(text(base), text(far))!.length, 2);
  const near = base.slice();
  near[3] = "A";
  near[6] = "B";
  assert.equal(diffHunks(text(base), text(near))!.length, 1, "three unchanged lines between are shown, not a gap");
});

test("applying the marked changes to the old text gives the new text, for random edits", () => {
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rnd(30) }, () => `w${rnd(6)}`);
    const b = a.slice();
    for (let k = rnd(5); k > 0; k--) {
      const at = rnd(b.length + 1);
      if (rnd(2)) b.splice(at, rnd(3), ...Array.from({ length: rnd(3) }, () => `n${rnd(6)}`));
      else b.splice(at, 1);
    }
    const hunks = diffHunks(text(a), text(b), 0);
    assert.ok(hunks, "small edits always diff");
    // Rebuild the new text from the old one plus the hunks (no context, so only changes are listed).
    const rebuilt = a.slice();
    let shift = 0;
    for (const h of hunks) {
      for (const l of h) {
        if (l.kind === "del") {
          rebuilt.splice(l.oldNo! - 1 + shift, 1);
          shift--;
        } else if (l.kind === "add") {
          rebuilt.splice(l.newNo! - 1, 0, l.text);
          shift++;
        }
      }
    }
    assert.equal(rebuilt.join("\n"), b.join("\n"), `round ${round}\nold ${JSON.stringify(a)}\nnew ${JSON.stringify(b)}`);
  }
});

test("a change too big to diff cheaply gives up instead of taking long", () => {
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`);
  assert.equal(diffHunks(text(a), text(b), 2, 100), null);
});

test("one line changed in a very long file is cheap", () => {
  const a = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
  const b = a.slice();
  b[25_000] = "changed";
  const t0 = Date.now();
  const hunks = diffHunks(text(a), text(b))!;
  assert.equal(hunks.length, 1);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0}ms`);
});

test("with no context only the changed lines are returned", () => {
  const hunks = diffHunks("a\nb\nc\nd\ne", "a\nB\nc\nd\nE", 0)!;
  assert.equal(hunks.length, 2, "two separate changes");
  assert.ok(hunks.flat().every((l) => l.kind !== "same"), "no unchanged line sneaks in");
});
