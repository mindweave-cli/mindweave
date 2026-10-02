/**
 * inlineShell.probe.test.tsx — the inline shell, rendered for real.
 *
 * The unit tests prove the mode is parsed and the terminal is moved in the right order.
 * Neither can prove the thing the shell exists for: that finished blocks are printed ONCE
 * into the terminal's scrollback and never touched again. That claim is only observable
 * from the bytes, and it is the whole performance argument — if committed blocks are
 * reprinted on every frame, the inline shell is slower than the one it replaces rather
 * than faster.
 *
 * The traps are the ones every probe in this directory has: stdout must claim `isTTY` or
 * Ink takes its non-interactive path and renders once, and nothing may sleep a fixed
 * amount waiting for a frame.
 */
process.env["FORCE_COLOR"] = "0";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { useEffect, useState } from "react";
import { Box, Static, Text, render } from "ink";
import { BlockView } from "./components/BlockView.js";
import type { Block } from "./transcript.js";

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = true;
  writes: string[] = [];
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
}

function fakeStdin(): NodeJS.ReadStream {
  const s = new EventEmitter() as unknown as NodeJS.ReadStream;
  (s as unknown as { isTTY: boolean }).isTTY = false;
  (s as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (s as unknown as { ref: () => void }).ref = () => {};
  (s as unknown as { unref: () => void }).unref = () => {};
  return s;
}

function block(id: number, text: string): Block {
  return { id, kind: "assistant", done: true, text } as Block;
}

/** Everything written, with escape sequences removed — what a reader would see. */
function printed(out: FakeStdout): string {
  // eslint-disable-next-line no-control-regex
  return out.writes.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** The inline shell's shape: committed to <Static>, the tail live below it. */
function Shell({ onReady }: { onReady: (commit: (b: Block) => void) => void }) {
  const [committed, setCommitted] = useState<Block[]>([block(1, "FIRST")]);
  useEffect(() => {
    onReady((b) => setCommitted((c) => [...c, b]));
  }, [onReady]);
  return (
    <Box flexDirection="column">
      <Static items={committed}>{(b) => <BlockView key={b.id} block={b} columns={80} />}</Static>
      <Box flexDirection="column">
        <Text>LIVE-TAIL</Text>
      </Box>
    </Box>
  );
}

async function mount() {
  const stdout = new FakeStdout();
  let commit!: (b: Block) => void;
  const ready = new Promise<void>((res) => {
    render(<Shell onReady={(f) => { commit = f; res(); }} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    });
  });
  await ready;
  await new Promise((r) => setImmediate(r));
  return { stdout, commit: (b: Block) => commit(b) };
}

test("a committed block is printed once and never reprinted", async () => {
  // The whole argument for this shell. If <Static> is reprinting, the cost of a frame
  // grows with the length of the conversation again, which is the problem it exists to
  // not have.
  const { stdout, commit } = await mount();
  const before = (printed(stdout).match(/FIRST/g) ?? []).length;
  assert.ok(before >= 1, "the first block never reached the terminal");

  for (let i = 2; i <= 6; i++) {
    commit(block(i, `BLOCK-${i}`));
    await new Promise((r) => setImmediate(r));
  }

  const after = (printed(stdout).match(/FIRST/g) ?? []).length;
  assert.equal(after, before, `the first block was reprinted ${after - before} more times as five blocks landed`);
});

test("every committed block reaches the terminal exactly once", async () => {
  const { stdout, commit } = await mount();
  for (let i = 2; i <= 5; i++) {
    commit(block(i, `BLOCK-${i}`));
    await new Promise((r) => setImmediate(r));
  }
  const text = printed(stdout);
  for (let i = 2; i <= 5; i++) {
    const seen = (text.match(new RegExp(`BLOCK-${i}`, "g")) ?? []).length;
    assert.equal(seen, 1, `BLOCK-${i} was printed ${seen} times`);
  }
});

test("the live tail is what gets re-rendered, and it stays below the history", async () => {
  const { stdout, commit } = await mount();
  commit(block(9, "LATEST"));
  await new Promise((r) => setImmediate(r));
  const text = printed(stdout);
  assert.ok(text.includes("LIVE-TAIL"), "the live region never rendered");
  assert.ok(
    text.lastIndexOf("LIVE-TAIL") > text.indexOf("LATEST"),
    "the tail was printed above the block that had just been committed",
  );
});

// ── arriving from the fullscreen shell ───────────────────────────────────────

test("remounting <Static> reprints the WHOLE conversation", async () => {
  // The bug this fixes, exactly: <Static> keeps a count of how many items it has emitted
  // and renders only `items.slice(index)`. Everything it had printed went into the
  // ALTERNATE screen buffer, which leaving discards — so the primary buffer came back
  // with no banner and no history, and the transcript survived only in that counter.
  const stdout = new FakeStdout();
  let remount!: () => void;
  const items = [block(1, "EARLIER-ONE"), block(2, "EARLIER-TWO")];

  function Switcher({ onReady }: { onReady: (f: () => void) => void }) {
    const [epoch, setEpoch] = useState(0);
    useEffect(() => {
      onReady(() => setEpoch((n) => n + 1));
    }, [onReady]);
    return (
      <Box flexDirection="column">
        <Static key={epoch} items={items}>{(b) => <BlockView key={b.id} block={b} columns={80} />}</Static>
      </Box>
    );
  }

  const ready = new Promise<void>((res) => {
    render(<Switcher onReady={(f) => { remount = f; res(); }} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    });
  });
  await ready;
  await new Promise((r) => setImmediate(r));

  // Stand in for the switch: everything printed so far went to a buffer that is now gone.
  stdout.writes.length = 0;
  remount();
  await new Promise((r) => setImmediate(r));

  const text = printed(stdout);
  assert.match(text, /EARLIER-ONE/, "the history was not reprinted — it exists only in a discarded buffer");
  assert.match(text, /EARLIER-TWO/, "only part of the history was reprinted");
});

test("a string sentinel and real blocks share one <Static> list", async () => {
  // How the header rides along: it is item zero of the same list, so it prints exactly
  // once and scrolls away with the conversation instead of being redrawn above every
  // frame. Ink renders each item through one function, so the two shapes have to coexist
  // in a single array — worth pinning, because a header that silently stops rendering
  // looks like the app losing its history rather than one branch of a callback.
  const BANNER = "__banner__" as const;
  const stdout = new FakeStdout();
  const items: Array<typeof BANNER | Block> = [BANNER, block(1, "FIRST-BLOCK")];
  const app = render(
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => (item === BANNER ? <Text key="b">HEADER-LINE</Text> : <BlockView key={item.id} block={item} columns={80} />)}
      </Static>
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    },
  );
  await new Promise((r) => setImmediate(r));
  app.unmount();
  const text = printed(stdout);
  assert.match(text, /HEADER-LINE/, "the header never printed");
  assert.match(text, /FIRST-BLOCK/, "the blocks beside it never printed");
});

test("the app's inline branch renders the header, not the live status banner", async () => {
  // Mechanical, because the two are easy to confuse and only one can be right. The
  // fullscreen banner is a live bar — mode, model, whether a turn is running — and
  // <Static> prints once and never touches it again, so all three would freeze at
  // whatever they were when the session opened. A header that quietly lies about which
  // model is answering is worse than no header.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  // The LAST occurrence: the first is the effect that keeps the terminal cursor down,
  // which tests the same condition and is not the render branch.
  const at = app.lastIndexOf('if (shell === "inline")');
  const branch = app.slice(at, at + 2000);
  assert.ok(branch.length > 0, "the inline branch is gone");
  // `staticEpoch` must take part in the key — it is what remounts the list on the shell
  // switch, and without a remount the history stays in the buffer that was discarded.
  // Matched loosely because a second counter shares the key: closing the inline reading
  // view also has to remount, at a different moment (see readingClose.probe.test.tsx).
  assert.match(branch, /key=\{[^}]*staticEpoch/, "the list is not remounted on the switch, so history stays in the discarded buffer");
  assert.match(branch, /FILL_ITEM/, "the startup fill is gone, so the first screen sits at the top of the window");
  // The reprint must START at `reprintFrom`, never at zero. An END argument is allowed
  // and is how the reading viewport holds the printer (see readingClose.probe.test.tsx),
  // so only the start is pinned here.
  assert.match(
    branch,
    /committed\.slice\(\s*reprintFrom\.current\s*[,)]/,
    "the whole session is being reprinted again — a third of a second of blank screen on a long one",
  );
  assert.match(branch, /BANNER_ITEM/, "the header no longer rides in the list");
  assert.match(branch, /<InlineHeader/, "the inline branch is drawing the live status banner into scrollback");
});

// ── the prompt stays at the bottom when the palette closes ───────────────────


// ── entering the shell: bounded reprint, and content that lands at the bottom ──

test("the reprint is BOUNDED, not the whole session", async () => {
  // Measured at about 1.7ms per fresh block, so reprinting a long session spent a third of
  // a second on a blank screen printing scrollback nobody asked to see — and all of it was
  // in the alternate buffer, which leaving discards, so none of it can be recovered
  // anyway. A couple of screens is all that can be looked at.
  const stdout = new FakeStdout();
  const all = Array.from({ length: 100 }, (_, i) => block(i + 1, `BLOCK-${i + 1}`));
  const from = Math.max(0, all.length - 40);
  const app = render(
    <Box flexDirection="column">
      <Static items={all.slice(from)}>{(b) => <BlockView key={b.id} block={b} columns={80} />}</Static>
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    },
  );
  await new Promise((r) => setImmediate(r));
  app.unmount();
  const text = printed(stdout);
  assert.match(text, /BLOCK-100/, "the most recent block was not reprinted");
  assert.match(text, /BLOCK-61/, "the reprint did not reach back a full window");
  assert.doesNotMatch(text, /BLOCK-1\b/, "the whole session was reprinted");
});

test("blank rows push the first screen down to the bottom", async () => {
  // A terminal prints from wherever the cursor is, which after leaving the alternate
  // screen is wherever the shell left it — usually near the top, with the prompt then
  // floating in the middle of an empty window.
  const stdout = new FakeStdout();
  const FILL = "__fill__" as const;
  const app = render(
    <Box flexDirection="column">
      <Static items={[FILL, block(1, "FIRST-LINE")] as Array<typeof FILL | Block>}>
        {(item) => (item === FILL ? <Box key="f" height={16} /> : <BlockView key={item.id} block={item} columns={80} />)}
      </Static>
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    },
  );
  await new Promise((r) => setImmediate(r));
  app.unmount();
  const rows = printed(stdout).split("\n");
  const at = rows.findIndex((r) => r.includes("FIRST-LINE"));
  assert.ok(at >= 16, `the conversation started at row ${at}, so it is still pinned to the top`);
});

test("a width change reprints instead of trusting the erase count", async () => {
  // Ink redraws its live region by erasing the number of LINES it last wrote. After a
  // resize that number is wrong — the same content wraps differently at the new width, and
  // the terminal has already reflowed what is on screen — so it erases too few and leaves
  // half the old region behind: a second status line, a fragment of the input border.
  //
  // Mechanical, because the artifact lives in a real terminal's reflow, which a fake
  // stdout does not do. What can be checked is that the app does not try to be clever
  // about the wrapping, and reprints.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const at = app.indexOf("const widthBefore = useRef(width);");
  assert.ok(at > 0, "the width-change branch is gone");
  const effect = app.slice(at, at + 700);
  assert.match(effect, /setStaticEpoch/, "a width change no longer reprints");
  assert.match(effect, /startFill\.current/, "the reprint does not refill, so it lands at the top of the window");
  assert.match(effect, /shell !== "inline"/, "the fullscreen shell is being reprinted too — it repaints itself");
  // Width only. Height changes re-wrap nothing, and reprinting on one would fire on every
  // vertical drag for nothing at all.
  assert.match(effect, /\[width, shell\]/, "the reprint is not keyed to the width alone");
});

test("the resize poll goes through the shared handler, not straight to the read", async () => {
  // Reading straight from the interval sampled a drag every 250ms at whatever width the
  // window was passing through, and each sample was a re-render that left another stale
  // copy behind — one slow drag, a ladder of half-drawn input boxes.
  //
  // What has to hold is that the poll and the resize EVENT share one handler, so the
  // poll inherits whichever policy the current shell is using. The interval itself is
  // now a named constant, and whether that handler defers is the shell's business —
  // `resizePolicy.probe.test.tsx` drives that behaviourally rather than by reading source.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  // The poll runs `onPoll`, which hands a deferring shell to the shared handler (and never
  // restarts a settle wait already running, or the read would be postponed for ever).
  assert.match(app, /setInterval\(\s*onPoll\s*,/, "the poll no longer goes through onPoll");
  assert.match(app, /const onPoll = \(\) => \{[\s\S]{0,160}onResize\(\)/, "onPoll bypasses the shared handler again");
  assert.doesNotMatch(app, /setInterval\(\s*read\s*,/, "the poll reads the size directly again");
});


// ── the startup fill has to be decided during the RENDER ────────────────────
//
// `<Static>` prints each item ONCE, in the render that first sees it, and the blank fill
// that pushes the first screen to the bottom of the terminal is one of its items. An
// effect runs after that render has been committed and written, so a height assigned by
// an effect arrives too late by construction — the item is already printed, at whatever
// the ref held during the render, and Static will never render it again.
//
// Set from an effect the fill was printed as ZERO rows on first mount, for its whole
// life: the first screen sat at the top of the terminal with the prompt part-way up and
// empty rows below it, which is exactly what the fill exists to prevent.

test("a fill height assigned by an EFFECT never reaches <Static>", async () => {
  // The shape that was wrong, kept as a test so the reason is not rediscovered. If this
  // ever starts passing, Ink's Static has changed and the render-phase assignment below
  // could be simplified — but nothing else should be read into it.
  const { useEffect, useRef } = await import("react");
  const { Box, Static, Text } = await import("ink");
  const FILL = Symbol("fill");

  function EffectShape(): React.ReactElement {
    const fill = useRef(0);
    useEffect(() => {
      fill.current = 12;
    }, []);
    return (
      <Box flexDirection="column">
        <Static items={[FILL, "note"]}>
          {(item) => (item === FILL ? <Box key="f" height={fill.current} /> : <Text key="n">note</Text>)}
        </Static>
        <Text>FOOTER</Text>
      </Box>
    );
  }

  const stdout = new FakeStdout();
  const instance = render(<EffectShape />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  await new Promise((r) => setTimeout(r, 150));
  const rows = (stdout.writes.at(-1) ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
  instance.unmount();
  assert.equal(rows.findIndex((l) => l.includes("note")), 0, "the effect's height reached Static after all");
});

test("assigned during the render, the fill is printed at its real height", async () => {
  const { useRef } = await import("react");
  const { Box, Static, Text } = await import("ink");
  const FILL = Symbol("fill");

  function RenderShape(): React.ReactElement {
    const fill = useRef(0);
    const done = useRef(false);
    if (!done.current) {
      done.current = true;
      fill.current = 12;
    }
    return (
      <Box flexDirection="column">
        <Static items={[FILL, "note"]}>
          {(item) => (item === FILL ? <Box key="f" height={fill.current} /> : <Text key="n">note</Text>)}
        </Static>
        <Text>FOOTER</Text>
      </Box>
    );
  }

  const stdout = new FakeStdout();
  const instance = render(<RenderShape />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: fakeStdin(),
    patchConsole: false,
    interactive: true,
    debug: true,
  });
  await new Promise((r) => setTimeout(r, 150));
  const rows = (stdout.writes.at(-1) ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
  instance.unmount();
  assert.equal(rows.findIndex((l) => l.includes("note")), 12, "the fill was not printed at its assigned height");
});

