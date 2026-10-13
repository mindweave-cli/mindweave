/**
 * frameHold.test.ts — one in-between frame is kept off the screen, and never lost.
 *
 * Opening a row draws it once with the view placed for the old height and again, a frame
 * later, correctly. The first must not be seen; the second must be; and if there is no
 * second, the first must still arrive.
 *
 * The strings differ in every cell on purpose: the painter writes only the cells that
 * changed, so two frames that share letters would not show up whole in the bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { framebufferStdout, type OutputStream } from "./writer.js";
import { framesHeld, holdFrames, releaseFrames } from "./frameHold.js";

class FakeStdout extends EventEmitter implements OutputStream {
  columns = 40;
  rows = 6;
  writes: string[] = [];
  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (out: FakeStdout) => out.writes.join("");

test("a held frame is not painted, and the frame after it is", async () => {
  const out = new FakeStdout();
  const w = framebufferStdout(out);
  w.write("alphaalpha\n");
  const before = out.writes.length;
  assert.ok(before >= 1, "an ordinary frame is painted at once");

  holdFrames();
  assert.equal(framesHeld(), true);
  w.write("WRONGWRONG\n");
  assert.equal(out.writes.length, before, "the in-between frame never reaches the screen");

  releaseFrames();
  assert.equal(framesHeld(), false);
  w.write("RIGHTRIGHT\n");
  assert.match(text(out), /RIGHTRIGHT/);
  await sleep(160);
  assert.doesNotMatch(text(out), /WRONGWRONG/, "and the dropped one does not turn up later either");
});

test("with no frame after the release, the held one is painted rather than lost", async () => {
  const out = new FakeStdout();
  const w = framebufferStdout(out);
  w.write("basebase\n");
  holdFrames();
  w.write("ONLYONLY\n");
  assert.doesNotMatch(text(out), /ONLYONLY/);
  releaseFrames();
  await sleep(600);
  assert.match(text(out), /ONLYONLY/, "a frame can be delayed, never lost");
});

test("a hold that is never released ends by itself and paints what it kept", async () => {
  const out = new FakeStdout();
  const w = framebufferStdout(out);
  w.write("basebase\n");
  holdFrames();
  w.write("KEPTKEPT\n");
  await sleep(700);
  assert.equal(framesHeld(), false, "it cannot freeze the screen");
  assert.match(text(out), /KEPTKEPT/);
});

test("control sequences pass straight through a hold", () => {
  const out = new FakeStdout();
  const w = framebufferStdout(out);
  holdFrames();
  const before = out.writes.length;
  w.write("\u001b[?25l"); // hide the cursor: not a frame
  assert.equal(out.writes.length, before + 1, "only frames are held");
  releaseFrames();
});
