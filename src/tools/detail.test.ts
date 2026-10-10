/**
 * detail.test.ts — the display-only rich blocks (edit diff, write preview,
 * command output, and line capping).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OK_MARK, FAIL_MARK, capLines, editDetail, outputDetail, writeDetail, withOutcome, lineCount, rangeLabel, magnitude, withScope, stripAnsi, collapseBlanks, sessionDetailFull, SESSION_DETAIL_LINES, SESSION_DETAIL_CHARS } from "./detail.js";

test("editDetail shows removed then added lines, prefixed", () => {
  const d = editDetail("a\nb", "a\nc");
  assert.equal(d, "- a\n- b\n+ a\n+ c");
});

test("editDetail ignores a single trailing newline on each side", () => {
  assert.equal(editDetail("x\n", "y\n"), "- x\n+ y");
});

test("writeDetail previews a new file as all-additions", () => {
  assert.equal(writeDetail("line1\nline2"), "+ line1\n+ line2");
  assert.equal(writeDetail(""), "");
});

test("outputDetail passes command output through plain (no prefixes)", () => {
  assert.equal(outputDetail("hello\nworld"), "hello\nworld");
  assert.equal(outputDetail(""), "");
});

test("capLines truncates with a count once over the max", () => {
  assert.equal(capLines(["a", "b", "c"], 5), "a\nb\nc");
  assert.equal(capLines(["a", "b", "c", "d"], 2), "a\nb\n  … (2 more lines)");
  assert.equal(capLines(["a", "b"], 1), "a\n  … (1 more line)");
});

test("lineCount counts replacement lines (empty spans none)", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("one line"), 1);
  assert.equal(lineCount("a\nb\nc"), 3);
});

test("rangeLabel: one line vs a span", () => {
  assert.equal(rangeLabel(120, 120), "L120");
  assert.equal(rangeLabel(120, 138), "L120-138");
});

test("magnitude uses a real minus sign, not the diff hyphen", () => {
  assert.equal(magnitude(6, 12), "−6 +12");
  assert.ok(!magnitude(6, 12).startsWith("-"), "must not start with an ASCII hyphen");
});

test("withScope prepends the scope header above the body", () => {
  assert.equal(withScope("L1-3 · −1 +2", "- a\n+ b\n+ c"), "L1-3 · −1 +2\n- a\n+ b\n+ c");
  assert.equal(withScope("new file · 2 lines", ""), "new file · 2 lines");
});

// ── a command's outcome ──────────────────────────────────────────────────────

test("a command's exit code is shown on SUCCESS as well as failure", () => {
  // If only failures carried a line, the absence of one would be the signal — and an
  // absence is easy to read past under a wall of build output.
  assert.match(withOutcome("build ok", false, 0, null, 120_000, 4_200), /✓ 0 · 4.2s$/);
  assert.match(withOutcome("2 failing", false, 1, null, 120_000, 12_400), /✗ 1 · 12.4s$/);
});

test("the outcome is appended, never replaces the output", () => {
  const out = withOutcome(["line one", "line two"].join("\n"), false, 0, null, 120_000, 273);
  assert.equal(out, ["line one", "line two", "✓ 0 · 273ms"].join("\n"));
});

test("a timeout says how long it waited, not just that it failed", () => {
  assert.match(withOutcome("", true, null, null, 30_000, 30_100), /timed out after 30s/);
});

test("a signalled process is named by its signal, never reported as exit 0", () => {
  // A process ended by a signal reports no exit code. Treating that as "not non-zero"
  // made a killed command read as a command that worked.
  assert.match(withOutcome("", false, null, "SIGTERM", 120_000, 2_100), /✗ killed \(SIGTERM\)/);
  assert.doesNotMatch(withOutcome("", false, null, "SIGTERM", 120_000, 2_100), /✓ 0/);
  assert.match(withOutcome("", false, null, null, 120_000, 900), /✗ no exit code/);
});

test("a command with no output still reports its outcome", () => {
  assert.equal(withOutcome("", false, 0, null, 120_000, 500), "✓ 0 · 500ms");
});

// ── A command's output, as it actually arrives ────────────────────────────────
// These guard a defect that was on screen: `Get-ChildItem` rendered half red, because
// the display coloured any detail line starting with `-` as a deleted line, and
// PowerShell writes its column rule as `----` and its file rows as `-a----  …`. The
// colouring fix lives in ToolLine (detailKind); these cover the text side of it.

const ESC = String.fromCharCode(27);

test("SGR colour codes are stripped from captured output", () => {
  // A command coloured its own output. Those bytes mean nothing in a block that
  // applies its own colour, and they break width measurement — an escape sequence
  // counts as visible characters when wrapping, so the block goes ragged.
  const coloured = `${ESC}[32mPASS${ESC}[0m src/app.test.ts`;
  assert.equal(stripAnsi(coloured), "PASS src/app.test.ts");
});

test("cursor and erase sequences are stripped too, not just colours", () => {
  assert.equal(stripAnsi(`building${ESC}[2K${ESC}[1Gdone`), "buildingdone");
});

test("text with no escapes is returned untouched", () => {
  assert.equal(stripAnsi("plain output"), "plain output");
});

test("runs of blank lines collapse to one, and the edges go", () => {
  const lines = ["", "", "Mode   LastWriteTime", "----   -------------", "", "", "d----- astra-backup", "", ""];
  assert.deepEqual(collapseBlanks(lines), ["Mode   LastWriteTime", "----   -------------", "", "d----- astra-backup"]);
});

test("a blank line BETWEEN groups survives — it is what separates them", () => {
  assert.deepEqual(collapseBlanks(["a", "", "b"]), ["a", "", "b"]);
});

test("output that is nothing but blank lines collapses to nothing", () => {
  assert.deepEqual(collapseBlanks(["", "", ""]), []);
});

test("a real PowerShell listing survives with its shape intact and no wasted rows", () => {
  // Copied from the screenshot that prompted the fix.
  const body = [
    "",
    "    Directory: D:\astra-backup",
    "",
    "",
    "Mode                 LastWriteTime         Length Name",
    "----                 -------------         ------ ----",
    "-a----          6/28/2026   4:20 AM          17914 astra.html",
    "",
  ].join("\n");
  const rows = outputDetail(body).split("\n");
  assert.equal(rows[0], "    Directory: D:\astra-backup", "leading blank gone");
  assert.equal(rows[1], "", "one blank kept as the group separator");
  assert.equal(rows.at(-1), "-a----          6/28/2026   4:20 AM          17914 astra.html", "trailing blank gone");
  assert.equal(rows.length, 5, "eight source lines, five that carry anything");
});

test("a killed command names the signal and the process it went to", () => {
  // After a timeout the pid is what lets the user check whether it actually died or is
  // still holding a port. On an ordinary exit it is trivia, so it is not shown.
  const out = withOutcome("running suite...", true, null, null, 30_000, 30_040, 59_120);
  assert.match(out, /✗ timed out after 30s/);
  assert.match(out, /Signal: SIGTERM sent to process \(PID 59120\)/);
});

test("a command that exited normally gets NO signal line, pid or not", () => {
  assert.doesNotMatch(withOutcome("done", false, 0, null, 30_000, 1_000, 59_120), /Signal:/);
  assert.doesNotMatch(withOutcome("boom", false, 1, null, 30_000, 1_000, 59_120), /Signal:/);
});

test("a command killed by a signal names THAT signal, not a default", () => {
  assert.match(withOutcome("", false, null, "SIGKILL", 30_000, 1_000, 4242), /Signal: SIGKILL sent to process \(PID 4242\)/);
});

test("with no pid known the outcome line still stands alone", () => {
  assert.equal(withOutcome("", true, null, null, 30_000, 30_050), "✗ timed out after 30s");
});

test("the failure mark is one column wide, like the success mark", () => {
  // On screen: `✓ 0 · 256ms` sat correctly while `✖ 1 · 885ms` arrived as `✖1 · 885ms`.
  // Terminals give the HEAVY multiplication x (U+2716) emoji presentation and two
  // columns, while this code and Ink both measure it as one, so it overprinted the space
  // after it. `✓` and `✗` are the light pair: same block, text presentation, one column.
  assert.equal(OK_MARK, "\u2713");
  assert.equal(FAIL_MARK, "\u2717");
  assert.notEqual(FAIL_MARK, "\u2716", "the heavy mark renders two columns wide");
  // Nothing this module EMITS may carry the heavy one.
  const emitted = [
    withOutcome("", false, 1, null, 120_000, 885),
    withOutcome("", true, null, null, 30_000, 30_050),
    withOutcome("", false, null, "SIGKILL", 30_000, 1_000),
    withOutcome("", false, null, null, 30_000, 1_000),
  ];
  for (const line of emitted) {
    assert.ok(!line.includes("\u2716"), `the heavy mark reached the screen: ${line}`);
  }
});

test("sessionDetailFull keeps the uncut block only when it says more than the short one", () => {
  const short = "$ ls\na\n✓ 0 · 5ms";
  const long = ["$ ls", ...Array.from({ length: 50 }, (_, i) => `f${i}`), "✓ 0 · 5ms"].join("\n");
  assert.equal(sessionDetailFull(short, long), long);
  assert.equal(sessionDetailFull(short, short), undefined, "nothing more to open means nothing to store");
  assert.equal(sessionDetailFull(short, undefined), undefined);
  assert.equal(sessionDetailFull(long, short), undefined, "a shorter 'full' is not more");
});

test("sessionDetailFull is bounded in lines and in characters, and says where it cut", () => {
  const many = Array.from({ length: SESSION_DETAIL_LINES * 2 }, (_, i) => `line ${i}`).join("\n");
  const kept = sessionDetailFull("x", many)!;
  assert.ok(kept.split("\n").length <= SESSION_DETAIL_LINES + 1);
  assert.ok(kept.includes("line 0") && kept.includes(`line ${SESSION_DETAIL_LINES * 2 - 1}`), "both ends survive");
  assert.match(kept, /lines are not kept in the saved session/);
  const wide = `a\n${"z".repeat(SESSION_DETAIL_CHARS * 3)}`;
  const cut = sessionDetailFull("a", wide)!;
  assert.ok(cut.length < SESSION_DETAIL_CHARS + 100);
  assert.match(cut, /the rest is not kept in the saved session/);
});
