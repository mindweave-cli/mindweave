/**
 * shuttle.probe.test.tsx — the loom shuttle beside the name.
 *
 * Two things have to hold at once and they pull against each other: it must look like
 * something travelling, and it must not cost anything. Smoothness here comes from
 * HALF CELLS rather than from a faster clock — box drawing gives four states for a
 * horizontal run, so the shuttle can sit at twice as many positions as there are
 * columns. Turning the timer up instead would buy a worse-looking animation at a higher
 * price.
 *
 * The cost half is asserted too, because it is the failure that would not look like a
 * failure: an animation that keeps ticking while idle re-renders forever for nothing,
 * and shows up as the whole tool feeling slightly slow rather than as anything visibly
 * wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

// Before Ink: chalk fixes colour support at import time from the real process.stdout.
process.env.FORCE_COLOR = "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render, Box } = await import("ink");
const { Banner } = await import("./App.js");

class FakeStdout extends EventEmitter {
  columns = 90;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true as const;
  setRawMode() { return this; }
  ref() { return this; }
  unref() { return this; }
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
  read() { return null; }
}

/** The banner's title row, escapes stripped, sampled at each of `atMs`. */
async function rows(busy: boolean, windowMs: number): Promise<string[]> {
  const stdout = new FakeStdout();
  const instance = render(
    <Box flexDirection="column">
      <Banner width={90} mode="lightning" busy={busy} />
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      interactive: true,
      debug: true,
    },
  );
  // Collect DISTINCT banner rows over a window rather than sampling at fixed instants.
  // A fixed sample encodes the speed of the machine: too early and the row is empty,
  // which quietly satisfies "the frames are identical" and "the row fits the width".
  // Those are the assertions that most need a real frame to mean anything.
  const seen: string[] = [];
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    for (const frame of stdout.frames.splice(0)) {
      const row =
        frame
          .replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g"), "")
          .split(/\r?\n/)
          .find((r) => r.includes("Mindweave")) ?? "";
      if (row && row !== seen[seen.length - 1]) seen.push(row);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  instance.unmount();
  assert.ok(seen.length > 0, "no banner rendered at all, so nothing below tests anything");
  return seen;
}

test("the shuttle sits AFTER the name", async () => {
  const [row] = await rows(true, 300);
  const name = row!.indexOf("Mindweave");
  const track = row!.search(/[─━╾╼]/);
  assert.ok(name >= 0, "the name did not render");
  assert.ok(track > name, `the track landed at ${track}, before the name at ${name}`);
});

test("idle is a still track and never moves", async () => {
  // Also the cost check: identical frames over a second means no timer is running.
  // An animation that ticks while nothing is happening is the expensive kind of bug,
  // because it looks like general sluggishness rather than like itself.
  const still = await rows(false, 1000);
  const [a] = still;
  assert.match(a!, /─{6}/, "idle should be a plain light track");
  // One distinct row across a full second is what "no timer is running" looks like.
  assert.equal(new Set(still).size, 1, `the idle banner changed on its own: ${JSON.stringify(still)}`);
});

test("working, it actually travels", async () => {
  const seen = await rows(true, 600);
  const tracks = seen.map((r) => r.match(/[─━╾╼]{6}/)?.[0] ?? "");
  assert.ok(tracks.every(Boolean), `no track found in ${JSON.stringify(seen)}`);
  assert.ok(new Set(tracks).size > 2, `the shuttle barely moved: ${JSON.stringify(tracks)}`);
});

test("it moves in HALF cells, which is what makes it smooth", async () => {
  // A shuttle that only ever lands on whole columns hops. The half-heavy glyphs are the
  // in-between positions, and their absence would mean the animation is half as smooth
  // as it looks in the sketch.
  const seen = await rows(true, 600);
  assert.ok(
    seen.some((r) => /[╾╼]/.test(r)),
    `never landed on a half cell: ${JSON.stringify(seen.map((r) => r.match(/[─━╾╼]{6}/)?.[0]))}`,
  );
});

test("the track never pushes the header past its width", async () => {
  // The shuttle takes columns from the gap between the name and the status text. If that
  // arithmetic is wrong the row wraps, and a wrapped banner costs a chat row on every
  // frame.
  for (const width of [60, 90, 200]) {
    const stdout = new FakeStdout();
    stdout.columns = width;
    const instance = render(<Banner width={width} mode="lightning" busy />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      interactive: true,
      debug: true,
    });
    await new Promise((r) => setTimeout(r, 80));
    const frame = (stdout.frames.at(-1) ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    instance.unmount();
    const title = frame.split(/\r?\n/).find((r) => r.includes("Mindweave")) ?? "";
    assert.ok(title.length <= width, `at ${width} columns the title row ran to ${title.length}`);
  }
});

test("idle starts no timer at all", async () => {
  // The behavioural test above cannot see this. Idle renders a static track whether or
  // not a timer is ticking behind it, so a clock left running would produce identical
  // frames and pass — while re-rendering fourteen times a second forever. Checked at the
  // source instead, which is the only place the difference exists.
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const shuttle = app.slice(app.indexOf("function Shuttle("), app.indexOf("export function Banner("));
  assert.ok(shuttle.length > 0, "the Shuttle component moved or was renamed");
  const effect = shuttle.slice(shuttle.indexOf("useEffect("), shuttle.indexOf("setInterval("));
  assert.match(effect, /if \(!busy\) return;/, "the shuttle's timer is not gated on busy");
});
