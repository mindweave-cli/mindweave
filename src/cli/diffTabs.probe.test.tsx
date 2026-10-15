/**
 * diffTabs.probe.test.tsx — code indented with tabs, drawn under a tool row.
 *
 * A tab moves the cursor without painting, so in a tinted row it left a hole in the colour wherever the
 * code was indented, and the terminal's width for the row no longer matched the layout's. The row has to
 * reach the screen with its tabs already written out as spaces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { createElement } = await import("react");
const { ToolLine } = await import("./components/ToolLine.js");
const { expandTabs } = await import("./diffRows.js");

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

async function frame(detail: string): Promise<string> {
  const out = new Out();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  const instance = render(
    createElement(ToolLine as never, { id: 1, name: "Write", arg: "a.mjs", status: "ok", action: "edit", detail, detailKind: "diff", columns: 100, live: false } as never),
    { stdout: out as unknown as NodeJS.WriteStream, stdin, patchConsole: false, interactive: true, debug: true },
  );
  // Until the row is on screen, not a fixed wait: a loaded CI runner can take longer than that.
  const until = Date.now() + 5000;
  while (!out.longest.includes("entryPoints") && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  instance.unmount();
  return out.longest;
}

test("tabs are written out as spaces, to the next stop of four", () => {
  assert.equal(expandTabs("\tx"), "    x");
  assert.equal(expandTabs("ab\tx"), "ab  x");
  assert.equal(expandTabs("abcd\tx"), "abcd    x");
  assert.equal(expandTabs("no tabs"), "no tabs");
});

test("a diff of tab-indented code reaches the screen without a tab in it", async () => {
  const detail = ["+   1 │ const shared = {", "+   2 │ \t\tentryPoints: ['src/main.ts'],", "+   3 │ \tbundle: true,", "+   4 │ };"].join("\n");
  const shown = await frame(detail);
  assert.ok(shown.includes("entryPoints"), "the row was not drawn");
  assert.ok(!shown.includes("\t"), "a tab reached the terminal, where it moves the cursor without painting the tint");
});
