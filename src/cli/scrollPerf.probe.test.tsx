/**
 * scrollPerf.probe.test.tsx — what one wheel notch costs, end to end.
 *
 * Companion to `typingPerf.probe.test.tsx`, and it exists because scrolling and typing
 * are NOT the same path even though they share a renderer:
 *
 *  - A keystroke changes state owned by `PromptInput`, so React re-renders that subtree
 *    and nothing else. The transcript is untouched.
 *  - A wheel notch changes `scrollUp`, which lives in `App`. That moves the virtual
 *    window, so the transcript slice is rebuilt and re-laid-out every frame.
 *
 * So scrolling pays the frame-rate cap (same as typing) PLUS per-frame work that typing
 * never does. This measures both, which is the only way to tell whether a remaining
 * complaint about scrolling is the timer or the work — the distinction that took three
 * attempts to find for typing.
 *
 * The same two traps apply as in the typing probe: the fake stdout needs `isTTY` or Ink
 * renders once and never again, and a probe that measures nothing reports a beautiful
 * zero. Both are guarded below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import { Box, render } from "ink";
import { BlockView } from "./components/BlockView.js";
import { virtualWindow } from "./virtualWindow.js";
import { MAX_FPS } from "./frameRate.js";
import type { Block } from "./transcript.js";

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  // See typingPerf.probe.test.tsx — without this Ink takes its non-interactive path.
  isTTY = true;
  writes = 0;
  write(): boolean {
    this.writes++;
    return true;
  }
}

const SAMPLE = `Here's what I found in the codebase.

**The cause** — the reducer dispatches once per key, which is correct, but the
transcript below it re-renders in full each time.

- \`src/cli/App.tsx\` holds the block list
- \`src/cli/components/BlockView.tsx\` renders each one

| File | Lines | Role |
|------|-------|------|
| App.tsx | 2400 | frame + state |

\`\`\`ts
export function reduce(s: State, a: Action): State {
  return { ...s, value: a.text };
}
\`\`\`
`;

/** Rows one SAMPLE block occupies at width 100. Only has to be plausible: this probe
 *  measures render cost, not placement — `virtualRender.probe.test.tsx` is what proves
 *  the spacers are exact. */
const BLOCK_ROWS = 22;
const VIEWPORT_ROWS = 30;

function blocks(n: number): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < n; i++) out.push({ id: i, kind: "assistant", done: true, text: SAMPLE });
  return out;
}

/**
 * App's transcript, in the two shapes worth comparing: `virtual` renders only the
 * window with exact spacers standing in for the rest (what the app does), `full`
 * renders every block (what it did before virtualization).
 */
function Transcript({
  list,
  shift,
  virtual,
  onReady,
}: {
  list: Block[];
  shift: number;
  virtual: boolean;
  onReady: (set: (n: number) => void) => void;
}) {
  const [scroll, setScroll] = useState(shift);
  useEffect(() => {
    onReady(setScroll);
  }, [onReady]);

  const heights = list.map(() => BLOCK_ROWS);
  const win = virtual
    ? virtualWindow(heights, scroll, VIEWPORT_ROWS)
    : { start: 0, end: list.length, padTop: 0, padBottom: 0 };

  return (
    <Box flexDirection="column" height={40} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Box flexDirection="column" flexShrink={0} marginTop={-scroll}>
          {win.padTop > 0 ? <Box flexShrink={0} height={win.padTop} /> : null}
          {list.slice(win.start, win.end).map((b) => (
            <Box key={b.id} flexShrink={0} flexDirection="column">
              <BlockView block={b} columns={100} />
            </Box>
          ))}
          {win.padBottom > 0 ? <Box flexShrink={0} height={win.padBottom} /> : null}
        </Box>
      </Box>
    </Box>
  );
}

/** Median wheel-notch latency: scroll state changes, frame reaches stdout. */
async function scrollMs(blockCount: number, opts: { maxFps: number; virtual: boolean }): Promise<number> {
  const stdout = new FakeStdout();
  const list = blocks(blockCount);
  const scroller: { set: ((n: number) => void) | null } = { set: null };

  const instance = render(
    <Transcript
      list={list}
      shift={0}
      virtual={opts.virtual}
      onReady={(s) => {
        scroller.set = s;
      }}
    />,
    { stdout: stdout as never, patchConsole: false, interactive: true, maxFps: opts.maxFps },
  );

  // Let the mount settle so `onReady` has run and the first frames are past.
  await new Promise((r) => setTimeout(r, 50));
  const setScroll = scroller.set;
  if (!setScroll) throw new Error("harness never mounted: no scroll setter");

  const total = blockCount * BLOCK_ROWS;
  const samples: number[] = [];
  for (let i = 1; i <= 40; i++) {
    // A wheel notch is 3 lines. Wrap so a short list keeps moving rather than
    // pinning at the end, where nothing re-renders and the measurement is a lie.
    const next = total > VIEWPORT_ROWS ? (i * 3) % (total - VIEWPORT_ROWS) : 0;
    const seen = stdout.writes;
    const t0 = performance.now();
    setScroll(next);
    // A step that lands on a frame identical to the last one writes nothing (Ink skips an unchanged frame),
    // and waiting for a write that is never coming hung this probe for ever on Linux. Give each step a
    // deadline; a step with no frame is not a latency sample.
    const deadline = t0 + 1000;
    while (stdout.writes === seen && performance.now() < deadline) await new Promise((r) => setTimeout(r, 0));
    if (stdout.writes === seen) continue;
    samples.push(performance.now() - t0);
  }
  instance.unmount();
  if (samples.length === 0) throw new Error("no frames rendered");
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

test("probe: the frame cap sets scroll latency too", async () => {
  // LITERAL 30 and 120, not `MAX_FPS`. Written against MAX_FPS this compared the
  // shipped value with itself the moment someone lowered it, and passed on noise
  // (44.4ms vs 41.0ms) — a test that cannot fail. The claim here is about Ink's
  // behaviour; the shipped value is guarded in `typingPerf.probe.test.tsx`.
  const slow = await scrollMs(100, { maxFps: 30, virtual: true });
  const fast = await scrollMs(100, { maxFps: 120, virtual: true });
  console.log(`\nscroll, 100 blocks: maxFps=30 ${slow.toFixed(2)}ms, maxFps=120 ${fast.toFixed(2)}ms\n`);
  // A real margin, so run-to-run noise cannot satisfy it: a 34ms window against an
  // 8ms one should be most of the latency, not a few percent of it.
  assert.ok(
    fast < slow * 0.7,
    `raising maxFps must clearly lower scroll latency: ${fast.toFixed(2)}ms vs ${slow.toFixed(2)}ms`,
  );
});

test("virtualization keeps scroll cost flat as the transcript grows", async () => {
  const small = await scrollMs(30, { maxFps: MAX_FPS, virtual: true });
  const large = await scrollMs(300, { maxFps: MAX_FPS, virtual: true });
  console.log(`\nvirtualized scroll: 30 blocks ${small.toFixed(2)}ms, 300 blocks ${large.toFixed(2)}ms\n`);
  // Ten times the transcript must not cost anything like ten times the frame. This is
  // the guarantee virtualization exists for, asked at the app's real frame cap.
  assert.ok(large < small * 3, `scroll cost is tracking transcript size: ${small.toFixed(2)}ms -> ${large.toFixed(2)}ms`);
});

test("probe: virtualized vs full render at the same frame cap", async () => {
  const virt = await scrollMs(150, { maxFps: MAX_FPS, virtual: true });
  const full = await scrollMs(150, { maxFps: MAX_FPS, virtual: false });
  console.log(`\n150 blocks: virtualized ${virt.toFixed(2)}ms, full ${full.toFixed(2)}ms\n`);
  assert.ok(virt <= full, `virtualizing must not cost more than rendering everything`);
});
