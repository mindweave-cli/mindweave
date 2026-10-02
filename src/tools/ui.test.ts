/**
 * ui.test.ts — reading the window's controls, naming them for the model, and the
 * refusal paths.
 *
 * Nothing here opens a window: CI has no interactive desktop. What is tested is the part
 * that decides what the model is told and what gets acted on, which is where a mistake
 * presses the wrong button.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "./types.js";
import { parseSnapshot, type UiControl } from "./uiWin.js";
import { controlLine, controlList, describeAction, parseUiArgs, screenText, stepDisplay, ui, unnamedNote } from "./ui.js";
import { toolDisplay } from "../cli/toolDisplay.js";
import { parseMoved } from "./uiHide.js";
import { guardDetail } from "../dynamo/guard.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [], ...overrides } as ToolContext;
}

function control(over: Partial<UiControl> = {}): UiControl {
  return { id: "42.1", window: 0, kind: "button", name: "Go", value: "", actions: ["click"], state: [], ...over };
}

// ── parseSnapshot ────────────────────────────────────────────────────────────

test("parseSnapshot reads the top window, windows, controls, the overflow and the action", () => {
  const snap = parseSnapshot(
    "ACT\tOK pressed\r\n" +
      "TOP\t900\tAbout MW\r\n" +
      "WIN\t800\tMW UI Test\r\n" +
      "EL\t42.1.4.0\t0\ttabitem\tHome\t\tclick\tselected\r\n" +
      "EL\t42.2\t0\tedit\tSearch\thalo\ttype\t\r\n" +
      "EL\t42.3\t0\tbutton\t\t\tclick\t\r\n" +
      "MORE\t12\r\n",
  );
  assert.deepEqual(snap.acted, { ok: true, text: "pressed" });
  assert.deepEqual(snap.top, { handle: "900", title: "About MW" });
  assert.deepEqual(snap.windows, [{ handle: "800", title: "MW UI Test" }]);
  assert.equal(snap.controls.length, 3);
  assert.deepEqual(snap.controls[0], { id: "42.1.4.0", window: 0, kind: "tabitem", name: "Home", value: "", actions: ["click"], state: ["selected"] });
  assert.equal(snap.controls[1]!.value, "halo");
  assert.deepEqual(snap.controls[1]!.actions, ["type"]);
  assert.equal(snap.controls[2]!.name, "");
  assert.equal(snap.more, 12);
});

test("parseSnapshot reports a failed action and a closed window", () => {
  assert.deepEqual(parseSnapshot("ACT\tERR GONE\n").acted, { ok: false, text: "GONE" });
  assert.equal(parseSnapshot("ERR the window is gone\n").error, "the window is gone");
});

test("parseSnapshot skips lines that are not its shape instead of guessing", () => {
  const snap = parseSnapshot("warning: something\nEL\tshort\n\nWIN\n");
  assert.deepEqual(snap.controls, []);
  assert.deepEqual(snap.windows, []);
});

// ── what the model reads ─────────────────────────────────────────────────────

test("controlLine names the control in plain words, with its value and state", () => {
  assert.equal(controlLine(1, control({ kind: "tabitem", name: "Library", state: ["selected"] })), '[1] tab "Library" (selected)');
  assert.equal(controlLine(2, control({ kind: "edit", name: "Search", value: "halo", actions: ["type"] })), '[2] text box "Search" = "halo" [type]');
  assert.equal(controlLine(3, control({ name: "" })), "[3] button (no name)");
  assert.equal(controlLine(4, control({ state: ["disabled"] })), '[4] button "Go" (disabled)');
});

test("a password field is marked as never typed into, and its value never shown", () => {
  const line = controlLine(5, control({ kind: "edit", name: "Password", value: "", actions: ["type"], state: ["password"] }));
  assert.match(line, /password: never typed into/);
});

test("controlList groups by window only when a dialog or popup is open", () => {
  const one = controlList({ windows: [{ handle: "1", title: "App" }], controls: [control()], texts: [], more: 0 });
  assert.equal(one, '[1] button "Go"');
  const two = controlList({
    windows: [{ handle: "1", title: "App" }, { handle: "2", title: "Save as" }],
    controls: [control(), control({ window: 1, name: "Save" })],
    texts: [],
    more: 3,
  });
  assert.match(two, /In "App":\n {2}\[1\] button "Go"\nIn "Save as":\n {2}\[2\] button "Save"/);
  assert.match(two, /3 more not listed/);
});

test("an app with nothing readable says so instead of an empty list", () => {
  assert.match(controlList({ windows: [], controls: [], texts: [], more: 0 }), /No controls could be read/);
});

test("the words on screen reach the model, without repeating control names", () => {
  const snap = parseSnapshot(
    "WIN\t1\tApp\nEL\t42.1\t0\tbutton\tGo\t\tclick\t\nTX\t0\tstatus: searched mario\nTX\t0\tGo\nTX\t0\tstatus: searched mario\n",
  );
  assert.equal(screenText(snap), "Text on screen:\n  status: searched mario");
  assert.equal(screenText({ ...snap, texts: [] }), "");
});

test("unnamed controls are called out with the fix, and only when there are some", () => {
  assert.equal(unnamedNote([control()]), "");
  const note = unnamedNote([control(), control({ name: "" }), control({ name: "" })]);
  assert.match(note, /^2 controls have no name/);
  assert.match(note, /aria-label/);
  assert.match(note, /AutomationProperties\.Name/);
});

test("describeAction says what the control actually did", () => {
  assert.equal(describeAction("click", '[1] tab "Library"', "", "down", "selected"), 'Selected [1] tab "Library".');
  assert.equal(describeAction("click", '[2] checkbox "Dark"', "", "down", "toggled"), 'Toggled [2] checkbox "Dark".');
  assert.equal(describeAction("type", '[3] text box "Search"', "halo", "down"), 'Typed "halo" into [3] text box "Search".');
  assert.equal(describeAction("scroll", "[4] list", "", "up"), "Scrolled up in [4] list.");
  assert.equal(describeAction("scroll", '[5] button "Game 18"', "", "down", "brought into view"), 'Brought [5] button "Game 18" into view.');
});

// ── arguments ────────────────────────────────────────────────────────────────

test("parseUiArgs needs a target to click or type, and text to type", () => {
  assert.equal(parseUiArgs({ action: "look", window: "Gamo" }).ok, true);
  assert.equal(parseUiArgs({ action: "click" }).ok, false);
  assert.equal(parseUiArgs({ action: "click", target: 0 }).ok, false);
  assert.equal(parseUiArgs({ action: "type", target: 2 }).ok, false);
  assert.equal(parseUiArgs({ action: "hover" }).ok, false);
  assert.equal(parseUiArgs({ action: "scroll", direction: "sideways" }).ok, false);
  const ok = parseUiArgs({ action: "click", target: "4", wait_ms: 99_999 });
  assert.ok(ok.ok && ok.target === 4 && ok.settleMs === 10_000);
});

// ── refusals ─────────────────────────────────────────────────────────────────

test("never runs from a context with nobody to ask (a sub-agent)", async () => {
  if (process.platform !== "win32") return;
  const result = await ui.execute({ action: "look", window: "anything" }, ctx());
  assert.match(result.output, /nobody to ask/);
});

test("acting before looking is refused with the call to make", async () => {
  if (process.platform !== "win32") return;
  // Any real window will do; the point is that there is no list to take a number from.
  const result = await ui.execute({ action: "click", target: 1 }, ctx({ requestApproval: async () => "Yes" }));
  assert.equal(result.isError, true);
  assert.match(result.output, /Name what to use/);
});

test("a malformed call is fixed quietly by the model, not shown as a red row", async () => {
  const result = await ui.execute({ action: "click" }, ctx({ requestApproval: async () => "Yes" }));
  assert.equal(result.quiet, true);
});

// ── display and the permission block ─────────────────────────────────────────

test("the row is named by what it does to the app", () => {
  assert.deepEqual(toolDisplay("ui", { action: "look", window: "Gamo" }), { name: "Look", arg: "Gamo", kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "click", target: 4 }), { name: "Click", arg: "#4", kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "type", target: 2, text: "halo" }), { name: "Type", arg: '"halo"', kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "scroll" }), { name: "Scroll", arg: "down", kind: "screenshot" });
});

test("the Sentinel block says which window and what is about to be done", () => {
  const detail = guardDetail("ui", { action: "type", target: 2, text: "halo", window: "Gamo" });
  assert.match(detail, /Action: App control/);
  assert.match(detail, /App: Gamo/);
  assert.match(detail, /Do: type #2 "halo"/);
});

// ── the step record the test view draws ──────────────────────────────────────

test("stepDisplay: a failed action says what stopped it", () => {
  const snap = parseSnapshot("EL\t1\t0\tbutton\tGo\t\tclick\t\n");
  const d = stepDisplay({ live: "L", action: "click", target: 'button "Go"', app: "Shop", startedAt: 1, failWhy: "it is covered by <div>", before: [] }, snap, true);
  assert.equal(d.ok, false);
  assert.equal(d.why, "it is covered by <div>");
  assert.equal(d.live, "L");
});

test("stepDisplay: a page error during the step fails it, even though the click worked", () => {
  const snap = { ...parseSnapshot(""), errors: ["TypeError: x is undefined"] };
  const d = stepDisplay({ live: "L", action: "click", target: 'button "Pay"', app: "Shop", startedAt: 1, before: [] }, snap, false);
  assert.equal(d.ok, false);
  assert.equal(d.why, "TypeError: x is undefined");
  assert.deepEqual(d.errors, ["TypeError: x is undefined"]);
});

test("stepDisplay: a step that worked says what newly appeared on screen", () => {
  const snap = parseSnapshot("EL\t1\t0\tbutton\tGo\t\tclick\t\nTX\t0\tstatus: idle\nTX\t0\t2 results\nTX\t0\tGo\n");
  const d = stepDisplay({ live: "L", action: "key", input: "Enter", app: "Shop", startedAt: 1, before: ["status: idle"] }, snap, false);
  assert.equal(d.ok, true);
  assert.equal(d.why, "2 results");
  assert.equal(d.input, "Enter");
});

test("stepDisplay: acting on a control with no name is flagged without failing", () => {
  const d = stepDisplay({ live: "L", action: "click", target: "button (no name)", app: "Shop", startedAt: 1, before: [] }, parseSnapshot(""), false);
  assert.equal(d.ok, true);
  assert.match(d.warn ?? "", /no accessible name/);
});

// ── keeping the agent's own apps off the user's screen ──────────────────────

test("parseMoved reads which windows were moved and where they were", () => {
  assert.deepEqual(parseMoved("MOVED\t12345\t-8\t20\r\nNOTOURS\nMOVED\tbad\t1\t2\nMOVED\t77\t100\t200\n"), [
    { handle: "12345", x: -8, y: 20 },
    { handle: "77", x: 100, y: 200 },
  ]);
  assert.deepEqual(parseMoved("NONE\n"), []);
});

test("show: true is only read as a real yes", () => {
  const on = parseUiArgs({ action: "look", port: 9222, show: true });
  const off = parseUiArgs({ action: "look", port: 9222, show: "yes" });
  assert.ok(on.ok && on.show === true);
  assert.ok(off.ok && off.show === false);
});

test("the launch recipe keeps a hidden app drawing, so it can still be watched", () => {
  assert.match(ui.description, /disable-backgrounding-occluded-windows/);
  assert.match(ui.description, /show: true/);
});
