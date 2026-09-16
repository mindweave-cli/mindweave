/**
 * pillClick.probe.test.tsx — clicking the jump-to-bottom chip.
 *
 * The chip is a button, and a button that is one row off is a button that does nothing.
 * Its columns fall out of centring, which `pillBounds` reproduces from the same
 * arithmetic Ink uses; its ROW comes from the layout. This checks that the row the
 * layout reports is the row the chip actually paints on — the chip is ABSOLUTELY
 * positioned, which is exactly the kind of node whose reported position is worth
 * confirming rather than assuming.
 *
 * The other half is a coordinate space. A mouse report gives a row on the SCREEN; the
 * layout reports a row within the LIVE REGION. Those are the same number in the
 * full-screen shell and are not in the inline one, where the live region is the last
 * few rows of a terminal full of scrollback. Getting that wrong is what once left the
 * cursor parked in the middle of the conversation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { render, Box, Text, measureElement, type DOMElement } from "ink";
import { hitsPill, pillBounds, scrollPill } from "./scrollPill.js";

const COLUMNS = 80;

class FakeStdout extends EventEmitter {
  columns = COLUMNS;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
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
const PILL = scrollPill({ scrolled: 5, newReplies: 0, overlayOpen: false, width: COLUMNS })!;

/**
 * Render the viewport shape with the chip on it, and report BOTH the row the layout
 * gives for it and the row it was actually painted on.
 */
function drawAndMeasure(): { reported: number | null; painted: number; row: string } {
  const stdout = new FakeStdout();
  let reported: number | null = null;
  function Frame(): React.ReactElement {
    return (
      <Box flexDirection="column" height={16} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
          {Array.from({ length: 20 }, (_, i) => (
            <Box key={i} flexShrink={0}>
              <Text>{`line${i}`}</Text>
            </Box>
          ))}
          <Box
            ref={(node: DOMElement | null) => {
              reported = node ? measureElement(node).y : null;
            }}
            position="absolute"
            bottom={0}
            left={0}
            right={0}
            justifyContent="center"
          >
            <Text>{PILL}</Text>
          </Box>
        </Box>
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
  const instance = render(<Frame />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  const rows = (stdout.frames.at(-1) ?? "").replace(ANSI, "").split("\n");
  // BEFORE unmount: unmounting calls the ref again with null, which would report the
  // chip as unmeasured no matter where it was.
  const measured = reported;
  instance.unmount();
  const painted = rows.findIndex((r) => r.includes("Catch up"));
  return { reported: measured, painted, row: rows[painted] ?? "" };
}

test("the row the layout reports is the row the chip is painted on", () => {
  // If these ever disagree the button is silently in the wrong place: nothing errors, the
  // chip is visible, and clicking it does nothing.
  const { reported, painted } = drawAndMeasure();
  assert.ok(painted >= 0, "the chip never painted, so there is nothing to compare");
  assert.equal(reported, painted, `layout says row ${reported}, the chip is on row ${painted}`);
});

test("the columns the arithmetic predicts are the columns it occupies", () => {
  // `pillBounds` reproduces Ink's centring rather than measuring it. If the two ever
  // disagreed, every click would land beside the chip.
  const { painted, row } = drawAndMeasure();
  assert.ok(painted >= 0, "the chip never painted");
  const bounds = pillBounds(PILL, COLUMNS, painted);
  // Compared with the trailing pad trimmed: a terminal row drops trailing blanks at the
  // line end, so the last cell of a chip that ends in a space is not in the painted
  // string even though it is on the screen. The LEFT edge is what a click depends on.
  assert.equal(
    row.slice(bounds.left, bounds.right + 1),
    PILL.trimEnd(),
    `the chip is not where the arithmetic puts it: ${JSON.stringify(row)}`,
  );
});

test("a click anywhere on the chip hits it, including the padding", () => {
  const bounds = pillBounds(PILL, COLUMNS, 12);
  for (let x = bounds.left; x <= bounds.right; x++) {
    assert.equal(hitsPill(bounds, x, 12), true, `column ${x} missed`);
  }
});

test("a click beside or above or below it does not", () => {
  const bounds = pillBounds(PILL, COLUMNS, 12);
  assert.equal(hitsPill(bounds, bounds.left - 1, 12), false, "a column before the chip hit it");
  assert.equal(hitsPill(bounds, bounds.right + 1, 12), false, "a column after the chip hit it");
  assert.equal(hitsPill(bounds, bounds.left, 11), false, "the row above hit it");
  assert.equal(hitsPill(bounds, bounds.left, 13), false, "the row below hit it");
});

test("the chip is exactly one row tall — the transcript around it stays selectable", () => {
  // Accepting the rows either side would swallow clicks meant for the conversation.
  const bounds = pillBounds(PILL, COLUMNS, 12);
  const rowsHit = [10, 11, 12, 13, 14].filter((y) => hitsPill(bounds, bounds.left, y));
  assert.deepEqual(rowsHit, [12]);
});

test("a narrow terminal moves the chip, and the bounds move with it", () => {
  // The chip shortens below a certain width (the chord is dropped), so its left edge is
  // not a fixed number — bounds computed against a stale width would miss every click.
  for (const width of [40, 60, 80, 120]) {
    const pill = scrollPill({ scrolled: 5, newReplies: 0, overlayOpen: false, width });
    if (!pill) continue;
    const bounds = pillBounds(pill, width, 3);
    assert.equal(bounds.right - bounds.left + 1, pill.length, `width ${width}: bounds do not cover the chip`);
    assert.ok(bounds.left >= 0 && bounds.right < width, `width ${width}: the chip is outside the terminal`);
    // Centred: the margins either side differ by at most one column.
    assert.ok(Math.abs(bounds.left - (width - 1 - bounds.right)) <= 1, `width ${width}: not centred`);
  }
});
