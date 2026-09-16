/**
 * scrollPill.probe.test.tsx — where the scrolled-back chip actually lands.
 *
 * `scrollPill.test.ts` proves what the chip SAYS. This proves it reaches the terminal
 * on the row it is supposed to, and — the part that cannot be reasoned about — that
 * putting it there costs the chat viewport nothing.
 *
 * That second claim is the whole design. The chip is absolutely positioned so it is out
 * of flow: no row comes off the transcript, the height `chatRef` measures is unchanged,
 * and therefore `chatRows`, `chatLayout` and the entire scroll offset are bit-for-bit
 * what they were with no chip on screen. If that were ever untrue the viewport would
 * shrink the instant you scrolled and grow back when you returned, re-wrapping the
 * transcript under the reader as a consequence of looking at it. Nothing in a type
 * checker or a unit test would notice.
 *
 * The frame here mirrors App's real skeleton — fixed-height column, flexShrink:0
 * banner, flexGrow:1 clipped viewport holding an offset transcript, pinned footer —
 * because those are the parts that decide placement. What is inside each is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useEffect, useRef } from "react";
import { render, Box, Text, measureElement, useInput, type DOMElement } from "ink";
import { chatLayout } from "./chatAnchor.js";
import { scrollPill } from "./scrollPill.js";
import { PromptInput } from "./components/PromptInput.js";

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 24;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const FRAME_HEIGHT = 16;
const LINES = 40;

function Frame({ pill, onMeasure }: { pill: string | null; onMeasure: (rows: number) => void }) {
  const chatRef = useRef<DOMElement | null>(null);
  useEffect(() => {
    if (chatRef.current) onMeasure(measureElement(chatRef.current).height);
  });
  // A transcript far longer than the viewport, scrolled back — the only state in which
  // the chip is ever on screen.
  const { marginTop, restsOnFooter } = chatLayout(LINES, 12, 6);
  return (
    <Box flexDirection="column" height={FRAME_HEIGHT} overflow="hidden">
      <Box flexShrink={0}>
        <Text>BANNER</Text>
      </Box>
      <Box ref={chatRef} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
        {restsOnFooter ? <Box flexGrow={1} flexShrink={1} /> : null}
        <Box flexDirection="column" flexShrink={0} marginTop={marginTop}>
          {Array.from({ length: LINES }, (_, i) => (
            <Box key={i} flexShrink={0}>
              <Text>{`msg${i} ${"x".repeat(40)}`}</Text>
            </Box>
          ))}
        </Box>
        {pill ? (
          <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center">
            <Text>{pill}</Text>
          </Box>
        ) : null}
      </Box>
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
    </Box>
  );
}

function draw(pill: string | null): { rows: string[]; chatRows: number } {
  const stdout = new FakeStdout();
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  let chatRows = -1;
  const instance = render(<Frame pill={pill} onMeasure={(n) => (chatRows = n)} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  // Read BEFORE unmount: Ink 7 writes a blank frame on the way out.
  const last = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  return { rows: last.replace(ANSI, "").split("\n"), chatRows };
}

const rowOf = (rows: string[], needle: string): number => rows.findIndex((r) => r.includes(needle));

test("the chip is on the last row of the viewport, right above the footer's gap", () => {
  const pill = scrollPill({ scrolled: 6, newReplies: 0, overlayOpen: false, width: 60 });
  assert.ok(pill, "the chip should exist at this width — the rest of the test is about it");
  const { rows } = draw(pill);
  const chip = rowOf(rows, "Catch up");
  const input = rowOf(rows, "INPUTBOX");

  assert.ok(chip > 0, `the chip never rendered:\n${rows.join("\n")}`);
  assert.ok(input > chip, "the chip belongs above the input, not below it");
  // Exactly the footer's one blank row between them: the chip sits ON the transcript's
  // last visible row, not in a row of its own carved out of the chat.
  assert.equal(input - chip, 2, `expected the chip on the viewport's last row, found ${input - chip - 1} rows between`);
});

test("the chip PAINTS OVER a row — it never pushes one", () => {
  const pill = scrollPill({ scrolled: 6, newReplies: 0, overlayOpen: false, width: 60 });
  assert.ok(pill);
  const withChip = draw(pill);
  const without = draw(null);

  assert.equal(withChip.chatRows, without.chatRows, "the chip changed the measured viewport height");
  assert.equal(withChip.rows.length, without.rows.length, "the chip changed how many rows the frame has");

  // Every row but the chip's own is byte-identical. This is the assertion the design
  // rests on: a chip that consumed a row would shift the whole transcript by one, and
  // scrolling would then re-wrap the screen as a side effect of looking at it.
  const chip = rowOf(withChip.rows, "Catch up");
  assert.ok(chip > 0, "the chip never rendered, so nothing below means anything");
  for (let i = 0; i < withChip.rows.length; i++) {
    if (i === chip) continue;
    assert.equal(withChip.rows[i], without.rows[i], `row ${i} moved or changed under the chip`);
  }

  // And the chip's own row is still the transcript row it was — overpainted in the
  // middle, intact at both ends. A row REPLACED by the chip is a line of the
  // conversation silently deleted from the screen.
  const covered = without.rows[chip]!;
  const head = covered.slice(0, 8);
  assert.ok(
    withChip.rows[chip]!.startsWith(head),
    `the chip replaced the row instead of covering it: expected it to still start "${head}"`,
  );
});

test("it is centred, and stays inside the terminal", () => {
  const pill = scrollPill({ scrolled: 6, newReplies: 2, overlayOpen: false, width: 60 });
  assert.ok(pill);
  const { rows } = draw(pill);
  const row = rows.find((r) => r.includes("2 new replies"));
  assert.ok(row, `the counted form never rendered:\n${rows.join("\n")}`);
  const start = row.indexOf(" 2 new replies");
  assert.ok(start > 0, "the chip is flush against the left edge — justifyContent did not apply");
  assert.ok(row.length <= 60, `the row is ${row.length} columns wide on a 60-column terminal`);
  // Centred within a column of margin either side.
  const end = start + pill.length;
  assert.ok(Math.abs(start - (60 - end)) <= 1, `not centred: ${start} before, ${60 - end} after`);
});

test("pinned to the newest, nothing is drawn at all", () => {
  const { rows } = draw(scrollPill({ scrolled: 0, newReplies: 0, overlayOpen: false, width: 60 }));
  assert.equal(rowOf(rows, "Catch up"), -1, "the chip rendered while pinned to the bottom");
});

// ── the chord the chip advertises ──────────────────────────────────────────
//
// The chip names ctrl+End, so the chord has to exist. Two ways it could quietly not:
// the terminal's escape sequence is not decoded as End-with-ctrl at all, in which case
// the handler is never called; or it IS decoded but the input box also takes it, in
// which case pressing it types garbage into the prompt. Neither shows up in a
// typecheck, and both are invisible until someone presses the key.

/** A stdin Ink will actually read from: it pulls with `read()` after a `readable`. */
class FakeStdin extends EventEmitter {
  isTTY = true as const;
  #queue: string[] = [];
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.#queue.shift() ?? null;
  }
  type(sequence: string): void {
    this.#queue.push(sequence);
    this.emit("readable");
  }
}

const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 60));

test("ctrl+End and ctrl+Home arrive as themselves, and never as typed text", async () => {
  const seen: string[] = [];
  function Keys(): null {
    useInput((input, key) => {
      if (key.end && key.ctrl) seen.push("ctrl+End");
      else if (key.home && key.ctrl) seen.push("ctrl+Home");
      else if (key.end) seen.push("End");
      else if (key.home) seen.push("Home");
      else seen.push(`other:${JSON.stringify(input)}`);
    });
    return null;
  }

  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const instance = render(
    <Box flexDirection="column">
      <Keys />
      <PromptInput
        onSubmit={() => {}}
        disabled={false}
        placeholder="say something…"
        width={60}
        history={[]}
        completions={[]}
        maxMenuRows={3}
        settleKey={0}
        overlay={null}
      />
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      interactive: true,
      debug: true,
    },
  );
  await settle();
  // The input's own box edge marks a real frame; Ink also writes bare control
  // sequences, and one of those would read as a screen with nothing on it.
  const frame = (): string => stdout.frames.filter((f) => f.includes("└")).at(-1) ?? "";
  const before = frame();

  // Both spellings of each chord that a terminal in the wild actually sends.
  for (const sequence of ["\x1b[1;5F", "\x1b[1;5H", "\x1b[4~", "\x1b[8^"]) {
    stdin.type(sequence);
    await settle();
  }
  const after = frame();
  instance.unmount();

  assert.deepEqual(seen, ["ctrl+End", "ctrl+Home", "End", "ctrl+End"]);
  assert.match(before, /say something/, "the placeholder should have been showing to begin with");
  assert.equal(after, before, "the frame changed — one of the chords was typed into the input box");
});
