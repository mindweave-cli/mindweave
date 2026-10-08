/**
 * mouseLayer.probe.test.tsx — selecting, copying, and clicking to place the caret,
 * exercised against a REAL framebuffer.
 *
 * The unit tests either side of this one prove the pieces: what a drag covers
 * (selection.test.ts), how a report is decoded (mouse.test.ts), and how a row is located
 * in painted cells (wordEdit.test.ts). None of them prove the pieces meet. The risk in
 * this feature is entirely in the meeting: a click is resolved against what the framebuffer
 * actually painted, so a component that renders one thing and a grid that holds another
 * would put the caret in the wrong place while every unit test stayed green.
 *
 * So this drives Ink through `framebufferStdout`, reads the grid that results, and works
 * out where to click by scanning that grid ITSELF rather than by asking the code under
 * test where it thinks the text is.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useRef } from "react";

// Before Ink loads: chalk fixes its colour support at import time from the real
// process.stdout, not the stream it is handed. Nothing reaching ink may be imported
// statically here.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
// Chalk takes FORCE_COLOR as a minimum: a 256-colour TERM (most Linux shells) still downgrades hex colours unless this says otherwise.
process.env.COLORTERM = "truecolor";
const { render, useInput } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");
const { readMouse } = await import("./mouse.js");
const { framebufferStdout } = await import("./framebuffer/writer.js");
const { latestScreen, repaintOverlay, setFrameOverlay } = await import("./framebuffer/overlay.js");
const { applySelection, selectionText } = await import("./selection.js");
const { ATTR } = await import("./framebuffer/screen.js");

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 12;
  isTTY = true as const;
  written: string[] = [];
  write(data: string): boolean {
    this.written.push(data);
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
  private readonly queue: string[] = [];
  read(): string | null { return this.queue.shift() ?? null; }
  type(s: string): void { this.queue.push(s); this.emit("readable"); }
}

/** Read a row out of the grid as a plain string, so the test can find things for itself. */
function gridRow(y: number): string {
  const screen = latestScreen();
  if (!screen || y < 0 || y >= screen.height) return "";
  let out = "";
  for (let x = 0; x < screen.width; x++) {
    const ch = screen.chars[screen.index(x, y)]!;
    // Sentinels (a wide-character continuation, an unknown cell) are not codepoints.
    out += ch > 0x10ffff ? " " : String.fromCodePoint(ch);
  }
  return out;
}

/** Where `text` sits on the painted screen, found by the TEST's own scan. */
function findOnScreen(text: string): { x: number; y: number } | null {
  const screen = latestScreen();
  if (!screen) return null;
  for (let y = 0; y < screen.height; y++) {
    const x = gridRow(y).indexOf(text);
    if (x >= 0) return { x, y };
  }
  return null;
}

/** The caret glyph, which is also the box border. Removing every one of them leaves the
 *  typed text, which is what these assertions are about. */
const BAR = "│";

/**
 * A painted row with the caret taken out, so an assertion about TEXT is not secretly an
 * assertion about which half of the blink the frame was read in.
 *
 * The caret does not sit between cells: it TAKES the cell it is on and gives it back on
 * the off-beat (see PromptInput's Caret and its `under` prop). So the character under the
 * cursor is present or replaced depending on the instant, and only the rest of the row is
 * a stable fact.
 */
function rowText(y: number): string {
  return gridRow(y).split(BAR).join("");
}

/**
 * The row sampled across a blink, keeping the reading where the caret is LIT.
 *
 * The caret has a column of its own and draws a bar in it on the on-beat and a space on
 * the off-beat. Stripping bars from an on-beat reading leaves exactly the text; doing it
 * to an off-beat reading leaves an extra space where the cursor is. The two are told
 * apart by how many bars the row holds — the lit one has one more than the border.
 */
async function settledRow(y: number): Promise<string> {
  const bars = (s: string) => s.split(BAR).length - 1;
  let best = gridRow(y);
  const deadline = Date.now() + 1400;
  while (Date.now() < deadline) {
    const row = gridRow(y);
    if (bars(row) > bars(best)) best = row;
    await new Promise((r) => setTimeout(r, 10));
  }
  return best.split(BAR).join("");
}

interface Harness {
  unmount: () => void;
  /** Send real SGR pointer bytes, the way a terminal does. */
  mouse: (bytes: string) => Promise<void>;
  click: (x: number, y: number) => void;
  type: (text: string) => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * ONE harness for the whole file, mounted once.
 *
 * A framebuffer publishes the grid it painted to a module-level slot, because the real
 * app has exactly one of them for the life of the process. A test file that mounted one
 * per test does not: the torn-down ones keep an idle repaint timer armed, and when it
 * fires it republishes a grid belonging to a test that finished, so the next test reads
 * the previous one screen. Mounting once removes the difference from the real thing.
 */
let shared: Harness | null = null;
// Without this the render keeps the process alive and the file never finishes.
after(() => {
  setFrameOverlay(null);
  shared?.unmount();
});
async function harness(): Promise<Harness> {
  if (!shared) shared = await mount();
  await shared.clear();
  return shared;
}

/**
 * The pointer wired the way App wires it: a `useInput` handler that parses reports out of
 * what INK delivers.
 *
 * This is the part of the feature that was dead in the real app while every test here was
 * green, so it belongs in the harness rather than being stubbed. The dead version listened
 * for `data` on stdin; Ink 7 pulls input with `read()` on a `readable` event and has taken
 * the bytes first, so such a listener is never called — silently, with nothing to see.
 * Driving the CHARACTERS, not the handler, is what makes that observable.
 */
function Wired({ onReady }: { onReady: (place: ((x: number, y: number) => void) | null) => void }) {
  const place = useRef<((x: number, y: number) => void) | null>(null);
  const select = useRef<((a: { x: number; y: number }, b: { x: number; y: number }) => boolean) | null>(null);
  const anchor = useRef<{ x: number; y: number } | null>(null);

  useInput(
    (input) => {
      for (const event of readMouse(input)) {
        if (event.kind === "press") anchor.current = { x: event.x, y: event.y };
        else if (event.kind === "release") {
          const from = anchor.current;
          anchor.current = null;
          // A click is a press and a release in the same cell; a drag is a selection.
          if (!from) continue;
          if (from.x === event.x && from.y === event.y) place.current?.(event.x, event.y);
          else select.current?.(from, { x: event.x, y: event.y });
        }
      }
    },
    { isActive: true },
  );

  return (
    <PromptInput
      onSubmit={() => {}}
      width={60}
      placeholder=""
      registerCaretClick={(fn) => {
        place.current = fn;
        onReady(fn);
      }}
      registerTextSelect={(fn) => {
        select.current = fn;
      }}
    />
  );
}

async function mount(): Promise<Harness> {
  const raw = new FakeStdout();
  const stdout = framebufferStdout(raw);
  const stdin = new FakeStdin();
  let place: ((x: number, y: number) => void) | null = null;

  const instance = render(
    <Wired
      onReady={(fn) => {
        place = fn;
      }}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      interactive: true,
      debug: true,
    },
  );

  const type = async (text: string) => {
    for (const ch of text) {
      stdin.type(ch);
      await new Promise((r) => setTimeout(r, 3));
    }
    await new Promise((r) => setTimeout(r, 40));
  };

  return {
    unmount: () => instance.unmount(),
    mouse: async (bytes: string) => {
      stdin.type(bytes);
      await new Promise((r) => setTimeout(r, 40));
    },
    click: (x, y) => place?.(x, y),
    type,
    // Ctrl+U, the input own kill-line, so each test starts from an empty box without
    // the component being torn down and rebuilt.
    clear: async () => {
      setFrameOverlay(null);
      // Ctrl+E first: Ctrl+U kills from the START to the cursor, so after a test that
      // clicked into the middle of a line it would leave the tail behind.
      stdin.type("");
      await new Promise((r) => setTimeout(r, 10));
      stdin.type("");
      await new Promise((r) => setTimeout(r, 40));
    },
  };
}

test("clicking in the middle of a word puts the caret there", async () => {
  const h = await harness();
  {
    await h.type("the copy to be same");
    const at = findOnScreen("copy");
    assert.ok(at, "the typed text never reached the screen");

    // Click between the p and the y of "copy" — column of the word, plus three.
    h.click(at.x + 3, at.y);
    await h.type("X");

    const row1 = await settledRow(at.y);
    assert.ok(row1.includes("copXy to be same"), `caret landed wrong: ${JSON.stringify(rowText(at.y).trim())}`);
  }
});

test("clicking at the start of the text puts the caret before it", async () => {
  const h = await harness();
  {
    await h.type("hello");
    const at = findOnScreen("hello");
    assert.ok(at);
    h.click(at.x, at.y);
    await h.type(">");
    const row2 = await settledRow(at.y);
    assert.ok(row2.includes(">hello"), row2.trim());
  }
});

test("a click past the end of the text lands at the end, not beyond it", async () => {
  const h = await harness();
  {
    await h.type("short");
    const at = findOnScreen("short");
    assert.ok(at);
    h.click(at.x + 40, at.y);
    await h.type("!");
    const row3 = await settledRow(at.y);
    assert.ok(row3.includes("short!"), row3.trim());
  }
});

test("a click on a row the input does not occupy does nothing at all", async () => {
  // The safety property. If the mapping cannot place a click with confidence it must
  // leave the caret alone rather than guess, so a click on empty screen is inert.
  const h = await harness();
  {
    await h.type("dont move me");
    h.click(5, 0);
    await h.type("!");
    const row = await settledRow(findOnScreen("dont move me")?.y ?? 0);
    assert.ok(row.includes("dont move me!"), `the caret moved on a click it could not place: ${row.trim()}`);
  }
});

test("a selection is highlighted on the frame, and reads back as the text under it", async () => {
  const h = await harness();
  {
    await h.type("select this text");
    const at = findOnScreen("this");
    assert.ok(at);

    const sel = { anchor: { x: at.x, y: at.y }, focus: { x: at.x + 3, y: at.y } };
    setFrameOverlay((screen) => applySelection(screen, sel));
    repaintOverlay();

    const screen = latestScreen()!;
    assert.equal(selectionText(screen, sel), "this", "the wrong text was picked up");
    for (let x = at.x; x <= at.x + 3; x++) {
      assert.ok(screen.attrs[screen.index(x, at.y)]! & ATTR.inverse, `cell ${x} was not highlighted`);
    }
    assert.equal(screen.attrs[screen.index(at.x - 1, at.y)]! & ATTR.inverse, 0, "highlight spilled left");
    assert.equal(screen.attrs[screen.index(at.x + 4, at.y)]! & ATTR.inverse, 0, "highlight spilled right");
  }
});

test("moving a selection leaves no highlight behind on the cells it left", async () => {
  // The cost of getting this wrong is a trail of inverted cells across the screen, which
  // is exactly what an overlay that undoes itself incorrectly would produce.
  const h = await harness();
  {
    await h.type("aaaa bbbb cccc");
    const at = findOnScreen("aaaa");
    assert.ok(at);

    let sel = { anchor: { x: at.x, y: at.y }, focus: { x: at.x + 3, y: at.y } };
    setFrameOverlay((screen) => applySelection(screen, sel));
    repaintOverlay();

    // Drag off it, onto the third word.
    sel = { anchor: { x: at.x + 10, y: at.y }, focus: { x: at.x + 13, y: at.y } };
    repaintOverlay();

    const screen = latestScreen()!;
    for (let x = at.x; x <= at.x + 3; x++) {
      assert.equal(screen.attrs[screen.index(x, at.y)]! & ATTR.inverse, 0, `cell ${x} stayed inverted`);
    }
    assert.equal(selectionText(screen, sel), "cccc");
  }
});

test("clearing the selection takes the highlight off the screen", async () => {
  const h = await harness();
  {
    await h.type("highlight me");
    const at = findOnScreen("highlight");
    assert.ok(at);
    let sel: { anchor: { x: number; y: number }; focus: { x: number; y: number } } | null = {
      anchor: { x: at.x, y: at.y },
      focus: { x: at.x + 8, y: at.y },
    };
    setFrameOverlay((screen) => applySelection(screen, sel));
    repaintOverlay();

    // Asserted on the CELLS THAT WERE SELECTED, not on "is anything inverted anywhere".
    // The caret marks its own position by inverting a cell too, so a screen-wide check
    // would find it and report a highlight that is not there.
    const covered = (screen: NonNullable<ReturnType<typeof latestScreen>>) =>
      [...Array(9).keys()].map((i) => screen.attrs[screen.index(at.x + i, at.y)]! & ATTR.inverse);

    assert.ok(covered(latestScreen()!).every(Boolean), "nothing was highlighted to begin with");

    sel = null;
    repaintOverlay();
    assert.ok(
      covered(latestScreen()!).every((a) => a === 0),
      "the highlight outlived the selection",
    );
  }
});

test("the text on screen survives being highlighted and unhighlighted", async () => {
  // A highlight is one attribute bit. If it ever touched the characters, this is where
  // that would show up as text going missing.
  const h = await harness();
  {
    await h.type("keep every character");
    const before = gridRow(findOnScreen("keep")!.y);
    const at = findOnScreen("every")!;
    let sel: { anchor: { x: number; y: number }; focus: { x: number; y: number } } | null = {
      anchor: { x: at.x, y: at.y },
      focus: { x: at.x + 4, y: at.y },
    };
    setFrameOverlay((screen) => applySelection(screen, sel));
    repaintOverlay();
    sel = null;
    repaintOverlay();
    assert.equal(gridRow(findOnScreen("keep")!.y), before);
  }
});

test("a highlight survives the next frame", async () => {
  // The case the other selection tests miss. Those drive `repaintOverlay`, which re-tints
  // the frame already on screen; this one asks whether a NEW frame comes out tinted. The
  // caret alone redraws twice a second, so an overlay applied only on repaint would leave
  // a selection that flickers off the moment anything renders.
  const h = await harness();
  await h.type("keep me highlighted");
  const at = findOnScreen("highlighted");
  assert.ok(at);

  const sel = { anchor: { x: at.x, y: at.y }, focus: { x: at.x + 10, y: at.y } };
  setFrameOverlay((screen) => applySelection(screen, sel));
  repaintOverlay();

  // Type, which renders and writes a frame through the framebuffer.
  await h.type("!");

  const screen = latestScreen()!;
  assert.ok(
    screen.attrs[screen.index(at.x, at.y)]! & ATTR.inverse,
    "the highlight was lost on the next frame",
  );
});

test("a click delivered as terminal BYTES moves the caret", async () => {
  // The test this file was missing, and the reason the feature shipped dead once already.
  // Every other click test here calls the handler directly, which proves the mapping and
  // says nothing about whether a real report ever reaches it. This one sends the bytes a
  // terminal actually sends and lets them find their own way through Ink.
  const h = await harness();
  await h.type("click into this text");
  const at = findOnScreen("this");
  assert.ok(at, "the typed text never reached the screen");

  // SGR: press then release in the same cell, 1-based on the wire.
  const col = at.x + 2 + 1;
  const row = at.y + 1;
  await h.mouse(`\x1b[<0;${col};${row}M`);
  await h.mouse(`\x1b[<0;${col};${row}m`);
  await h.type("X");

  const row1 = await settledRow(at.y);
  assert.ok(row1.includes("thXis text"), `the click never arrived: ${JSON.stringify(row1.trim())}`);
});

test("a drag delivered as bytes selects rather than moving the caret", async () => {
  // The other half: press and release in DIFFERENT cells is a selection, and must not be
  // treated as a click that flings the caret to wherever the pointer was let go. What
  // proves it is that the next character REPLACES what was dragged over, rather than
  // being inserted at the release point with the dragged text left intact.
  const h = await harness();
  await h.type("drag over these words");
  const at = findOnScreen("these");
  assert.ok(at);

  await h.mouse(`\x1b[<0;${at.x + 1};${at.y + 1}M`);
  await h.mouse(`\x1b[<32;${at.x + 5};${at.y + 1}M`);
  await h.mouse(`\x1b[<0;${at.x + 5};${at.y + 1}m`);
  await h.type("!");

  const row = await settledRow(at.y);
  assert.ok(row.includes("drag over ! words"), `a drag did not select: ${JSON.stringify(row.trim())}`);
  assert.ok(!row.includes("these"), `the dragged text survived being typed over: ${JSON.stringify(row.trim())}`);
});

test("clicking AGAIN works, with the caret already mid-text", async () => {
  // The case that shipped broken. Every click test above starts with the caret at the end
  // of the line, and there the caret's column falls after all the text, so the row on
  // screen still begins with the buffer's text and a naive match lands. Move the caret
  // into the middle and the row is that text with a column inserted partway through: from
  // then on nothing matched, and every later click was ignored.
  const h = await harness();
  await h.type("aaaa adasdasd asd asdas");

  const first = findOnScreen("adasdasd");
  assert.ok(first, "the typed text never reached the screen");
  h.click(first.x, first.y);
  await new Promise((r) => setTimeout(r, 60));

  // Second click, now that the caret sits mid-line rather than at the end.
  const second = findOnScreen("asdas ");
  assert.ok(second, "the row moved unexpectedly");
  h.click(second.x + 1, second.y);
  await h.type("X");

  const row = await settledRow(second.y);
  assert.ok(row.includes("aXsd"), `the second click was ignored: ${JSON.stringify(row.trim())}`);
});

test("a click lands on the same character whether the caret is before or after it", async () => {
  // The caret's column must not be counted as text. If it were, a click to the RIGHT of
  // the caret would land one character off, and the error would only appear once the
  // cursor had been moved somewhere earlier in the line.
  const h = await harness();
  await h.type("abcdefgh");
  const at = findOnScreen("abcdefgh");
  assert.ok(at);

  // Put the caret after "a". It takes NO column — it is the terminal's own cursor now,
  // parked between cells — so the row still reads abcdefgh and every letter stays where
  // it was. That is the property under test: moving the caret must not shift the text.
  h.click(at.x + 1, at.y);
  await new Promise((r) => setTimeout(r, 60));

  // "f" is still at column +5, exactly where it was before the caret moved.
  h.click(at.x + 5, at.y);
  await h.type("*");

  const row = await settledRow(at.y);
  assert.ok(row.includes("abcde*f"), `the click landed off by one: ${JSON.stringify(row.trim())}`);
});

test("one Backspace deletes a selection made with the mouse", async () => {
  // Selecting text and pressing one key to remove it is what selecting text is FOR, and
  // it did not work: the highlight was a copy of what was on screen and had no connection
  // to the buffer, so Backspace still took a single character.
  const h = await harness();
  await h.type("keep this DELETEME keep that");
  const at = findOnScreen("DELETEME");
  assert.ok(at, "the typed text never reached the screen");

  // Drag across the word, as a terminal reports it: 1-based, press then move then release.
  const row = at.y + 1;
  await h.mouse(`\x1b[<0;${at.x + 1};${row}M`);
  await h.mouse(`\x1b[<32;${at.x + 8};${row}M`);
  await h.mouse(`\x1b[<0;${at.x + 8};${row}m`);

  await h.mouse("\x7f"); // one Backspace
  await new Promise((r) => setTimeout(r, 60));

  const after = await settledRow(at.y);
  assert.ok(!after.includes("DELETEME"), `the selection survived Backspace: ${JSON.stringify(after.trim())}`);
  assert.ok(after.includes("keep this"), `it took too much: ${JSON.stringify(after.trim())}`);
  assert.ok(after.includes("keep that"), `it took too much: ${JSON.stringify(after.trim())}`);
});

test("typing over a selection replaces it", async () => {
  const h = await harness();
  await h.type("alpha REPLACEME omega");
  const at = findOnScreen("REPLACEME");
  assert.ok(at);

  const row = at.y + 1;
  await h.mouse(`\x1b[<0;${at.x + 1};${row}M`);
  await h.mouse(`\x1b[<32;${at.x + 9};${row}M`);
  await h.mouse(`\x1b[<0;${at.x + 9};${row}m`);
  await h.type("X");

  const after = await settledRow(at.y);
  assert.ok(after.includes("alpha X omega"), `not replaced: ${JSON.stringify(after.trim())}`);
});

test("moving the caret drops the selection, so the next Backspace is one character", async () => {
  // A selection is something you are about to act on, not a mode. Once the cursor moves,
  // a range recorded against the old position must not still be armed.
  const h = await harness();
  await h.type("one two three");
  const at = findOnScreen("two");
  assert.ok(at);

  const row = at.y + 1;
  await h.mouse(`\x1b[<0;${at.x + 1};${row}M`);
  await h.mouse(`\x1b[<32;${at.x + 3};${row}M`);
  await h.mouse(`\x1b[<0;${at.x + 3};${row}m`);

  // Click elsewhere (a press and release in one cell), which moves the caret.
  const end = at.x + 12;
  await h.mouse(`\x1b[<0;${end};${row}M`);
  await h.mouse(`\x1b[<0;${end};${row}m`);
  await h.mouse("\x7f");
  await new Promise((r) => setTimeout(r, 60));

  const after = await settledRow(at.y);
  assert.ok(after.includes("two"), `the stale selection was deleted: ${JSON.stringify(after.trim())}`);
});
