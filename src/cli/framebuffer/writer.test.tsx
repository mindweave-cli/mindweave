/**
 * writer.test.tsx — real Ink output through the framebuffer, end to end.
 *
 * `paint.test.ts` proves the diff is correct for grids built by hand. This proves it
 * against what INK ACTUALLY EMITS, which is the part no amount of unit testing can
 * stand in for: real chalk colour codes, real wrapping, real erase prefixes, real
 * frame-to-frame churn.
 *
 * The shape of every test is the same comparison, and it is the only one that
 * matters:
 *
 *     render the component to a plain stdout           -> the screen Ink INTENDED
 *     render the same component through the framebuffer -> the screen a terminal ENDS UP WITH
 *     assert they are cell-for-cell identical
 *
 * If those ever diverge, the framebuffer is lying about the screen — which is the one
 * failure mode that would make it worse than the full rewrite it replaces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import { Box, Text, render } from "ink";
import { Screen } from "./screen.js";
import { parseFrame } from "./parse.js";
import { framebufferStdout, setFramebufferEnabled, requestFullRepaint, type OutputStream } from "./writer.js";

const W = 50;
const H = 12;

/** Collects everything written, and reports a fixed size. */
class FakeStdout extends EventEmitter implements OutputStream {
  columns = W;
  rows = H;
  writes: string[] = [];
  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }
}

function fakeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  return stdin;
}

/** Every cell, as a comparable snapshot. */
function snapshot(s: Screen): string {
  const parts: string[] = [];
  for (let i = 0; i < s.chars.length; i++) {
    parts.push(`${s.chars[i]}/${s.fg[i]}/${s.bg[i]}/${s.attrs[i]}`);
  }
  return parts.join(" ");
}

const ERASE_PREFIX = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/;

/**
 * Drive `node` through `steps` renders and return both screens: the one Ink meant to
 * draw, and the one a terminal fed by the framebuffer would be showing.
 */
async function bothScreens(makeNode: (tick: number) => React.ReactElement, steps: number) {
  // --- What Ink intended ---------------------------------------------------
  // Each of Ink's writes is a complete frame (after its erase prefix), so the LAST
  // one is what it wanted on screen.
  const plain = new FakeStdout();
  for (let t = 0; t < steps; t++) {
    const app = render(makeNode(t), {
      stdout: plain as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    });
    app.unmount();
  }
  const intended = new Screen(W, H);
  const frames = plain.writes.filter((w) => w.replace(ERASE_PREFIX, "").trim() !== "");
  parseFrame(intended, (frames[frames.length - 1] ?? "").replace(ERASE_PREFIX, ""));

  // --- What the terminal ends up with --------------------------------------
  // One long-lived framebuffer across every step, exactly as the real app runs, with
  // a screen that accumulates each emitted escape the way a terminal would.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const terminal = new Screen(W, H);
  for (let t = 0; t < steps; t++) {
    const before = real.writes.length;
    const app = render(makeNode(t), {
      stdout: fb as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    });
    app.unmount();
    for (const w of real.writes.slice(before)) parseFrame(terminal, w);
  }

  return { intended, terminal, emitted: real.writes };
}

test("a single frame through the framebuffer matches what Ink drew", async () => {
  const { intended, terminal } = await bothScreens(
    () => (
      <Box flexDirection="column">
        <Text>hello world</Text>
        <Text color="green">a green line</Text>
      </Box>
    ),
    1,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("styled and nested output matches — colours, bold, dim, borders", async () => {
  const { intended, terminal } = await bothScreens(
    () => (
      <Box flexDirection="column" borderStyle="round" width={40}>
        <Text bold color="cyan">
          a bold cyan heading
        </Text>
        <Text dimColor>a dim subtitle</Text>
        <Box>
          <Text color="red">red</Text>
          <Text> / </Text>
          <Text backgroundColor="blue">on blue</Text>
        </Box>
      </Box>
    ),
    1,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("many successive frames leave the terminal exactly where Ink expects", async () => {
  // The accumulating case, and the one that catches a diff which is right once and
  // drifts afterwards: each frame is diffed against the previous, so an error in any
  // of them persists into every later screen.
  const { intended, terminal } = await bothScreens(
    (t) => (
      <Box flexDirection="column">
        <Text>counter: {t}</Text>
        <Text color={t % 2 === 0 ? "green" : "red"}>alternating colour</Text>
        <Text>{"x".repeat(t + 1)}</Text>
        <Text>a line that never changes at all</Text>
      </Box>
    ),
    8,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("content that SHRINKS leaves no ghosts behind", async () => {
  // The classic diff bug: text disappears and the old characters are still on screen
  // because nothing wrote over them.
  const { intended, terminal } = await bothScreens(
    (t) => (
      <Box flexDirection="column">
        <Text>{t === 0 ? "a much longer line of text than the next one" : "short"}</Text>
        <Text>{t === 0 ? "second line present" : ""}</Text>
      </Box>
    ),
    2,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("wide characters through the real pipeline stay aligned", async () => {
  const { intended, terminal } = await bothScreens(
    (t) => (
      <Box flexDirection="column">
        <Text>{t === 0 ? "plain ascii row" : "世界 and 🔥 row"}</Text>
        <Text>following row must not shift</Text>
      </Box>
    ),
    2,
  );
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("an unchanged re-render puts ZERO bytes on the terminal", async () => {
  // The property the whole exercise exists for. Ink re-renders on every state change
  // whether or not anything is different; if that still costs a full screen write,
  // nothing has been fixed.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const node = (
    <Box flexDirection="column">
      <Text>steady</Text>
      <Text color="magenta">unchanging</Text>
    </Box>
  );

  const first = render(node, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  first.unmount();
  const afterFirst = real.writes.length;

  const second = render(node, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  second.unmount();

  // Ink writes a bare newline on `unmount()`, which is not a frame and is correctly
  // passed straight through. The real app mounts once and never unmounts between
  // renders, so it is an artifact of driving this test with two mounts — excluded
  // rather than papered over, because the claim being made is about FRAME output.
  const added = real.writes.slice(afterFirst).join("").replace(/\n/g, "");
  assert.equal(added, "", `an identical frame wrote ${added.length} bytes: ${JSON.stringify(added)}`);
});

test("requestFullRepaint redraws an identical frame in full — the scroll de-sync heal", async () => {
  // The banner-on-scroll fix. A scroll can move a row out from under the model, leaving a
  // stale cell the diff would skip forever because "nothing changed" (the pinned banner is
  // the one row a scroll does not otherwise redraw). requestFullRepaint forces the next
  // frame to write every cell, so that stale cell is corrected. Proven as the inverse of
  // the ZERO-bytes property: the SAME frame that would normally cost nothing now repaints.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const node = (
    <Box flexDirection="column">
      <Text>banner</Text>
      <Text color="cyan">line</Text>
    </Box>
  );
  render(node, { stdout: fb as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true }).unmount();
  const afterFirst = real.writes.length;

  requestFullRepaint();
  render(node, { stdout: fb as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true }).unmount();

  const added = real.writes.slice(afterFirst).join("").replace(/\n/g, "");
  assert.ok(/banner/.test(added), `after requestFullRepaint an identical frame must redraw the banner, wrote: ${JSON.stringify(added.slice(0, 80))}`);
});

test("one changed character costs a fraction of what Ink would have written", async () => {
  // The measurement that says whether this is worth having, expressed as a test so it
  // cannot silently regress.
  const rows = Array.from({ length: 10 }, (_, i) => `row ${i}: some reasonably long content here`);
  const real = new FakeStdout();
  const fb = framebufferStdout(real);

  let inBytes = 0;
  let outBytes = 0;
  const counting = framebufferStdout(real, (s) => {
    inBytes = s.inBytes;
    outBytes = s.outBytes;
  });
  void fb;

  for (const tick of [0, 1]) {
    const app = render(
      <Box flexDirection="column">
        {rows.map((r, i) => (
          <Text key={i}>{i === 4 && tick === 1 ? "row 4: CHANGED content here          " : r}</Text>
        ))}
      </Box>,
      { stdout: counting as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true },
    );
    app.unmount();
  }

  assert.ok(inBytes > 300, `expected a substantial frame, got ${inBytes} bytes`);
  assert.ok(
    outBytes < inBytes / 4,
    `one changed row should cost far less than the frame: ${outBytes} out of ${inBytes} bytes`,
  );
});

test("a resize repaints in full rather than diffing against a re-wrapped screen", async () => {
  const real = new FakeStdout();
  const fb = framebufferStdout(real);

  function Harness({ width }: { width: number }) {
    return (
      <Box flexDirection="column" width={width}>
        <Text wrap="wrap">a line long enough that a narrower terminal will wrap it onto another row</Text>
      </Box>
    );
  }

  const first = render(<Harness width={W} />, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  first.unmount();

  // The terminal narrows. Every recorded cell is now wrong.
  real.columns = 30;
  const beforeResize = real.writes.length;
  const second = render(<Harness width={30} />, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  second.unmount();

  const after = real.writes.slice(beforeResize).join("");
  assert.ok(after.length > 0, "a resize must repaint, not assume the old grid still applies");

  // And the result must still be what Ink intended at the new width.
  const plain = new FakeStdout();
  plain.columns = 30;
  const ref = render(<Harness width={30} />, {
    stdout: plain as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  ref.unmount();
  const intended = new Screen(30, H);
  const lastFrame = plain.writes.filter((w) => w.replace(ERASE_PREFIX, "").trim() !== "").pop() ?? "";
  parseFrame(intended, lastFrame.replace(ERASE_PREFIX, ""));

  const terminal = new Screen(30, H);
  for (const w of real.writes.slice(beforeResize)) parseFrame(terminal, w);
  assert.equal(snapshot(terminal), snapshot(intended));
});

test("EVERY property of the real stream survives the wrapper, not just the ones we thought of", () => {
  // THE REGRESSION THIS EXISTS FOR. The first version of `framebufferStdout` returned
  // a hand-written object listing the members Ink appeared to need. It did not have
  // `isTTY`, which Ink reads in five places to decide whether it is driving a terminal
  // at all — so Ink took its non-interactive path and the app started to a BLANK
  // SCREEN, with no error anywhere.
  //
  // Every test above passed, because they all pass a fake stdout that has no `isTTY`
  // either: both sides agreed on the wrong thing. So this asserts the general
  // property rather than that one field — anything on the real stream must still be
  // reachable through the wrapper, including things nobody has thought of yet.
  const real = new FakeStdout() as FakeStdout & Record<string, unknown>;
  real.isTTY = true;
  real.someFutureField = 42;
  real.someFutureMethod = function () {
    return this === real;
  };

  const fb = framebufferStdout(real) as typeof real;
  assert.equal(fb.isTTY, true, "isTTY must survive — its absence is what blanked the screen");
  assert.equal(fb.columns, W);
  assert.equal(fb.rows, H);
  assert.equal(fb.someFutureField, 42);
  // Methods must be bound to the REAL stream: a stream's methods reach into its own
  // internal state, and `this` pointing at the wrapper would send them looking on the
  // wrong object.
  assert.equal((fb.someFutureMethod as () => boolean)(), true, "methods must be bound to the real stream");
  // And a live change on the real stream — a terminal resize — must be visible.
  real.columns = 81;
  assert.equal(fb.columns, 81, "the wrapper must not snapshot values");
});

test("non-frame control sequences pass through untouched", async () => {
  // Entering the alternate screen, hiding the cursor, synchronized-update markers —
  // swallowing any of these would break the app in ways the diff cannot express.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const controls = ["\x1b[?1049h", "\x1b[?25l", "\x1b[?2026h", "\x1b[?2026l"];
  for (const c of controls) fb.write(c);
  assert.deepEqual(real.writes, controls);
});

test("a dynamic component driven by state matches Ink throughout", async () => {
  // Closest thing here to the real app: state changing over time inside one mounted
  // tree, rather than a fresh render per step.
  const real = new FakeStdout();
  const fb = framebufferStdout(real);
  const terminal = new Screen(W, H);
  let resolveDone: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const STEPS = 6;

  function Harness() {
    const [n, setN] = useState(0);
    useEffect(() => {
      if (n < STEPS) setN(n + 1);
      else resolveDone();
    }, [n]);
    return (
      <Box flexDirection="column">
        <Text color="yellow">tick {n}</Text>
        <Text>{"=".repeat(n + 1)}</Text>
        <Text dimColor>stable footer</Text>
      </Box>
    );
  }

  const app = render(<Harness />, {
    stdout: fb as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  await done;
  app.unmount();
  for (const w of real.writes) parseFrame(terminal, w);

  const plain = new FakeStdout();
  const ref = render(
    <Box flexDirection="column">
      <Text color="yellow">tick {STEPS}</Text>
      <Text>{"=".repeat(STEPS + 1)}</Text>
      <Text dimColor>stable footer</Text>
    </Box>,
    { stdout: plain as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true },
  );
  ref.unmount();
  const intended = new Screen(W, H);
  const lastFrame = plain.writes.filter((w) => w.replace(ERASE_PREFIX, "").trim() !== "").pop() ?? "";
  parseFrame(intended, lastFrame.replace(ERASE_PREFIX, ""));

  assert.equal(snapshot(terminal), snapshot(intended));
});

// ── standing down for the inline shell ───────────────────────────────────────
//
// The inline shell does not own the screen: its finished output IS the terminal's
// scrollback, printed once and scrolled by the terminal. Every single thing this
// renderer does is wrong there — it strips the erase prefix Ink uses to rewrite its live
// region, diffs against a grid the height of the window when the real content is taller
// and moving, and parks the cursor absolutely when the cursor belongs to Ink.

test("stood down, every byte Ink writes reaches the terminal untouched", async () => {
  const { setFramebufferEnabled, framebufferEnabled } = await import("./writer.js");
  const out = new FakeStdout();
  const fb = framebufferStdout(out as unknown as OutputStream);
  setFramebufferEnabled(false);
  try {
    // An Ink frame, erase prefix and all. Diffed, the prefix is stripped and the content
    // becomes cursor moves; passed through, it must arrive exactly as written.
    const frame = "\x1b[2K\x1b[1A\x1b[2K\x1b[Ghello\nworld";
    out.writes.length = 0;
    fb.write(frame);
    // Byte for byte. Ink appends its own cursor move and show when a component has asked
    // for a position (see PromptInput), and that suffix is how the caret exists at all in
    // the inline shell — nothing here may add to a frame or take anything from it.
    assert.equal(out.writes.join(""), frame, "the framebuffer rewrote a frame it was told to leave alone");
    assert.equal(framebufferEnabled(), false);
  } finally {
    setFramebufferEnabled(true);
  }
});

test("switching back forgets the screen instead of diffing against a fiction", async () => {
  // While it was off, the terminal was scrolling and printing on its own. Every cell the
  // model remembers is a guess about a screen that has moved, so switching back has to
  // write everything rather than trust a diff against what it last believed.
  //
  // That full write now happens AT the switch rather than being deferred to whatever
  // frame came next, because nothing was guaranteed to come next: the shell being
  // entered was rendered before the effect that moves the terminal, so Ink had already
  // written it and would not write it again. The alternate screen was left blank.
  const { setFramebufferEnabled } = await import("./writer.js");
  const out = new FakeStdout();
  const fb = framebufferStdout(out as unknown as OutputStream);
  fb.write("\x1b[Gsteady state");
  setFramebufferEnabled(false);
  fb.write("\x1b[Gscrollback happened here");
  out.writes.length = 0;

  setFramebufferEnabled(true);
  const repaint = out.writes.join("");
  // The LAST row addressed is what says "every row", not just the one with text on it.
  assert.match(repaint, /\x1b\[12;1H/, "the switch back did not repaint the whole screen");
  assert.match(repaint, /scrollback happened here/, "the frame written while stood down was not restored");

  // And from there the model is honest, so an ordinary diff works again. The leading `s`
  // is shared with what was on screen, so a correct diff writes the rest and skips it —
  // asserting the whole word back would be asserting that the diffing does not work.
  out.writes.length = 0;
  fb.write("\x1b[Gsteady state");
  assert.match(out.writes.join(""), /teady state/, "the first frame back was diffed away as unchanged");
});

test("the cursor parker stands down too", async () => {
  // It writes to the terminal directly rather than through the diffing path, so the
  // check has to exist in both places. An absolute cursor move in the inline shell drops
  // the caret somewhere in the scrollback.
  const { setFramebufferEnabled } = await import("./writer.js");
  const { declareCaret, onCaretMoved } = await import("../caretPark.js");
  const out = new FakeStdout();
  framebufferStdout(out as unknown as OutputStream);
  setFramebufferEnabled(false);
  try {
    out.writes.length = 0;
    declareCaret({ ref: { current: null }, column: 4 });
    await new Promise((r) => setTimeout(r, 40)); // Ink repaints on a timer: one event-loop tick was sometimes too soon on a loaded runner
    assert.deepEqual(out.writes, [], "the caret was parked into a terminal the app does not own");
  } finally {
    declareCaret(null);
    onCaretMoved(null);
    setFramebufferEnabled(true);
  }
});


// ── a resize must never blank the screen ────────────────────────────────────
//
// Ink clears the screen itself whenever the terminal gets NARROWER (`resized()` in
// ink.js), to stop its own re-renders overlapping. It writes that erase on its own and
// unsynchronized, then lays the new frame out. Forwarded, it does exactly what it says:
// the screen goes blank and stays blank for as long as the relayout takes, and dragging
// an edge is one of those per resize event.
//
// It is not needed while the framebuffer owns the screen. A resize invalidates the model,
// so the next frame writes every cell, and it goes out inside synchronized-update
// markers — the terminal holds the old picture until the whole new one has arrived and
// then swaps in one step. The old frame stays readable the entire time, which is
// strictly better than an erase.

/** A stdout whose dimensions can change, and which emits `resize` like a real one. */
class ResizableStdout extends EventEmitter implements OutputStream {
  columns = 80;
  rows = 24;
  isTTY = true as const;
  writes: string[] = [];
  write(data: string, callback?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    callback?.(null);
    return true;
  }
  resizeTo(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

const SYNC_OPEN = "\x1b[?2026h";
/** Erase-line, and the cursor moves that walk between rows being erased. */
const ERASE_LINE = /\x1b\[2K/g;

function ResizeFrame({ width }: { width: number }): React.ReactElement {
  return (
    <Box flexDirection="column" height={20}>
      {Array.from({ length: 18 }, (_, i) => (
        <Text key={i}>{`row ${i} ${"x".repeat(Math.max(1, width - 12))}`}</Text>
      ))}
      <Text>FOOTER</Text>
    </Box>
  );
}

/** Everything written while shrinking the terminal from 80 columns to 50. */
async function writesWhileNarrowing(): Promise<string[]> {
  setFramebufferEnabled(true);
  const stdout = new ResizableStdout();
  const instance = render(<ResizeFrame width={80} />, {
    stdout: framebufferStdout(stdout) as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await new Promise((r) => setTimeout(r, 120));
  stdout.writes.length = 0;
  stdout.resizeTo(50, 24);
  instance.rerender(<ResizeFrame width={50} />);
  await new Promise((r) => setTimeout(r, 120));
  instance.unmount();
  return stdout.writes;
}

test("narrowing the terminal never sends a bare erase", async () => {
  const writes = await writesWhileNarrowing();
  const erased = writes.reduce((n, w) => n + (w.match(ERASE_LINE) ?? []).length, 0);
  assert.equal(erased, 0, `${erased} rows were erased on the wire — the screen blanks for the length of the relayout`);
});

test("everything painted across a resize is wrapped for an atomic swap", async () => {
  // Unsynchronized, a repaint is visible as it lands, cell by cell. Wrapped, the terminal
  // holds the old picture until the whole new frame has arrived.
  const drawing = (await writesWhileNarrowing()).filter(
    (w) => w.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim().length > 0,
  );
  assert.ok(drawing.length > 0, "nothing was repainted at all, so nothing here means anything");
  for (const w of drawing) {
    assert.ok(w.startsWith(SYNC_OPEN), `a frame went out unsynchronized: ${JSON.stringify(w.slice(0, 40))}`);
  }
});

test("the new size actually reaches the screen — the erase was dropped, not the frame", async () => {
  // The failure this guards: swallowing more than intended and leaving the terminal
  // showing the pre-resize picture forever.
  const joined = (await writesWhileNarrowing()).join("");
  assert.match(joined, /row \d+/, "no transcript rows were repainted after the resize");
});

test("stood down, Ink's erase is passed through untouched", async () => {
  // The inline shell has no model of the screen and no synchronized repaint to replace
  // an erase with, so swallowing one there would leave stale rows on screen.
  setFramebufferEnabled(true);
  const stdout = new ResizableStdout();
  const wrapped = framebufferStdout(stdout);
  setFramebufferEnabled(false);
  stdout.writes.length = 0;
  const erase = "\x1b[2K\x1b[1A\x1b[2K\x1b[G";
  wrapped.write(erase);
  setFramebufferEnabled(true);
  assert.deepEqual(stdout.writes, [erase], "an erase was altered while the framebuffer was stood down");
});

// ── a full-height frame is safe BECAUSE the framebuffer replaces Ink's renderer ─────
//
// Ink's own renderer, at a frame as tall as the terminal, switches from erase-and-redraw
// to clearing the whole screen — and that desynchronises its line bookkeeping, so the
// next ordinary frame erases the wrong count and leaves old text behind. The full-screen
// frame used to hold one row back to stay under that threshold, which put a dead row at
// the very bottom edge. The framebuffer addresses cells absolutely and diffs its own
// model, so it never reaches that path — these prove a full-height frame lands the last
// row and survives a change with nothing stale left behind, so the held-back row was
// pure dead space.

test("a full-height frame puts its last row on the terminal's last row", async () => {
  setFramebufferEnabled(true);
  const stdout = new ResizableStdout();
  const instance = render(
    <Box flexDirection="column" height={stdout.rows} overflow="hidden">
      <Box flexShrink={0}><Text>TOP</Text></Box>
      <Box flexGrow={1} flexShrink={1} />
      <Box flexShrink={0}><Text>LASTROW</Text></Box>
    </Box>,
    {
      stdout: framebufferStdout(stdout) as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
    },
  );
  await new Promise((r) => setTimeout(r, 120));
  instance.unmount();

  const screen = new Screen(stdout.columns, stdout.rows);
  for (const w of stdout.writes) parseFrame(screen, w);
  const rowText = (r: number): string => {
    let t = "";
    for (let c = 0; c < stdout.columns; c++) t += String.fromCharCode(screen.chars[r * stdout.columns + c] || 32);
    return t.replace(/\s+$/, "");
  };
  assert.equal(rowText(0), "TOP", "the top row is wrong");
  assert.equal(rowText(stdout.rows - 1), "LASTROW", "the last row of the frame is not on the last row of the terminal");
});

test("a full-height frame leaves nothing stale behind when it changes", async () => {
  setFramebufferEnabled(true);
  const stdout = new ResizableStdout();
  let set!: (s: string) => void;
  function App(): React.ReactElement {
    const [msg, setMsg] = useState("BEFORE");
    useEffect(() => {
      set = setMsg;
    }, []);
    return (
      <Box flexDirection="column" height={stdout.rows} overflow="hidden">
        <Box flexShrink={0}><Text>TOP</Text></Box>
        <Box flexGrow={1} flexShrink={1} />
        <Box flexShrink={0}><Text>{msg}</Text></Box>
        <Box flexShrink={0}><Text>LASTROW</Text></Box>
      </Box>
    );
  }
  const instance = render(<App />, {
    stdout: framebufferStdout(stdout) as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await new Promise((r) => setTimeout(r, 120));
  set("AFTER");
  await new Promise((r) => setTimeout(r, 120));
  instance.unmount();

  const screen = new Screen(stdout.columns, stdout.rows);
  for (const w of stdout.writes) parseFrame(screen, w);
  let all = "";
  for (let r = 0; r < stdout.rows; r++) {
    for (let c = 0; c < stdout.columns; c++) all += String.fromCharCode(screen.chars[r * stdout.columns + c] || 32);
    all += "\n";
  }
  assert.match(all, /AFTER/, "the change never landed");
  assert.doesNotMatch(all, /BEFORE/, "stale text survived a full-height change — the clear-screen bug");
});
