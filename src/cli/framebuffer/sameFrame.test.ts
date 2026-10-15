/**
 * sameFrame.test.ts — a frame identical to the one already on screen costs nothing.
 *
 * In the full-screen layout Ink writes its frame again whenever anything re-renders, whether or not a cell
 * changed, so a screen that is standing still still sends a frame many times a second. Reading a frame is
 * most of what the renderer spends on it, and for a frame with the same text there is nothing to read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { framebufferStdout, type OutputStream } from "./writer.js";

function stream(): OutputStream & { writes: string[] } {
  const writes: string[] = [];
  return {
    columns: 30,
    rows: 4,
    writes,
    write(data: string): boolean {
      writes.push(data);
      return true;
    },
    on() {
      return undefined;
    },
  };
}

const ESC = String.fromCharCode(27);
const cells = (writes: string[]): string => writes.join("").replace(new RegExp(`${ESC}\[[0-9;?]*[A-Za-z]`, "g"), "");

function withHugeRepaintInterval(run: () => void): void {
  const before = process.env["MINDWEAVE_FB_REPAINT_MS"];
  process.env["MINDWEAVE_FB_REPAINT_MS"] = String(60 * 60 * 1000);
  try {
    run();
  } finally {
    if (before === undefined) delete process.env["MINDWEAVE_FB_REPAINT_MS"];
    else process.env["MINDWEAVE_FB_REPAINT_MS"] = before;
  }
}

test("the same frame twice puts no cells on the terminal the second time, and is not read", () => {
  withHugeRepaintInterval(() => {
    const real = stream();
    const seen: boolean[] = [];
    const out = framebufferStdout(real, (f) => seen.push(f.unchanged));
    out.write("alpha\nbeta");
    assert.match(cells(real.writes), /alpha/);
    const sent = real.writes.length;
    out.write("alpha\nbeta");
    out.write("alpha\nbeta");
    assert.equal(cells(real.writes.slice(sent)), "", "an unchanged frame was written again");
    assert.deepEqual(seen, [false, true, true], "a repeated frame was parsed and diffed again");
  });
});

test("a changed frame after unchanged ones paints only what changed", () => {
  withHugeRepaintInterval(() => {
    const real = stream();
    const out = framebufferStdout(real);
    out.write("alpha\nbeta");
    out.write("alpha\nbeta");
    const sent = real.writes.length;
    out.write("alpha\nbeto");
    const painted = cells(real.writes.slice(sent));
    assert.ok(painted.includes("o"), "the change was not drawn");
    assert.ok(!painted.includes("alpha"), "a row that did not change was drawn again");
  });
});

test("going back to an earlier frame is still painted", () => {
  // A frame equal to the one BEFORE the last is not "the same": only the previous body counts.
  withHugeRepaintInterval(() => {
    const real = stream();
    const out = framebufferStdout(real);
    out.write("alpha\nbeta");
    out.write("alpha\nbeto");
    const sent = real.writes.length;
    out.write("alpha\nbeta");
    assert.ok(cells(real.writes.slice(sent)).includes("a"), "the earlier picture was taken for the current one");
  });
});
