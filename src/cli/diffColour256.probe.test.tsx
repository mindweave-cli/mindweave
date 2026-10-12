/**
 * diffColour256.probe.test.tsx — a diff on a 256-colour terminal (Apple's Terminal.app, a plain xterm-256color session).
 *
 * The tints must be the palette entries picked for it, drawn as 256-colour backgrounds (`48;5;N`), and not a hex colour the
 * terminal then maps onto whatever hue is nearest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink (and chalk) load: colour support is fixed at import time.
// chalk's own detection says truecolor on any modern Windows whatever FORCE_COLOR is, so the level is set directly, before the
// components (which read it once, at load) are imported.
const { default: chalk } = await import("chalk");
chalk.level = 2;
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

test("changed lines use the 256-colour palette entries chosen for them", async () => {
  const out = new Out();
  const detail = diffDetail("one\ntwo\nthree\nfour\nfive", "one\ntwo\nTHREE\nfour\nfive")!;
  const instance = render(
    createElement(ToolLine as never, { id: 1, name: "Update", arg: "a.ts", status: "ok", action: "edit", detail, detailKind: "diff", columns: 100, live: false } as never),
    { stdout: out as unknown as NodeJS.WriteStream, stdin: new EventEmitter() as unknown as NodeJS.ReadStream, patchConsole: false, interactive: true, debug: true },
  );
  await new Promise((r) => setTimeout(r, 120));
  instance.unmount();
  const rows = out.longest.split("\n");
  const removed = rows.find((r) => r.includes("three"))!;
  const added = rows.find((r) => r.includes("THREE"))!;
  const context = rows.find((r) => r.includes("four"))!;
  assert.ok(removed.includes("48;5;52"), "the removed line is on the dark red entry");
  assert.ok(added.includes("48;5;22"), "the added line is on the dark green entry");
  assert.ok(!context.includes("48;5;") && !context.includes("48;2;"), "an unchanged line has no tint");
  assert.ok(!out.longest.includes("48;2;"), "and nothing is drawn in truecolor");
});
