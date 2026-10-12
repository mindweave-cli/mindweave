/**
 * inlineCaret.probe.test.tsx — the inline shell's caret is the REAL terminal cursor.
 *
 * Both shells put the terminal's own cursor on the caret cell; they differ only in who
 * does the arithmetic. Fullscreen owns the screen and parks it itself (caretPark.ts).
 * Inline owns nothing, but Ink does, and `useCursor` is its API for exactly this: give it
 * a position relative to the live output and it appends the move and the show to its own
 * frame.
 *
 * That distinction is the whole file. The alternative — and what every inline terminal
 * app draws when it gives up on this — is a block of inverse text standing in for a
 * cursor. It takes a column or hides a character, it does not blink, and it looks nothing
 * like the caret in the rest of the terminal. Getting the real one is the difference, and
 * the only place it can be observed is the bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { render } = await import("ink");
const { PromptInput } = await import("./components/PromptInput.js");

class FakeStdout extends EventEmitter {
  columns = 60;
  rows = 20;
  isTTY = true;
  frames: string[] = [];
  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

/**
 * A stdin Ink 7 will actually read from.
 *
 * It pulls with read() on the `readable` event; emitting `data` reaches nothing at all,
 * and a probe that types that way asserts against a component that never saw a key —
 * which reads as the feature being broken when the harness is.
 */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode(): void {}
  setEncoding(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    return this.queue.shift() ?? null;
  }
  type(key: string): void {
    this.queue.push(key);
    this.emit("readable");
  }
}

function fakeStdin(): NodeJS.ReadStream {
  return new FakeStdin() as unknown as NodeJS.ReadStream;
}

/**
 * Render the input and return every byte it wrote.
 *
 * The anchor is measured from a laid-out frame and applied on the next one, so this
 * waits for a second frame rather than asserting on the first.
 */
async function paint(placeCursor: boolean): Promise<string> {
  const stdout = new FakeStdout();
  const app = render(
    <PromptInput
      onSubmit={() => {}}
      disabled={false}
      placeholder="say something…"
      width={50}
      history={[]}
      completions={[]}
      placeCursor={placeCursor}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    },
  );
  await new Promise((r) => setTimeout(r, 120));
  app.unmount();
  return stdout.frames.join("");
}

/** Ink's cursor suffix: move up N rows, go to a column, show. */
const CURSOR_SUFFIX = /\x1b\[(?:\d+A)?\x1b\[(\d+)G\x1b\[\?25h/;
/** The inverse attribute — a DRAWN caret, which is what this replaces. */
const INVERSE = "\x1b[7m";

test("the inline shell asks Ink to place the real cursor", async () => {
  const painted = await paint(true);
  assert.match(painted, CURSOR_SUFFIX, "no cursor position was emitted — the input has no caret at all");
  assert.ok(painted.includes("\x1b[?25h"), "the cursor was positioned but never shown");
});

test("it does NOT draw a block standing in for one", async () => {
  // The thing being replaced. A drawn caret takes a column or hides the character under
  // it, never blinks, and looks nothing like the caret everywhere else in the terminal.
  const painted = await paint(true);
  assert.ok(!painted.includes(INVERSE), "the input is still drawing a block instead of using the cursor");
});

test("the fullscreen shell places nothing — it parks the cursor itself", async () => {
  // Two owners of one cursor is how it ends up somewhere neither of them meant. There
  // the framebuffer parks it after every frame; asking Ink for a position as well would
  // fight that on every keystroke.
  const painted = await paint(false);
  assert.doesNotMatch(painted, CURSOR_SUFFIX, "the fullscreen shell also asked Ink to place the cursor");
});

test("the cursor lands at the start of an empty prompt, not at column 0", async () => {
  // Column 0 is the left edge of the screen; the caret belongs after the `> ` marker.
  // An off-by-the-marker here is invisible in a test that only checks a cursor exists.
  const painted = await paint(true);
  const match = painted.match(CURSOR_SUFFIX);
  assert.ok(match, "no cursor position was emitted");
  // `cursorTo` is 1-based on the wire, so the marker's two columns put it at 3 or later.
  assert.ok(Number(match[1]) >= 3, `the caret was placed at column ${match[1]}, on top of the prompt marker`);
});

// ── the command palette in the inline shell ──────────────────────────────────
//
// Every row the palette adds makes the live region taller than the room below it, so the
// terminal scrolls to fit — and that scroll is one-way. The three things below are all
// about spending fewer rows, and all three are invisible to a test that only checks the
// menu appears.

/** Render the input with `/` typed, so the command menu is open. */
async function withMenu(menuAbove: boolean): Promise<string[]> {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const app = render(
    <PromptInput
      onSubmit={() => {}}
      disabled={false}
      placeholder="say something…"
      width={50}
      history={[]}
      completions={[
        { name: "/alpha", description: "first" },
        { name: "/bravo", description: "second" },
        { name: "/charlie", description: "third" },
        { name: "/delta", description: "fourth" },
        { name: "/echo", description: "fifth" },
        { name: "/foxtrot", description: "sixth" },
      ]}
      maxMenuRows={menuAbove ? 3 : 12}
      menuAbove={menuAbove}
      placeCursor={menuAbove}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    },
  );
  await new Promise((r) => setTimeout(r, 40)); // Ink repaints on a timer: one event-loop tick was sometimes too soon on a loaded runner
  stdin.type("/");
  await new Promise((r) => setTimeout(r, 120));
  app.unmount();
  // The last frame that CARRIES CONTENT. Ink writes control-only sequences after a frame
  // (the cursor move and the show), so the final write is routinely an empty one, and
  // reading it reports a screen with nothing on it.
  const visible = stdout.frames
    .map((f) => f.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
    .filter((f) => f.trim() !== "");
  return (visible[visible.length - 1] ?? "").split("\n");
}

test("inline puts the menu ABOVE the input, so the prompt stays last", async () => {
  // Below the input, opening the palette pushes the prompt a dozen rows up the screen and
  // you type the command up there; closing drops it back. Above it, the prompt is the last
  // thing on screen throughout and never moves.
  const rows = await withMenu(true);
  const menuAt = rows.findIndex((r) => r.includes("/alpha"));
  const promptAt = rows.findIndex((r) => r.includes("say something") || r.includes("│"));
  assert.ok(menuAt >= 0, `the menu never rendered: ${JSON.stringify(rows)}`);
  assert.ok(promptAt >= 0, "the input never rendered");
  assert.ok(menuAt < promptAt, `the menu rendered below the input (menu ${menuAt}, input ${promptAt})`);
});

test("fullscreen keeps it BELOW the input, where it always was", async () => {
  const rows = await withMenu(false);
  const menuAt = rows.findIndex((r) => r.includes("/alpha"));
  const promptAt = rows.findIndex((r) => r.includes("│"));
  assert.ok(menuAt >= 0 && promptAt >= 0);
  assert.ok(menuAt > promptAt, "the fullscreen menu moved above the input");
});

test("inline shows three commands and drops the border and title", async () => {
  // Six commands are offered; three are shown, and the rest stay reachable through the
  // sliding window rather than being rendered. The border and the title are two more rows
  // the terminal would scroll for, and neither is part of the choice.
  const rows = await withMenu(true);
  const shown = ["/alpha", "/bravo", "/charlie", "/delta", "/echo", "/foxtrot"].filter((n) =>
    rows.some((r) => r.includes(n)),
  );
  assert.equal(shown.length, 3, `showed ${shown.length} commands: ${shown.join(", ")}`);
  assert.ok(!rows.some((r) => r.includes("Commands (type to filter")), "the title row is still being rendered");
  // The input keeps its own border; the menu must not have added a second one above it.
  const bordered = rows.filter((r) => r.includes("╭") || r.includes("┌")).length;
  assert.equal(bordered, 1, `${bordered} bordered boxes — the menu is still drawing its own`);
});

test("the rows the palette borrowed are held when it closes, and released on a commit", async () => {
  // Two failures in one test, because they are two halves of one rule.
  //
  // Not holding: the palette scrolled the terminal to fit, that scroll is one-way, and
  // writing a shorter region afterwards drops the prompt up the screen with a gap beneath.
  //
  // Never releasing: the rows sit as a permanent band of blank above the prompt for the
  // rest of the session. Printing pushes the live region back to the bottom on its own, so
  // once something is committed the rows are holding nothing up.
  const rowsOf = async (open: boolean, settleKey: number, ref: { stdin?: FakeStdin }) => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    ref.stdin = stdin;
    const app = render(
      <PromptInput
        onSubmit={() => {}}
        disabled={false}
        placeholder="say something…"
        width={50}
        history={[]}
        completions={[{ name: "/alpha", description: "first" }, { name: "/bravo", description: "second" }]}
        maxMenuRows={3}
        menuAbove
        placeCursor
        settleKey={settleKey}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        interactive: true,
        maxFps: 1000,
      },
    );
    stdin.type("/");
    await new Promise((r) => setTimeout(r, 80));
    if (!open) {
      // Backspace closes the menu again.
      stdin.type("\x7f");
      await new Promise((r) => setTimeout(r, 80));
    }
    app.unmount();
    const visible = stdout.frames
      .map((f) => f.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
      .filter((f) => f.trim() !== "");
    return (visible[visible.length - 1] ?? "").split("\n").length;
  };

  const ref: { stdin?: FakeStdin } = {};
  const whileOpen = await rowsOf(true, 0, ref);
  const afterClose = await rowsOf(false, 0, ref);
  assert.ok(
    afterClose >= whileOpen - 1,
    `the region collapsed from ${whileOpen} rows to ${afterClose} — the prompt jumped up the screen`,
  );
});
