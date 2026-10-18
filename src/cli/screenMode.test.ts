/**
 * screenMode.test.ts — what `/screen` does with what you type at it.
 *
 * Every case here is one where guessing wrong puts the user in the shell they were
 * trying to leave, which is the one outcome a toggle must never have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScreenArg, screenNotice, startupMode, screenChoices, SCREEN_BETA } from "./screenMode.js";

test("fullscreen is the default, and only the exact word opts out", () => {
  assert.equal(startupMode(undefined), "fullscreen");
  assert.equal(startupMode(""), "fullscreen");
  assert.equal(startupMode("inline"), "inline");
  assert.equal(startupMode("  INLINE  "), "inline", "the value must survive shell whitespace and case");
  // Anything else is not a mode. Falling back to fullscreen is the safe direction: it is
  // what the user had, and it is what the app is documented to do.
  assert.equal(startupMode("yes"), "fullscreen");
  assert.equal(startupMode("1"), "fullscreen");
});

test("a bare /screen names NOTHING — it opens the chooser instead", () => {
  // It used to toggle. The two shells are not equals any more, and swapping between them
  // without showing what each takes from the terminal is what the chooser exists to stop.
  assert.equal(parseScreenArg(undefined), undefined);
  assert.equal(parseScreenArg(""), undefined);
  assert.equal(parseScreenArg("   "), undefined, "whitespace is not an argument");
});

test("naming a mode SETS it, and asking for the one you are in is not a toggle", () => {
  // The trap in a toggle-only command: `/screen inline` while already inline would flip
  // to fullscreen, which is the opposite of what was asked.
  assert.equal(parseScreenArg("inline"), "inline");
  assert.equal(parseScreenArg("fullscreen"), "fullscreen");
});

test("the words people actually type are accepted", () => {
  for (const word of ["full", "fs", "FULLSCREEN", " Full "]) {
    assert.equal(parseScreenArg(word), "fullscreen", `"${word}" was not understood`);
  }
  for (const word of ["normal", "plain", "Inline"]) {
    assert.equal(parseScreenArg(word), "inline", `"${word}" was not understood`);
  }
});

test("something it does not know is refused, never guessed", () => {
  // Toggling on an unrecognised word would move the user somewhere they did not ask to
  // go, and they would read it as the command being broken rather than the word.
  assert.equal(parseScreenArg("big"), undefined);
  assert.equal(parseScreenArg("off"), undefined);
});


test("each mode's notice says what changed about the terminal, not just its name", () => {
  // The user is about to find that scrolling and selecting behave differently. A line
  // that only names the mode leaves them to discover that by being surprised.
  const inline = screenNotice("inline");
  const full = screenNotice("fullscreen");
  assert.notEqual(inline, full);
  assert.match(inline, /scroll/i);
  assert.match(full, /pinned/i);
});

// ── the /screen chooser ─────────────────────────────────────────────────────
//
// Bare `/screen` used to swap. That was right while the two shells were equals and is
// not any more: keeping the prompt pinned in the inline shell means taking the mouse,
// and a terminal hands over all of it or none — so the terminal's own scrollbar and
// text selection stop working for the length of the session. A toggle has nowhere to
// say that; a list does, and says it before the choice rather than after.

test("both shells are offered, fullscreen first", () => {
  const choices = screenChoices("fullscreen");
  assert.equal(choices.length, 2);
  // The settled shell reads first. A list is read top down.
  assert.equal(choices[0]!.mode, "fullscreen");
  assert.equal(choices[1]!.mode, "inline");
});

test("the order does NOT depend on which one you are in", () => {
  // A menu whose entries move depending on where you already are has to be re-read
  // every time instead of learned once.
  assert.deepEqual(
    screenChoices("inline").map((c) => c.mode),
    screenChoices("fullscreen").map((c) => c.mode),
  );
});

test("inline is labelled beta, and fullscreen is not", () => {
  const choices = screenChoices("fullscreen");
  const inline = choices.find((c) => c.mode === "inline")!;
  const full = choices.find((c) => c.mode === "fullscreen")!;
  assert.match(inline.label, /beta/i, "the inline shell must say it is beta");
  assert.doesNotMatch(full.label, /beta/i, "the settled shell must not be marked unfinished");
  assert.equal(SCREEN_BETA, "inline", "the beta marker and the label have to name the same shell");
});

test("the inline entry signals it is unfinished, not just what it does", () => {
  // It is beta, and a chooser that describes it only by its feature leaves someone
  // surprised by the rough edges. The full cost (the terminal's scrollbar and selection
  // stop working) is longer than the row, so the label carries "beta" and the
  // description says it plainly rather than in full — kept short on purpose.
  const inline = screenChoices("fullscreen").find((c) => c.mode === "inline")!;
  assert.match(inline.label, /beta/i);
  assert.match(inline.description, /not available yet|too many bugs/i, "the entry must say it cannot be used yet");
});

test("the shell in use is ticked, and only that one", () => {
  for (const current of ["inline", "fullscreen"] as const) {
    const ticked = screenChoices(current).filter((c) => c.label.includes("✓"));
    assert.equal(ticked.length, 1, `expected exactly one tick with ${current} in use`);
    assert.equal(ticked[0]!.mode, current);
  }
});

test("every entry can be applied — the labels are not the source of truth", () => {
  // The picker hands back an INDEX. If an entry's `mode` were ever wrong or missing, the
  // chooser would switch to the wrong shell with no error anywhere.
  for (const c of screenChoices("fullscreen")) {
    assert.ok(c.mode === "inline" || c.mode === "fullscreen", `unusable mode: ${String(c.mode)}`);
    assert.ok(c.label.trim().length > 0 && c.description.trim().length > 0);
  }
});
