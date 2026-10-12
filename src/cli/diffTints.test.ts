/**
 * diffTints.test.ts — the diff's tints for each level of colour a terminal can show.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTints } from "./theme.js";

test("a truecolor terminal gets the exact tints", () => {
  assert.deepEqual(diffTints(3), { addBg: "#0d2818", delBg: "#2d1113", addWordBg: "#1a5c33", delWordBg: "#6e2229" });
});

test("a 256-colour terminal gets palette entries, not hex colours that land on the wrong hue", () => {
  const t = diffTints(2);
  for (const v of Object.values(t)) assert.match(v!, /^ansi256\(\d+\)$/);
  // The old behaviour: the red used for a changed word came out purple. These are green and red entries of the cube.
  assert.equal(t.addBg, "ansi256(22)");
  assert.equal(t.delBg, "ansi256(52)");
});

test("a 16-colour or no-colour terminal gets no tint: the only backgrounds it has are far too loud behind text", () => {
  assert.deepEqual(diffTints(1), {});
  assert.deepEqual(diffTints(0), {});
});
