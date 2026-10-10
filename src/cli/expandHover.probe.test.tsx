/**
 * expandHover.probe.test.tsx — a row that can be pressed lights up under the pointer.
 *
 * What lights up is the FRAME around the text: the rail or branch mark beside it, the line
 * that says it can be pressed, and the verb. The text itself keeps its colours, so a diff
 * is still a diff while the pointer is on it. Colour has to be on for any of that to be
 * visible, so this sets it before anything that reads it is loaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
process.env.COLORTERM = "truecolor";
const { render } = await import("ink");
const { ToolLine } = await import("./components/ToolLine.js");

const COLUMNS = 80;
const ESC = String.fromCharCode(27);

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

const SHORT = "$ ls\nfile1\n✓ 0 · 5ms";
const LONG = ["$ ls", ...Array.from({ length: 40 }, (_, i) => `file${i}`), "✓ 0 · 5ms"].join("\n");

function draw(hovered: boolean): string {
  const stdout = new FakeStdout();
  const instance = render(
    <ToolLine id={1} name="Run" arg="ls" status="ok" action="run" detail={SHORT} detailKind="shell" columns={COLUMNS} full={LONG} expanded={false} hovered={hovered} />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: fakeStdin(), patchConsole: false, interactive: true, debug: true },
  );
  const raw = stdout.frames.at(-1) ?? "";
  instance.unmount();
  return raw;
}

/** The SGR codes written immediately before the first occurrence of `glyph`. */
function codesBefore(raw: string, glyph: string): string[] {
  const at = raw.indexOf(glyph);
  assert.ok(at > 0, `${glyph} is not on screen`);
  const codes: string[] = [];
  const re = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");
  for (const m of raw.slice(0, at).matchAll(re)) codes.push(m[1]!);
  return codes;
}

test("the rail beside the output does not change under the pointer", () => {
  const dimLast = (raw: string) => {
    const codes = codesBefore(raw, "│");
    // The most recent of "2" (dim on) and "22" (dim off) before the rail says which it is in.
    for (let i = codes.length - 1; i >= 0; i--) {
      if (codes[i] === "2") return true;
      if (codes[i] === "22" || codes[i] === "0") return false;
    }
    return false;
  };
  assert.equal(dimLast(draw(false)), true, "at rest the rail is dim");
  assert.equal(dimLast(draw(true)), true, "and it stays dim under the pointer");
});

test("the one line that says the row can be pressed goes bold under the pointer, and says the same thing", () => {
  const rest = draw(false);
  const lit = draw(true);
  assert.ok(rest.includes("▸ click to show all 42 lines") && lit.includes("▸ click to show all 42 lines"));
  const bold = (raw: string) => {
    // The latest weight code before the line: bold on is 1, dim on is 2, and 22 / 0 end either.
    const codes = codesBefore(raw, "▸ click");
    for (let i = codes.length - 1; i >= 0; i--) {
      if (codes[i] === "1") return true;
      if (codes[i] === "2" || codes[i] === "22" || codes[i] === "0") return false;
    }
    return false;
  };
  assert.equal(bold(rest), false);
  assert.equal(bold(lit), true);
});

test("lighting a row changes colours only, never what is drawn or how many rows it takes", () => {
  const strip = (raw: string) => raw.replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"), "");
  assert.equal(strip(draw(true)), strip(draw(false)));
});

test("the verb of a row that can be pressed does not change under the pointer, and nothing is underlined", () => {
  const rest = draw(false);
  const lit = draw(true);
  const weight = (raw: string) => codesBefore(raw, "Run").join(",");
  assert.equal(weight(rest), weight(lit), "the verb is drawn the same either way");
  assert.ok(!rest.includes(`${ESC}[4m`) && !lit.includes(`${ESC}[4m`), "nothing is underlined");
});

test("the commands row is dimmer at rest and bright under the pointer, with no underline", async () => {
  const { WorkGroup } = await import("./components/WorkGroup.js");
  const items = [{ toolId: "a", name: "Run", arg: "ls", status: "ok" as const, detail: "$ ls\n✓ 0 · 5ms", detailKind: "shell" as const }];
  const drawGroup = (hovered: boolean) => {
    const stdout = new FakeStdout();
    const instance = render(<WorkGroup id={5} items={items} columns={COLUMNS} hovered={hovered} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: fakeStdin(),
      patchConsole: false,
      interactive: true,
      debug: true,
    });
    const raw = stdout.frames.at(-1) ?? "";
    instance.unmount();
    return raw;
  };
  const dimBefore = (raw: string) => {
    const codes = codesBefore(raw, "Ran");
    for (let i = codes.length - 1; i >= 0; i--) {
      if (codes[i] === "2") return true;
      if (codes[i] === "22" || codes[i] === "0") return false;
    }
    return false;
  };
  assert.equal(dimBefore(drawGroup(false)), true);
  assert.equal(dimBefore(drawGroup(true)), false);
  assert.ok(!/\x1b\[4m/.test(drawGroup(true)));
});
