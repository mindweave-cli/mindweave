/**
 * uiBatch.test.ts — several steps in one `ui` call, controls by name, waiting for text,
 * resizing the viewport, inspecting a control, and close-up pictures.
 *
 * The pure parts (name matching, the argument rules, the summary line) are tested directly;
 * then a hidden browser runs a page built to need each of them. That half skips without a
 * Chromium-family browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolContext } from "./types.js";
import { findBrowser } from "./browser.js";
import { batchSummary, findControl, parseUiArgs, ui } from "./ui.js";
import type { UiControl } from "./uiWin.js";
import { toolDisplay } from "../cli/toolDisplay.js";

function ctx(): ToolContext {
  return { cwd: process.cwd(), reads: new Map(), todos: [] } as unknown as ToolContext;
}

const control = (name: string, extra: Partial<UiControl> = {}): UiControl => ({ id: name, window: 0, kind: "button", name, value: "", actions: ["click"], state: [], ...extra });

// ── names ────────────────────────────────────────────────────────────────────

test("findControl: exact beats prefix beats contains, and the control in view wins a tie", () => {
  const list = [control("Save"), control("Save as…"), control("Autosave settings")];
  assert.deepEqual(findControl(list, "save"), { n: 1 });
  assert.deepEqual(findControl(list, "Save a"), { n: 2 });
  assert.deepEqual(findControl(list, "autosave"), { n: 3 });
  const two = [control("Delete", { state: ["out of view"] }), control("Delete")];
  assert.deepEqual(findControl(two, "Delete"), { n: 2 }, "the one a person could see is the one meant");
});

test("findControl: says which controls match when it cannot choose, and when none does", () => {
  const same = [control("Open"), control("Open")];
  const r = findControl(same, "Open");
  assert.ok("error" in r && /more than one control matches "Open"/.test(r.error) && /\[1\]/.test(r.error) && /\[2\]/.test(r.error));
  const none = findControl([control("Go")], "Stop");
  assert.ok("error" in none && /no control in the latest list is named "Stop"/.test(none.error));
});

// ── arguments ────────────────────────────────────────────────────────────────

test("parseUiArgs: steps are checked one by one and cannot open pages or nest", () => {
  const ok = parseUiArgs({ url: "localhost:5173", steps: [{ action: "click", name: "Go" }, { action: "type", name: "Title", text: "x" }] });
  assert.ok(ok.ok && ok.steps?.length === 2 && ok.steps[0]!.name === "Go" && ok.action === "look" && ok.url === "http://localhost:5173/");
  const empty = parseUiArgs({ steps: [] });
  assert.ok(!empty.ok && /steps. is empty/.test(empty.error));
  const nested = parseUiArgs({ steps: [{ action: "click", name: "a", url: "x.com" }] });
  assert.ok(!nested.ok && /step 1 cannot open a page/.test(nested.error));
  const look = parseUiArgs({ steps: [{ action: "look" }] });
  assert.ok(!look.ok && /not a step/.test(look.error));
  const noTarget = parseUiArgs({ steps: [{ action: "click" }] });
  assert.ok(!noTarget.ok && /step 1: .*needs .target/.test(noTarget.error));
  const tooMany = parseUiArgs({ steps: Array.from({ length: 26 }, () => ({ action: "key", key: "Tab" })) });
  assert.ok(!tooMany.ok && /26 steps/.test(tooMany.error));
});

test("parseUiArgs: wait, resize and inspect say what they need", () => {
  assert.ok(!parseUiArgs({ action: "wait" }).ok);
  const w = parseUiArgs({ action: "wait", text: "Saved", wait_ms: 99_999 });
  assert.ok(w.ok && w.waitMs === 30_000);
  assert.ok(!parseUiArgs({ action: "resize", width: 100, height: 50 }).ok);
  const phone = parseUiArgs({ action: "resize", width: 390, height: 844, mobile: true });
  assert.ok(phone.ok && phone.width === 390 && phone.mobile);
  assert.ok(parseUiArgs({ action: "resize", width: 0, height: 0 }).ok, "0 by 0 gives the size back");
  assert.ok(!parseUiArgs({ action: "inspect" }).ok);
  assert.ok(parseUiArgs({ action: "inspect", name: "Save" }).ok);
});

test("a batch reads as one row: the summary lists its steps, and the row says how many", () => {
  assert.equal(
    batchSummary([{ action: "click", target: 'button "Add"', ok: true }, { action: "type", target: 'text box "Title"', input: "x", ok: true }], false),
    'click "Add", type "Title"'.replace(/^/, "2 steps: "),
  );
  assert.match(batchSummary([{ action: "click", ok: true }, { action: "click", ok: false }], true), /^1 of 2 steps:/);
  assert.deepEqual(toolDisplay("ui", { steps: [{ action: "click" }, { action: "click" }] }), { name: "Steps", arg: "2 steps", kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "click", name: "Save" }), { name: "Click", arg: '"Save"', kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "wait", text: "Saved" }), { name: "Wait", arg: '"Saved"', kind: "screenshot" });
  assert.deepEqual(toolDisplay("ui", { action: "resize", width: 390, height: 844 }), { name: "Resize", arg: "390×844", kind: "screenshot" });
});

// ── a real page ──────────────────────────────────────────────────────────────

const PAGE = `<!doctype html><title>Batch</title><style>
  .tiny { width: 14px; height: 14px; padding: 0; font-size: 9px; color: #aaa; background: #fff; border: 0 }
  #menu { display: none }
  .wide { width: 900px; height: 30px; background: #ddd }
</style><body>
<button onclick="document.getElementById('menu').style.display='block'">Open menu</button>
<div id="menu"><button onclick="setTimeout(() => { document.getElementById('st').textContent = 'saved ' + document.getElementById('nm').value }, 600)">Save it</button></div>
<input id="nm" aria-label="Title">
<div id="st">idle</div>
<button class="tiny" aria-label="Tiny">x</button>
<div class="wide">wide block</div>
<script>console.warn("heads up")</script>
<div style="height:1800px">tall</div></body>`;

const browser = findBrowser();
const skip = browser ? false : "no Chromium-family browser installed";

test("one call runs a whole walk: open a menu, type, save, wait for the result", { skip, timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uibatch-"));
  const file = join(dir, "batch.html");
  await writeFile(file, PAGE, "utf8");
  const c = ctx();
  const progress: string[] = [];
  const call = { progress: (t: string) => progress.push(t) };
  try {
    let r = await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
    assert.match(r.output, /1 console warning|logged 1 warning/);
    assert.match(r.output, /heads up/);

    // "Save it" is not on the page until the menu step has run: it is found by name just before its step.
    r = await ui.execute(
      { steps: [{ action: "click", name: "Open menu" }, { action: "type", name: "Title", text: "Halo" }, { action: "click", name: "Save it" }, { action: "wait", text: "saved Halo" }] },
      c,
      call,
    );
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /^Ran 4 of 4 steps:/);
    assert.match(r.output, /4\. Waited: "saved Halo" is on the page/);
    assert.match(r.output, /status|saved Halo/);
    assert.ok(r.images?.length === 1, "one picture for the whole call");
    assert.match(r.summary ?? "", /^4 steps: click "Open menu", type "Title"/);
    assert.equal(r.ui?.action, "steps");
    assert.equal(r.ui?.steps?.length, 4);
    assert.ok(progress.length >= 4 && /^1\. /.test(progress[0]!) && /4\. /.test(progress[progress.length - 1]!), "the steps were reported as they ran, one after another");

    // It stops at the first step that cannot be done, and says what was not run.
    r = await ui.execute({ steps: [{ action: "click", name: "No such button" }, { action: "click", name: "Open menu" }] }, c);
    assert.equal(r.isError, true);
    assert.match(r.output, /Ran 0 of 2 steps/);
    assert.match(r.output, /Stopped at step 1; 1 later step was not run/);
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});

test("wait returns as soon as the text is there, and says so when it never comes", { skip, timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uibatch-"));
  const file = join(dir, "batch.html");
  await writeFile(file, PAGE, "utf8");
  const c = ctx();
  try {
    await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
    await ui.execute({ action: "click", name: "Open menu" }, c);
    await ui.execute({ action: "click", name: "Save it" }, c);
    const t0 = Date.now();
    let r = await ui.execute({ action: "wait", text: "saved", wait_ms: 8000 }, c);
    assert.match(r.output, /Waited: "saved" is on the page/);
    assert.ok(Date.now() - t0 < 4000, "returned when the text arrived, not after the full time");
    r = await ui.execute({ action: "wait", text: "never shown", wait_ms: 1000 }, c);
    assert.equal(r.isError, true);
    assert.match(r.output, /"never shown" never appeared/);
    r = await ui.execute({ action: "wait", gone: "saved", wait_ms: 600 }, c);
    assert.match(r.output, /"saved" never went away/);
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});

test("resize sets the viewport and gives it back; inspect names what is wrong with a control", { skip, timeout: 90_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uibatch-"));
  const file = join(dir, "batch.html");
  await writeFile(file, PAGE, "utf8");
  const c = ctx();
  try {
    await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
    let r = await ui.execute({ action: "resize", width: 390, height: 844, mobile: true }, c);
    assert.match(r.output, /Viewport is now 390x844/);
    assert.match(r.output, /The viewport is set to 390x844/);
    assert.equal(r.images?.[0]?.width, 390);
    r = await ui.execute({ action: "resize", width: 0, height: 0 }, c);
    assert.match(r.output, /back to the window's own size/);
    assert.doesNotMatch(r.output, /The viewport is set to/);

    r = await ui.execute({ action: "inspect", name: "Tiny" }, c);
    assert.equal(r.isError, undefined, r.output);
    assert.match(r.output, /Inspection of \[\d+\] button "Tiny":/);
    assert.match(r.output, /small press target \(14x14/);
    assert.match(r.output, /low contrast/);
    assert.match(r.output, /box: 14x14/);

    // A close-up of one control, and the whole page, are different pictures from the viewport's.
    const view = await ui.execute({ action: "look" }, c);
    const close = await ui.execute({ action: "look", name: "Tiny" }, c);
    const full = await ui.execute({ action: "look", full: true }, c);
    assert.ok(close.images![0]!.height! < 100, `a close-up is small (was ${close.images![0]!.height})`);
    assert.ok(full.images![0]!.height! > view.images![0]!.height!, "the whole page is taller than the viewport");
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a click waits only as long as the page keeps changing", { skip, timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uibatch-"));
  const file = join(dir, "batch.html");
  await writeFile(file, PAGE, "utf8");
  const c = ctx();
  try {
    await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
    const t0 = Date.now();
    await ui.execute({ action: "click", name: "Open menu" }, c);
    const took = Date.now() - t0;
    assert.ok(took < 450, `a still page answers well before the 500ms ceiling (took ${took}ms)`);
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a step that changed nothing does not send the list or the picture again", { skip, timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uibatch-"));
  const file = join(dir, "batch.html");
  await writeFile(file, PAGE, "utf8");
  const c = ctx();
  try {
    let r = await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
    assert.match(r.output, /1. button "Open menu"|\[1\] button "Open menu"/, "a look always sends the list");
    assert.ok(r.images?.length === 1);
    r = await ui.execute({ action: "hover", name: "Tiny" }, c);
    assert.match(r.output, /The controls are the same as before: 3/);
    assert.match(r.output, /The picture is identical to the last one/);
    assert.equal(r.images, undefined, "no second copy of the same picture");
    // After a few steps the list is sent whole again, in case an old result was trimmed from the context.
    let again = 0;
    for (let i = 0; i < 4; i++) {
      r = await ui.execute({ action: "hover", name: "Tiny" }, c);
      if (/\[1\] button "Open menu"/.test(r.output)) again++;
    }
    assert.ok(again >= 1, "the full list comes back every few results");
    // A look is never shortened.
    r = await ui.execute({ action: "look" }, c);
    assert.match(r.output, /\[1\] button "Open menu"/);
    assert.ok(r.images?.length === 1);
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});

test("annotate draws the list numbers on the picture and leaves nothing behind", { skip, timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uibatch-"));
  const file = join(dir, "batch.html");
  await writeFile(file, PAGE, "utf8");
  const c = ctx();
  try {
    await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
    const plain = await ui.execute({ action: "look" }, c);
    const marked = await ui.execute({ action: "look", annotate: true }, c);
    assert.ok(marked.images?.length === 1);
    const { readFile } = await import("node:fs/promises");
    const a = await readFile(plain.images![0]!.path);
    const b = await readFile(marked.images![0]!.path);
    assert.notDeepEqual(a, b, "the numbered picture differs from the plain one");
    const after = await ui.execute({ action: "look" }, c);
    const again = await readFile(after.images![0]!.path);
    assert.deepEqual(again, a, "the overlay is gone again: the page is exactly as it was");
    assert.doesNotMatch(after.output, /__mwui_overlay/);
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a control something else sits on top of is marked covered in the list", { skip, timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mw-uibatch-"));
  const file = join(dir, "cover.html");
  await writeFile(file, `<!doctype html><title>Cover</title><button>Free</button><button>Hidden behind</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.4)" id="backdrop"></div><button style="position:fixed;top:5px;right:5px;z-index:10">On top</button>`, "utf8");
  const c = ctx();
  try {
    const r = await ui.execute({ action: "look", url: pathToFileURL(file).href }, c);
    assert.match(r.output, /button "Free" \(covered\)/);
    assert.match(r.output, /button "Hidden behind" \(covered\)/);
    assert.doesNotMatch(r.output, /button "On top" \(covered\)/, "the control above the backdrop is reachable");
  } finally {
    await ui.execute({ action: "close" }, c);
    await rm(dir, { recursive: true, force: true });
  }
});
