/**
 * tipLine.probe.test.tsx — the hint under the input box.
 *
 * Two things about this line are load-bearing and neither is visible from a typecheck.
 * It must be exactly ONE row, because it sits at the bottom of a budgeted frame and a
 * second row comes off the chat or off the screen entirely (that is a glitch this file
 * already has history with). And the chord has to be distinguishable from the sentence
 * around it, which is a claim about what is written to the terminal, not about the props.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// Before Ink loads: chalk fixes its colour support at import time from the real
// process.stdout, not the stream it is handed. Nothing that reaches ink may be imported
// statically here — a static import is hoisted above this line and the setting is lost,
// which is silent: the frames simply come back with no colour in them.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { TIPS, TipLine, nextTip, randomTipIndex } = await import("./components/TipLine.js");

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true as const;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g");

function draw(index: number): { raw: string; plain: string; rows: number } {
  const stdout = new FakeStdout();
  const instance = render(<TipLine tip={TIPS[index]!} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    interactive: false,
    debug: true,
  });
  const raw = stdout.frames[stdout.frames.length - 1] ?? "";
  instance.unmount();
  const plain = raw.replace(ANSI, "");
  return { raw, plain, rows: plain.replace(/\n$/, "").split("\n").length };
}

test("every tip renders on exactly one row", () => {
  // At 80 columns none of them may wrap. A wrapped tip steals a row from the chat.
  for (let i = 0; i < TIPS.length; i++) {
    const { rows, plain } = draw(i);
    assert.equal(rows, 1, `tip ${i} took ${rows} rows: ${JSON.stringify(plain)}`);
  }
});

test("the tip shows its chord and what the chord does", () => {
  const { plain } = draw(0);
  assert.ok(plain.includes(TIPS[0]!.key), `chord missing: ${JSON.stringify(plain)}`);
  assert.ok(plain.includes(TIPS[0]!.text), `description missing: ${JSON.stringify(plain)}`);
});

test("the chord is styled apart from the description, not one flat dim line", () => {
  // The whole line used to be dim, prefixed with the word "tip:". What makes the new one
  // readable at a glance is that the two halves are not painted the same.
  const { raw } = draw(0);
  // In a terminal with no colour there is nothing to assert about colour, and a probe
  // that fails there is a probe that fails in CI for a reason it does not own.
  if (!raw.includes(ESC)) return;
  const beforeKey = raw.slice(0, raw.indexOf(TIPS[0]!.key));
  const beforeText = raw.slice(raw.indexOf(TIPS[0]!.key), raw.indexOf(TIPS[0]!.text));
  assert.ok(beforeKey.includes(ESC), "the chord carries no styling of its own");
  assert.ok(beforeText.includes(ESC), "the description is painted the same as the chord");
});

test("the word 'tip:' is gone", () => {
  // Five columns that told the reader nothing they could not already see.
  assert.ok(!draw(0).plain.includes("tip:"));
});

test("rotation visits every tip before repeating one", () => {
  const seen = new Set<number>();
  let i = randomTipIndex();
  for (let n = 0; n < TIPS.length; n++) {
    assert.ok(!seen.has(i), `tip ${i} came round again after ${n} steps`);
    seen.add(i);
    i = nextTip(i);
  }
  assert.equal(seen.size, TIPS.length, "not every tip was reachable");
});

test("rotation wraps rather than running off the end", () => {
  assert.equal(nextTip(TIPS.length - 1), 0);
  assert.equal(nextTip(0, 1), 0, "a single tip stays put");
  assert.equal(nextTip(0, 0), 0, "an empty set cannot divide by zero");
});

test("a random start is always a real index", () => {
  for (let n = 0; n < 200; n++) {
    const i = randomTipIndex();
    assert.ok(Number.isInteger(i) && i >= 0 && i < TIPS.length, `bad index ${i}`);
  }
});

test("the tips teach keys that exist", () => {
  // A hint for a chord nobody bound is worse than no hint. These are the ones the input
  // actually handles (see PromptInput's key block and wordEdit.probe).
  const keys = TIPS.map((t) => t.key);
  for (const bound of ["ctrl+w", "esc", "@", "shift+tab"]) {
    assert.ok(keys.includes(bound), `${bound} is bound but never mentioned`);
  }
});

// ── the startup fill must not leave blank rows under the prompt ─────────────
//
// The inline shell prints blank rows before its first screen so the conversation lands
// at the BOTTOM of the terminal rather than the top — a terminal prints from wherever
// the cursor happens to be, and without them the prompt floats in the middle of an empty
// window. How many blanks is `rows - INLINE_LIVE_RESERVE`, so the reserve has to be
// exactly what the live region occupies at rest. Reserving more leaves that many empty
// rows under the tip line, which is what a hand-picked value did.

test("the live region at rest is exactly the rows the startup fill reserves", async () => {
  const { useEffect, useRef } = await import("react");
  const { Box, Text, measureElement } = await import("ink");
  const { PromptInput } = await import("./components/PromptInput.js");
  type Node = Parameters<typeof measureElement>[0] | null;

  // PromptInput reads stdin, so unlike the tip tests above this one has to run
  // interactive and be given a stream to read from.
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { setEncoding: () => void }).setEncoding = () => {};
  (stdin as unknown as { resume: () => void }).resume = () => {};
  (stdin as unknown as { pause: () => void }).pause = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};
  (stdin as unknown as { read: () => null }).read = () => null;

  let measured = -1;
  function Footer(): React.ReactElement {
    const ref = useRef<Node>(null);
    useEffect(() => {
      if (ref.current) measured = measureElement(ref.current).height;
    });
    return (
      <Box ref={ref} flexDirection="column" flexShrink={0}>
        {/* The blank separator, always present — see the footer in App. */}
        <Box flexShrink={0}>
          <Text> </Text>
        </Box>
        {/* No status line and no queued bar: both are absent until a turn has run, and
            the fill is printed once, so what it has to fit is the shell at rest. */}
        <Box flexShrink={0} flexDirection="column">
          <PromptInput
            onSubmit={() => {}}
            disabled={false}
            placeholder="say something…"
            width={100}
            history={[]}
            completions={[]}
            maxMenuRows={3}
            settleKey={0}
            overlay={null}
          />
        </Box>
        <TipLine tip={TIPS[0]!} />
      </Box>
    );
  }

  const stdout = new FakeStdout();
  stdout.columns = 100;
  const instance = render(<Footer />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin,
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  await new Promise((r) => setTimeout(r, 150));
  instance.unmount();

  assert.ok(measured > 0, "the footer never laid out, so there is nothing to compare");

  // The fill reserves this many rows for the live region; it has to equal what the live
  // region actually occupies, or the first screen sits with that many blank rows either
  // under the prompt (reserve too big) or overlapping it (too small).
  const { INLINE_LIVE_RESERVE } = await import("./startupFill.js");
  assert.equal(
    INLINE_LIVE_RESERVE,
    measured,
    `the fill reserves ${INLINE_LIVE_RESERVE} rows for a live region that is ${measured} — ` +
      `${Math.abs(INLINE_LIVE_RESERVE - measured)} row(s) of ${INLINE_LIVE_RESERVE > measured ? "blank under the prompt" : "overlap"}`,
  );
});
