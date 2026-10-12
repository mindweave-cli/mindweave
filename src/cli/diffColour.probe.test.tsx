/**
 * diffColour.probe.test.tsx — how a numbered diff is painted, checked on the real colours.
 *
 * Only the lines that changed carry a tint; the lines of context around them are dim and have none; the words that
 * differ between a removed line and the line that replaced it are a step brighter. Getting that wrong looks like a
 * wall of red and green again, which is the thing this layout exists to avoid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink (and chalk) load: colour support is fixed at import time.
process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { createElement } = await import("react");
const { ToolLine } = await import("./components/ToolLine.js");
const { diffDetail } = await import("../tools/detail.js");

class Out extends EventEmitter {
  columns = 100;
  rows = 40;
  isTTY = true as const;
  longest = "";
  write(d: string): boolean {
    if (d.length > this.longest.length) this.longest = d;
    return true;
  }
}

const ESC = String.fromCharCode(27);
const strip = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
/** The background SGR a hex colour becomes in truecolor. */
const bg = (r: number, g: number, b: number): string => `48;2;${r};${g};${b}`;

async function frame(detail: string, open = false): Promise<string[]> {
  const out = new Out();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  const instance = render(
    createElement(ToolLine as never, {
      id: 1,
      full: open ? detail : undefined,
      expanded: open,
      name: "Update",
      arg: "a.ts",
      status: "ok",
      action: "edit",
      detail,
      detailKind: "diff",
      columns: 100,
      live: false,
    } as never),
    { stdout: out as unknown as NodeJS.WriteStream, stdin, patchConsole: false, interactive: true, debug: true },
  );
  await new Promise((r) => setTimeout(r, 120));
  instance.unmount();
  return out.longest.split("\n");
}

const BEFORE = ["keep one", "keep two", 'run({ action: "click" }, c);', "keep three", "keep four"].join("\n");
const AFTER = ["keep one", "keep two", 'run({ action: "click", wait_ms: ceiling }, c);', "keep three", "keep four"].join("\n");

test("changed lines are tinted, the context around them is not", async () => {
  const rows = await frame(diffDetail(BEFORE, AFTER)!);
  const removed = rows.find((r) => strip(r).includes("- 3 │"))!;
  const added = rows.find((r) => strip(r).includes("+ 3 │"))!;
  const context = rows.find((r) => strip(r).includes("keep three"))!;
  assert.ok(removed.includes(bg(45, 17, 19)), "the removed line has the red tint");
  assert.ok(added.includes(bg(13, 40, 24)), "the added line has the green tint");
  assert.ok(!context.includes("48;2;"), "an unchanged line has no tint at all");
});

test("the numbers sit in a dim gutter before the bar", async () => {
  const rows = (await frame(diffDetail(BEFORE, AFTER)!)).map(strip);
  const keep = rows.find((r) => r.includes("keep two"))!;
  assert.match(keep, /\s2 │ keep two/);
});

test("the words that were added are marked brighter than the rest of the line", async () => {
  const rows = await frame(diffDetail(BEFORE, AFTER)!);
  const added = rows.find((r) => strip(r).includes("+ 3 │"))!;
  assert.ok(added.includes(bg(26, 92, 51)), "the added words have the brighter tint");
  // And only they do: the start of the line is on the plain tint.
  const marked = added.slice(added.indexOf(bg(26, 92, 51)) + bg(26, 92, 51).length + 1);
  assert.ok(strip(marked).startsWith(", wait_ms: ceiling"), strip(marked).slice(0, 30));
});

test("a long line carries on under itself in an opened block, with the bar kept in its column", async () => {
  const long = `${"word ".repeat(40)}end`;
  const detail = diffDetail("a\nb\nc", `a\n${long}\nc`)!;
  const rows = (await frame(detail, true)).map(strip);
  const first = rows.findIndex((r) => r.includes("+ 2 │"));
  assert.ok(first >= 0);
  const bar = rows[first]!.indexOf("│");
  assert.equal(rows[first + 1]!.indexOf("│"), bar, "the next row keeps the bar in the same column");
  assert.ok(rows.slice(first, first + 3).join("").includes("end"), "nothing was cut off");
});

test("a diff saved by an older version, with no numbers, still draws as before", async () => {
  const rows = await frame(["- old line", "+ new line"].join("\n"));
  const removed = rows.find((r) => strip(r).includes("- old line"))!;
  const added = rows.find((r) => strip(r).includes("+ new line"))!;
  assert.ok(removed.includes(bg(45, 17, 19)));
  assert.ok(added.includes(bg(13, 40, 24)));
});
