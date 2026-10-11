/**
 * uiRow.test.ts — what a UI test's row shows, and what opens behind it.
 *
 * The row used to print the steps, then the whole page: twenty or thirty lines of numbered
 * controls under three lines of steps. The steps are the part worth reading, so they stay,
 * one row each; the page becomes one line, with the list behind a click.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneLineSteps } from "./detail.js";
import { controlList, pageSummary, uiRowDetail } from "./ui.js";
import type { UiControl, UiSnapshot } from "./uiWin.js";

function control(kind: string, name: string, state: string[] = []): UiControl {
  return { id: name, window: 0, kind, name, value: "", actions: ["click"], state };
}

/** The page from the screenshot this was designed against, in miniature: 2 tabs, 14 buttons, 3 inputs. */
function page(): UiSnapshot {
  const controls = [
    control("tabitem", "Writing"), control("tabitem", "Formatting", ["disabled"]),
    ...Array.from({ length: 14 }, (_, i) => control("button", `B${i}`, i > 9 ? ["out of view"] : [])),
    control("edit", "Chapter text"), control("combobox", "Page size"), control("combobox", "Body font"),
  ];
  return { windows: [{ handle: "1", title: "Book" }], controls, texts: [], more: 0 };
}

const DID = [
  "Ran 3 of 3 steps:",
  '1. Clicked [18] text box "Chapter text".',
  '2. Typed "One paragraph here.',
  "",
  'And a second one." into [18] text box "Chapter text".',
  '3. Waited: "And a second one." is on the page (after 0ms).',
].join("\n");

test("a batch's steps come out one row each, with a typed line break marked instead of spilling", () => {
  const rows = oneLineSteps(DID);
  assert.equal(rows.length, 3, "three steps, three rows, not five");
  assert.match(rows[0]!, /^1\. Clicked/);
  assert.ok(rows[1]!.includes("↵"), "the line break inside what was typed is marked");
  assert.ok(!rows[1]!.includes("\n"));
  assert.match(rows[2]!, /^3\. Waited/);
  assert.ok(!rows.some((r) => r.startsWith("Ran ")), "the header is not a step");
  assert.ok(oneLineSteps(`1. ${"x".repeat(300)}`)[0]!.length <= 110, "a long step is clipped to a row");
  assert.deepEqual(oneLineSteps("Waiting for the app on port 3000"), [], "a note that is not a step is not one");
});

test("the page is one line: how many, what kinds, and how many are out of view", () => {
  const line = pageSummary(page());
  assert.match(line, /^page: 19 elements/);
  assert.match(line, /14 buttons/);
  assert.match(line, /2 tabs/);
  assert.match(line, /2 dropdowns/, "a list is ranked by how many, and the plural is spoken right");
  assert.match(line, /1 more kind/, "four kinds exist, three are named");
  assert.match(line, /\(4 out of view\)/);
  assert.equal(pageSummary({ ...page(), controls: [] }), "page: nothing readable");
  assert.match(pageSummary({ ...page(), controls: [control("edit", "a")] }), /1 element — 1 text box$/);
});

test("a run that went well shows its steps and one line about the page, with the whole result behind a click", () => {
  const snap = page();
  const r = uiRowDetail({ did: DID, batch: true, fullList: controlList(snap), reports: "", snap, failed: false, errs: 0 });
  const rows = r.detail.split("\n");
  assert.equal(rows.length, 4, "three steps and the page line");
  assert.match(rows[3]!, /^page: 19 elements/);
  assert.ok(r.detailFull && r.detailFull.startsWith("Steps \u00b7 3 of 3 ran\n"), "the opened view opens on the steps, under a title");
  assert.ok(r.detailFull!.includes("\n\nPage \u00b7 19 elements (4 out of view)\n"), "then the page, under its own");
  assert.ok(r.detailFull!.split("\n").length > 20, "including the full numbered list");
});

test("a look at a page, with nothing done, is the page line alone", () => {
  const snap = page();
  const r = uiRowDetail({ did: "", batch: false, fullList: controlList(snap), reports: "", snap, failed: false, errs: 0 });
  assert.equal(r.detail.split("\n").length, 1);
  assert.match(r.detail, /^page: /);
  assert.ok(r.detailFull);
});

test("a failure keeps its reason on the row, and what the page said, but the control list folds away", () => {
  const snap = page();
  const failed = uiRowDetail({ did: "Could not click it", batch: false, fullList: controlList(snap), reports: "", snap, failed: true, errs: 0 });
  assert.ok(failed.detailFull, "the whole result is behind a click");
  const rows = failed.detail.split("\n");
  assert.equal(rows.length, 2, "the reason and one line about the page");
  assert.equal(rows[0], "Could not click it");
  assert.match(rows[1]!, /^page: 19 elements/);
  const reported = uiRowDetail({ did: DID, batch: true, fullList: controlList(snap), reports: "The page reported 1 error", snap, failed: false, errs: 1 });
  assert.ok(reported.detailFull);
  assert.ok(reported.detail.includes("The page reported 1 error"), "what the page said is on the row");
  assert.ok(reported.detail.split("\n").length < 8, "and the list of controls is not");
});

// ── rows saved before the short form existed ─────────────────────────────────

import { compactUiDetail } from "./rebuildDetail.js";

const OLD_SAVED = [
  "Ran 3 of 3 steps:",
  '1. Clicked [18] text box "Chapter text".',
  '2. Typed "One paragraph here.',
  "",
  'And a second one." into [18] text box "Chapter text".',
  '3. Waited: "And a second one." is on the page (after 0ms).',
  "",
  '[1] tab "Writing" (selected)',
  '[2] tab "Formatting" (disabled)',
  '[3] button "Toggle color theme"',
  '[4] button "Title Page" (disabled)',
  '[5] button "Chapter 1 (out of view)" (out of view)',
  '[6] text box "Chapter text" = "One paragraph here. And a second one." [type]',
  '[7] dropdown "Page size" = "Trade 6 x 9" [type]',
].join("\n");

test("a UI test saved before the short form comes back as the short form, with the whole text to open", () => {
  const r = compactUiDetail(OLD_SAVED, false)!;
  assert.ok(r, "an old row is recognised");
  const rows = r.detail.split("\n");
  assert.equal(rows.length, 4, "three steps and the page line");
  assert.match(rows[1]!, /Typed .*↵.*And a second one/);
  assert.match(rows[3]!, /^page: 7 elements — 3 buttons, 2 tabs, 1 text box/);
  assert.match(rows[3]!, /1 more kind/, "a fourth kind exists, so it is counted, not dropped");
  assert.match(rows[3]!, /\(1 out of view\)/);
  const open = r.detailFull!.split("\n");
  assert.equal(open[0], "Steps \u00b7 3 of 3 ran");
  assert.equal(open[2], '  2. Typed "One paragraph here.\u21b5\u21b5And a second one." into [18] text box "Chapter text".', "a typed paragraph break is marked, not a split");
  assert.ok(open.includes("Page \u00b7 7 elements (1 out of view)"));
  assert.ok(open.includes('  [1] tab "Writing" (selected)'), "every control is still there, indented under the page");
  assert.equal(open.filter((l) => /^\s+\[\d+\] /.test(l)).length, 7);
});

test("an old row that failed, or that had the page's own reports, keeps those on the row and folds the list", () => {
  const failed = compactUiDetail(OLD_SAVED, true)!;
  assert.ok(failed.detailFull, "the whole text is behind a click");
  assert.ok(failed.detail.split("\n").length <= 5, "steps and the page line, not every control");
  const reported = compactUiDetail(`${OLD_SAVED}\n\nThe page reported 1 error since the last step:\n  - boom`, false)!;
  assert.ok(reported.detailFull);
  assert.ok(reported.detail.includes("The page reported 1 error"));
  assert.ok(reported.detail.includes("- boom"));
  assert.ok(!reported.detail.includes('[1] tab "Writing"'), "the control list is not on the row");
  // Not a control list at all: left exactly as it was.
  assert.equal(compactUiDetail("No controls could be read here. Some apps expose nothing.", false), undefined);
  assert.equal(compactUiDetail("", false), undefined);
  assert.equal(compactUiDetail(undefined, false), undefined);
});

test("an old Look, with no steps, becomes the page line alone", () => {
  const look = ['[1] button "Go"', '[2] button "Stop"'].join("\n");
  const r = compactUiDetail(look, false)!;
  assert.equal(r.detail, "page: 2 elements — 2 buttons");
});

test("an old row that was grouped by window keeps counting past the window headings", () => {
  const grouped = ['In "Main":', '  [1] button "A"', 'In "Dialog":', '  [2] button "B"', '  [3] edit "Name"'].join("\n");
  assert.match(compactUiDetail(grouped, false)!.detail, /^page: 3 elements/);
});
