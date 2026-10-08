/**
 * viewWait.probe.test.tsx — the row for a picture the model is still looking at.
 *
 * Handing an image to vision leaves a gap: the tool finished, and nothing appears for as
 * long as the model takes, which is far longer than for text. The row used to sit there
 * finished and silent through all of it.
 *
 * It now counts, and it settles:
 *
 *     ●  Viewing(shot.png)  8s          →   ●  Viewed(shot.png)
 *        ⎿  800×600 · PNG · 40 KB           ⎿  800×600 · PNG · 40 KB · looked at in 11s
 *
 * Both halves are claims about what reaches the terminal, so both are read off a frame
 * rather than off the props that produced it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink loads: chalk fixes its colour support at import time from the real
// process.stdout, not the stream it is handed.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { ToolLine } = await import("./components/ToolLine.js");

class FakeStdout extends EventEmitter {
  columns = 70;
  rows = 12;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");

/** Draw one row and return what the terminal was told to show. */
function draw(props: Record<string, unknown>): string {
  const stdout = new FakeStdout();
  const instance = render(
    <ToolLine
      name="Viewed"
      arg="shot.png"
      status="ok"
      detail={"800×600 · PNG · 40 KB"}
      columns={70}
      {...props}
    />,
    { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, interactive: false, debug: true },
  );
  const frame = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  return frame.replace(ANSI, "");
}

test("while the model is looking, the row reads Viewing and shows the wait", () => {
  const out = draw({ live: true, since: Date.now() - 8_000 });
  assert.match(out, /Viewing\(shot\.png\)/);
  assert.match(out, /\b8s\b/, `no counter in the row: ${JSON.stringify(out)}`);
});

test("once it has looked, the row reads Viewed and the counter is gone", () => {
  const out = draw({ live: false, since: Date.now() - 8_000, waited: 11 });
  assert.match(out, /Viewed\(shot\.png\)/);
  assert.ok(!/\bViewing\b/.test(out), "still counting after the wait ended");
  assert.ok(!/\b8s\b/.test(out), `the live counter outlived the wait: ${JSON.stringify(out)}`);
});

test("the total joins the end of the facts line, not a line of its own", () => {
  // A row that grew a line when it settled would change shape after the fact.
  const out = draw({ live: false, waited: 11 });
  assert.match(out, /800×600 · PNG · 40 KB · looked at in 11s/);
  const bodyRows = out.split(/\r?\n/).filter((r) => r.includes("800×600") || r.includes("looked at in"));
  assert.equal(bodyRows.length, 1, `the wait took a row of its own: ${JSON.stringify(bodyRows)}`);
});

test("an ordinary row is untouched — no counter, no total", () => {
  // Finished, so past tense: the verb follows the row's own work, not the turn's.
  const out = draw({ name: "Read", arg: "a.ts", live: true, detail: "40 lines" });
  assert.match(out, /Read\(a\.ts\)/);
  assert.ok(!/\d+s\b/.test(out), `a counter appeared on a row that never waited: ${JSON.stringify(out)}`);
  assert.ok(!/looked at in/.test(out));
});

test("the wait is only shown while the turn is live", () => {
  // A settled row with no total must not fall back to counting from `since` forever.
  const out = draw({ live: false, since: Date.now() - 30_000 });
  assert.ok(!/\b30s\b/.test(out), `a finished row was still counting: ${JSON.stringify(out)}`);
});
