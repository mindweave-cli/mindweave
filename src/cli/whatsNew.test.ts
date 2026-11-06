/**
 * whatsNew.test.ts — the list shown once after Mindweave starts on a new version.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWhatsNew, parseWhatsNew, readShippedNotes, shortItem, takeWhatsNew } from "./whatsNew.js";

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased: not out yet",
  "",
  "### Soon",
  "",
  "- **Not a release.** Nothing here may show.",
  "",
  "## v3.5.0 (2026-12-01): the agent works better",
  "",
  "Intro paragraph that is not a list.",
  "",
  "### It does more",
  "",
  "- **A real report when the work is done.** The length follows the work.",
  "- **Fewer questions.** It no longer asks at the end.",
  "- No bold here, so the first sentence is used. And a second one.",
  "- **Four.** extra",
  "",
  "### New",
  "",
  "- **A new command: `/usage`.** Shows your tokens.",
  "",
  "### Empty group",
  "",
  "## v3.4.9 (2026-11-01): older",
  "",
  "### Older",
  "",
  "- **Old thing.** Old.",
].join("\r\n");

test("one release's section becomes a short list, and nothing else leaks in", () => {
  const n = parseWhatsNew(CHANGELOG, "3.5.0");
  assert.ok(n);
  assert.equal(n.title, "the agent works better");
  assert.deepEqual(
    n.groups.map((g) => g.heading),
    ["It does more", "New"],
    "an empty group is left out",
  );
  assert.deepEqual(n.groups[0]!.items, [
    "A real report when the work is done",
    "Fewer questions",
    "No bold here, so the first sentence is used",
  ], "at most three a group, bold lead when there is one");
  assert.deepEqual(n.groups[1]!.items, ["A new command: /usage"]);
});

test("a version with no section, and an Unreleased section, show nothing", () => {
  assert.equal(parseWhatsNew(CHANGELOG, "9.9.9"), null);
  assert.equal(parseWhatsNew(CHANGELOG, "3.5"), null);
  assert.equal(parseWhatsNew("## Unreleased: x\n\n### A\n\n- **b.** c\n", "3.5.0"), null);
});

test("an item is cut to one short line", () => {
  assert.equal(shortItem("- **" + "x".repeat(200) + ".** rest").length, 90);
  assert.equal(shortItem("- Plain sentence. Second."), "Plain sentence");
});

test("the list reads as a few plain lines", () => {
  const text = formatWhatsNew(parseWhatsNew(CHANGELOG, "3.5.0")!);
  assert.equal(
    text,
    [
      "What's new in v3.5.0: the agent works better",
      "",
      "It does more",
      "  · A real report when the work is done",
      "  · Fewer questions",
      "  · No bold here, so the first sentence is used",
      "",
      "New",
      "  · A new command: /usage",
    ].join("\n"),
  );
});

function pkgWith(notes: unknown): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mw-notes-pkg-")));
  mkdirSync(join(dir, "dist"), { recursive: true });
  if (notes !== undefined) writeFileSync(join(dir, "dist", "whatsnew.json"), JSON.stringify(notes));
  return dir;
}

test("the notes that shipped are read back, and damaged ones read as none", () => {
  const n = parseWhatsNew(CHANGELOG, "3.5.0")!;
  assert.deepEqual(readShippedNotes(pkgWith(n)), n);
  assert.equal(readShippedNotes(pkgWith(undefined)), null);
  assert.equal(readShippedNotes(pkgWith({ version: 5 })), null);
});

test("shown once, on a newer version, never on the first start ever", () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "mw-seen-")));
  const pkg = pkgWith(parseWhatsNew(CHANGELOG, "3.5.0"));
  assert.deepEqual(takeWhatsNew("3.4.9", pkg, state), { updated: false, notes: null }, "first start: only recorded");
  assert.equal(JSON.parse(readFileSync(join(state, "seen-version.json"), "utf8")).version, "3.4.9");
  const up = takeWhatsNew("3.5.0", pkg, state);
  assert.equal(up.updated, true);
  assert.equal(up.notes?.version, "3.5.0");
  assert.deepEqual(takeWhatsNew("3.5.0", pkg, state), { updated: false, notes: null }, "and not again");
});

test("an update with no shipped notes still counts as updated, and a downgrade shows nothing", () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "mw-seen-")));
  takeWhatsNew("3.4.9", pkgWith(undefined), state);
  assert.deepEqual(takeWhatsNew("3.5.0", pkgWith(undefined), state), { updated: true, notes: null });
  assert.deepEqual(takeWhatsNew("3.4.0", pkgWith(undefined), state), { updated: false, notes: null });
});

test("notes for another version are not shown for this one", () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "mw-seen-")));
  takeWhatsNew("3.4.9", pkgWith(undefined), state);
  const r = takeWhatsNew("3.5.0", pkgWith(parseWhatsNew(CHANGELOG, "3.4.9")), state);
  assert.equal(r.notes, null);
});
