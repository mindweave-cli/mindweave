/**
 * quietConsole.test.ts — while the UI owns the terminal, nothing else writes to it.
 *
 * The failure this prevents is not a log line appearing where it should not. It is one
 * character stranded in the middle of an unrelated row: printing at the bottom of the
 * screen scrolls it, every row moves up one, and the renderer's model now describes a
 * screen that no longer exists. The stray is whatever was long enough to survive being
 * partly overwritten by the shorter line that took its place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { silenceConsole } from "./quietConsole.js";

/** A stand-in console that records instead of printing. */
function recorder() {
  const seen: string[] = [];
  const write = (name: string) => (msg?: unknown) => seen.push(`${name}:${String(msg)}`);
  return {
    seen,
    log: write("log"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    debug: write("debug"),
  };
}

test("a silenced console prints nothing", () => {
  const fake = recorder();
  silenceConsole(fake);
  fake.log("a dependency warning");
  fake.warn("deprecated");
  fake.error("boom");
  fake.info("fyi");
  fake.debug("verbose");
  assert.deepEqual(fake.seen, []);
});

test("restoring puts every method back", () => {
  const fake = recorder();
  const restore = silenceConsole(fake);
  fake.log("swallowed");
  restore();
  fake.log("printed");
  fake.error("printed too");
  assert.deepEqual(fake.seen, ["log:printed", "error:printed too"]);
});

test("restoring twice does not re-install the no-ops", () => {
  // `/update` restores after unmount and the exit path can restore again. A second call
  // that swapped the saved functions back for the stubs would silence the console at the
  // exact moment there is a handover message to print.
  const fake = recorder();
  const restore = silenceConsole(fake);
  restore();
  restore();
  fake.log("printed");
  assert.deepEqual(fake.seen, ["log:printed"]);
});

test("a console missing a method is left alone rather than given one", () => {
  const partial: { log?: unknown; warn?: unknown } = { log: () => {} };
  const restore = silenceConsole(partial);
  assert.equal("warn" in partial, false, "silencing invented a method that was not there");
  restore();
});

test("Ink is not asked to route console output into the frame stream", async () => {
  // Source-enforced: the damage is invisible from a test, because it is a difference
  // between the model of the screen and the screen. `patchConsole` writes log output
  // through the same stdout Ink renders into, so the framebuffer's parser reads it as a
  // frame and stamps the text into the model — where no later diff can find it, since the
  // model and the screen agree about the cell. Off, it reaches the terminal directly and
  // the next full repaint takes it away.
  const source = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(source, /patchConsole:\s*false/, "console output is being routed into the frame stream");
  assert.match(source, /silenceConsole\(\)/, "the console is not silenced while the UI is mounted");
});
