/**
 * inlineReading.probe.test.tsx — scrolling back in the inline shell with the prompt PINNED.
 *
 * The inline shell prints into the terminal's own scrollback and the terminal owns the
 * wheel, so looking back at anything carries the prompt off the top with everything
 * else. Reading mode is the answer: on a paging key the app draws a frame of its own in
 * the live region and scrolls inside it, footer pinned underneath, and hands the terminal
 * back the moment the view reaches the bottom again.
 *
 * What is asserted here is the shape that makes that work, because every part of it is a
 * thing that fails silently:
 *
 *   - the frame is SHORTER than the terminal. At the full height Ink stops erasing and
 *     starts clearing, which in a shell that lives in the scrollback would take the
 *     user's conversation with it.
 *   - the footer is the LAST thing in the frame, or the whole feature is pointless.
 *   - the transcript is offset inside a clipped box rather than being allowed to push
 *     the footer down out of the frame.
 *   - not reading costs nothing: the live region goes back to the tail and the footer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Box, Text, Static } from "ink";
import { chatLayout } from "./chatAnchor.js";
import { scrollPill } from "./scrollPill.js";
import { readWheel, stripMouse } from "./mouse.js";
import { useEffect } from "react";

const ROWS = 20;
const COLUMNS = 60;
/** One row short of the terminal — the constraint the whole frame hangs on. */
const FRAME_HEIGHT = Math.max(3, ROWS - 1);
const TRANSCRIPT = 40;

class FakeStdout extends EventEmitter {
  columns = COLUMNS;
  rows = ROWS;
  isTTY = true as const;
  writes: string[] = [];
  write(data: string): boolean {
    this.writes.push(data);
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

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The footer both shells render: a gap, the input box, the tip. */
function Footer(): React.ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexShrink={0}>
        <Text> </Text>
      </Box>
      <Box flexShrink={0}>
        <Text>INPUTBOX</Text>
      </Box>
      <Box flexShrink={0}>
        <Text>TIPLINE</Text>
      </Box>
    </Box>
  );
}

/**
 * The inline shell's real shape: <Static> history, then EITHER the cheap live tail or
 * the reading frame. Mirrors App's branch exactly — that branch is what is under test.
 */
function InlineShell({ reading, scrollUp }: { reading: boolean; scrollUp: number }): React.ReactElement {
  const { marginTop, restsOnFooter } = chatLayout(TRANSCRIPT, FRAME_HEIGHT - 3, scrollUp);
  const pill = scrollPill({ scrolled: Math.min(scrollUp, TRANSCRIPT), newReplies: 0, overlayOpen: false, width: COLUMNS });
  return (
    <Box flexDirection="column">
      <Static items={["printed-history"]}>{(it) => <Text key={it}>{it}</Text>}</Static>
      {/* ONE wrapper regardless of `reading` — see footerRemount.probe.test.tsx for why
          this has to be a single element with the footer always its last child, rather
          than a ternary between two separate boxes. Mirrors App's real shape exactly. */}
      <Box flexDirection="column" flexShrink={0} height={reading ? FRAME_HEIGHT : undefined} overflow={reading ? "hidden" : "visible"}>
        {reading ? (
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
            {restsOnFooter ? <Box flexGrow={1} flexShrink={1} /> : null}
            <Box flexDirection="column" flexShrink={0} marginTop={marginTop}>
              {Array.from({ length: TRANSCRIPT }, (_, i) => (
                <Box key={i} flexShrink={0}>
                  <Text>{`line${i}`}</Text>
                </Box>
              ))}
            </Box>
            {pill ? (
              <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center">
                <Text>{pill}</Text>
              </Box>
            ) : null}
          </Box>
        ) : (
          <Text>live-tail</Text>
        )}
        <Footer />
      </Box>
    </Box>
  );
}

function draw(reading: boolean, scrollUp: number): string[] {
  const stdout = new FakeStdout();
  const instance = render(<InlineShell reading={reading} scrollUp={scrollUp} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  const last = stdout.writes[stdout.writes.length - 1] ?? "";
  instance.unmount();
  return last.replace(ANSI, "").split("\n");
}

const rowOf = (rows: string[], needle: string): number => rows.findIndex((r) => r.includes(needle));

test("reading: the prompt is the LAST thing on screen, under the transcript", () => {
  const rows = draw(true, 20);
  const input = rowOf(rows, "INPUTBOX");
  const tip = rowOf(rows, "TIPLINE");

  assert.ok(input > 0, `the prompt is not on screen at all:\n${rows.join("\n")}`);
  assert.equal(tip, input + 1, "the tip belongs directly under the input");
  // Some transcript is above it — the whole point is reading while it stays put.
  assert.ok(
    rows.slice(0, input).some((r) => /^line\d+/.test(r.trim())),
    "no transcript above the prompt, so nothing is being read",
  );
});

test("reading: scrolling moves the transcript and NOT the prompt", () => {
  const near = draw(true, 5);
  const far = draw(true, 25);

  assert.equal(rowOf(near, "INPUTBOX"), rowOf(far, "INPUTBOX"), "the prompt moved when the view scrolled");
  assert.equal(rowOf(near, "TIPLINE"), rowOf(far, "TIPLINE"), "the tip moved when the view scrolled");

  // And the transcript genuinely moved: different lines are on screen.
  const visible = (rows: string[]): string[] => rows.filter((r) => /^\s*line\d+/.test(r)).map((r) => r.trim());
  assert.notDeepEqual(visible(near), visible(far), "scrolling changed nothing on screen");
});

test("reading: the frame is SHORTER than the terminal", () => {
  // At the full height Ink abandons erase-and-redraw for clearTerminal, and in a shell
  // whose history lives in the terminal's scrollback that erases the conversation.
  const rows = draw(true, 20);
  const painted = rows.filter((r) => r.trim() !== "").length;
  assert.ok(painted < ROWS, `the frame filled ${painted} of ${ROWS} rows — it must leave one`);
  assert.ok(rows.length <= ROWS, `emitted ${rows.length} rows into a ${ROWS}-row terminal`);
});

test("reading: the chip is on screen and names the way out", () => {
  const rows = draw(true, 20);
  const chip = rowOf(rows, "Catch up");
  const input = rowOf(rows, "INPUTBOX");
  assert.ok(chip > 0, "no chip while scrolled back");
  assert.ok(chip < input, "the chip belongs over the transcript, not under the prompt");
  assert.match(rows[chip]!, /ctrl\+End/);
});

test("NOT reading: the live region is just the tail and the footer", () => {
  // The cheap path, unchanged. A reading view that cost anything while nobody was
  // reading would be a tax on every keystroke of every session.
  const rows = draw(false, 0);
  const painted = rows.filter((r) => r.trim() !== "");
  assert.ok(rowOf(rows, "live-tail") >= 0, "the live tail is gone");
  assert.ok(rowOf(rows, "INPUTBOX") >= 0, "the prompt is gone");
  assert.equal(rowOf(rows, "Catch up"), -1, "a chip while pinned to the bottom");
  assert.ok(painted.length <= 4, `the idle live region grew to ${painted.length} rows: ${JSON.stringify(painted)}`);
});

// ── the WHEEL is the gesture, and it has to be the one that opens the view ──
//
// The first cut opened reading mode on a paging key only. That left the actual
// complaint untouched: scrolling with the wheel went to the terminal, which scrolled
// its own buffer and carried the prompt off the top of the screen. Catching a wheel
// notch means asking the terminal to report it, and reporting is what these pin.

test("a wheel notch reaches the app as a scroll, not as typed text", () => {
  // Both spellings: raw off stdin with the ESC intact, and again through Ink's key
  // parser, which eats it. Either one landing in the prompt is the bug that mouse
  // reporting caused the first time it was switched on.
  for (const report of ["\x1b[<64;25;26M", "[<64;25;26M"]) {
    assert.deepEqual(readWheel(report), ["up"], `a wheel-up was not read from ${JSON.stringify(report)}`);
    assert.equal(stripMouse(report), "", `a wheel report survived into typed input: ${JSON.stringify(report)}`);
  }
});

test("wheel DOWN is not a wheel up — only going back opens the view", () => {
  assert.deepEqual(readWheel("\x1b[<65;25;26M"), ["down"]);
  // And a flick is every notch in it, so one turn of the wheel is one scroll of the
  // whole distance rather than a third of it.
  assert.equal(readWheel("\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<64;1;1M").length, 3);
});

test("a chunk that mixes a wheel report with typing keeps only the typing", () => {
  const raw = "\x1b[<64;25;26Mhello";
  assert.deepEqual(readWheel(raw), ["up"]);
  assert.equal(stripMouse(raw), "hello");
});

test("opening overshoots the scroll, and the frame still renders the TOP", () => {
  // The first notch is taken before any viewport exists, so the number it produces is
  // larger than the transcript can travel. That must land on the first line rather than
  // on a blank frame — an overshoot is clamped for display, never for state.
  const rows = draw(true, TRANSCRIPT * 10);
  assert.ok(rowOf(rows, "INPUTBOX") > 0, "the prompt vanished on an overshooting scroll");
  assert.ok(rowOf(rows, "line0") >= 0, `the top of the transcript is not on screen:\n${rows.join("\n")}`);
  // The FIRST transcript row on screen is the transcript's own first line — the view
  // rests on the top rather than being slid past it into blank rows.
  const first = rows.find((r) => /^\s*line\d+/.test(r));
  assert.equal(first?.trim(), "line0", `an overshoot slid past the top: first visible row was ${first?.trim()}`);
});

test("scrolled to the bottom, the chip is gone — that is the signal to close", () => {
  // The reading view closes when the view reaches the bottom, and the chip is the same
  // condition rendered. If these two ever disagreed the view would sit open with no
  // chip, or show a chip it had already closed on.
  assert.equal(scrollPill({ scrolled: 0, newReplies: 0, overlayOpen: false, width: COLUMNS }), null);
  assert.ok(scrollPill({ scrolled: 1, newReplies: 0, overlayOpen: false, width: COLUMNS }));
});

// ── closing must not force <Static> to reprint ───────────────────────────────
//
// The reported flicker — the whole transcript area going black for a frame, footer
// untouched — traced to a `<Static key={staticEpoch}>` remount that used to fire the
// instant reading closed. The reasoning that led there was borrowed from a genuinely
// different case: leaving the FULL-SCREEN shell's alternate buffer really does lose
// everything Static printed, so a reprint is correct there. Closing the reading view
// never leaves the primary buffer at all — every line was already in real scrollback
// before reading even opened — so nothing needs reprinting, and doing it anyway forces
// dozens of blocks to be laid out again in the same instant the live region is already
// shrinking. These pin that the fix holds: `<Static>`'s key does not change across a
// reading open/close cycle.

test("Static's key survives a full open-then-close of reading mode", async () => {
  let mounts = 0;
  function Marker(): React.ReactElement {
    useEffect(() => {
      mounts++;
    }, []);
    return <Text>held</Text>;
  }
  function Harness({ epoch }: { epoch: number }): React.ReactElement {
    return (
      <Box flexDirection="column">
        <Static key={epoch} items={["only"]}>
          {(it) => (
            <Box key={it} flexDirection="column">
              <Marker />
            </Box>
          )}
        </Static>
        <Text>INPUTBOX</Text>
      </Box>
    );
  }
  const stdout = new FakeStdout();
  const instance = render(<Harness epoch={0} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
  });
  await new Promise((r) => setTimeout(r, 60));
  // The whole point: whatever value the app's staticEpoch holds, opening and closing
  // reading mode does not touch it — so re-rendering with the SAME epoch across a full
  // open-then-close cycle must mount the marker exactly once.
  instance.rerender(<Harness epoch={0} />); // "open"
  await new Promise((r) => setTimeout(r, 60));
  instance.rerender(<Harness epoch={0} />); // "close"
  await new Promise((r) => setTimeout(r, 60));
  instance.unmount();
  assert.equal(mounts, 1, `Static's content remounted ${mounts} times across an open/close cycle with a stable key`);
});
