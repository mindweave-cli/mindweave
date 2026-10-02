/**
 * inkOutputPatch.test.ts — the faster Ink `Output` must be indistinguishable from the stock one.
 *
 * The patch replaces the text of one internal Ink module (see inkOutputPatch.ts), so the only
 * thing that makes it safe is proof that it draws the same screen. This renders thousands of
 * randomly generated frames (coloured text, wide characters, overlapping writes, clipping on
 * both axes, writes that run off the edge) through the stock class and through the patched one
 * and requires the same string every time, including on the second and later frames, when the
 * patched class is answering from its caches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { KNOWN_ORIGINALS, PATCHED_OUTPUT, patchInkOutput } from "./inkOutputPatch.js";

const inkOutputUrl = new URL("./output.js", import.meta.resolve("ink"));
const stockSource = readFileSync(fileURLToPath(inkOutputUrl), "utf8");

type Ctor = new (o: { width: number; height: number }) => {
  write(x: number, y: number, text: string, o: { transformers: ((s: string, i: number) => string)[] }): void;
  clip(c: { x1?: number; x2?: number; y1?: number; y2?: number }): void;
  unclip(): void;
  get(): { output: string; height: number };
};

const here = dirname(fileURLToPath(import.meta.url));
const tmpFile = join(here, `.inkOutputPatch.${process.pid}.tmp.mjs`);

async function loadBoth(): Promise<{ stock: Ctor; patched: Ctor }> {
  const stock = ((await import(inkOutputUrl.href)) as { default: Ctor }).default;
  // Written beside this file so its bare imports (slice-ansi, string-width, ...) resolve exactly
  // as they do for the stock module.
  writeFileSync(tmpFile, PATCHED_OUTPUT, "utf8");
  const patched = ((await import(pathToFileURL(tmpFile).href)) as { default: Ctor }).default;
  return { stock, patched };
}

/** A small deterministic generator, so a failure can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PIECES = ["hello", "world", "  ", "│", "─", "●", "你好", "日本語", "é", "👍", "á", "x", "0123456789", "\u001b[31mred\u001b[39m", "\u001b[1mbold\u001b[22m", "\u001b[48;5;17mbg\u001b[49m", "\u001b[38;2;10;200;30mrgb\u001b[39m"];
const TRANSFORMS: ((s: string, i: number) => string)[][] = [
  [],
  [(s) => `\u001b[2m${s}\u001b[22m`],
  [(s, i) => (i % 2 ? `\u001b[7m${s}\u001b[27m` : s)],
  [(s) => s.toUpperCase(), (s) => `\u001b[36m${s}\u001b[39m`],
];

function frame(rand: () => number, W: number, H: number): { ops: Array<() => void>; apply(o: InstanceType<Ctor>): void } {
  const spec: Array<(o: InstanceType<Ctor>) => void> = [];
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const n = 4 + Math.floor(rand() * 14);
  for (let k = 0; k < n; k++) {
    const kind = rand();
    if (kind < 0.18) {
      const x1 = Math.floor(rand() * W * 0.6);
      const y1 = Math.floor(rand() * H * 0.6);
      const clip = rand() < 0.5 ? { x1, x2: x1 + 3 + Math.floor(rand() * W), y1, y2: y1 + 1 + Math.floor(rand() * H) } : rand() < 0.5 ? { x1, x2: x1 + 5 + Math.floor(rand() * W) } : { y1, y2: y1 + 1 + Math.floor(rand() * H) };
      spec.push((o) => o.clip(clip));
      const inner = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < inner; i++) spec.push(makeWrite());
      spec.push((o) => o.unclip());
    } else spec.push(makeWrite());
  }
  function makeWrite(): (o: InstanceType<Ctor>) => void {
    const lines = 1 + Math.floor(rand() * 4);
    const text = Array.from({ length: lines }, () => Array.from({ length: 1 + Math.floor(rand() * 5) }, () => pick(PIECES)).join(rand() < 0.5 ? " " : "")).join("\n");
    const x = Math.floor(rand() * (W + 6)) - 3;
    const y = Math.floor(rand() * (H + 4)) - 2;
    const transformers = pick(TRANSFORMS);
    return (o) => o.write(x, y, text, { transformers });
  }
  return { ops: [], apply: (o) => spec.forEach((f) => f(o)) };
}

test("the installed Ink is one the patch was written for", () => {
  const hash = createHash("sha256").update(stockSource).digest("hex");
  assert.ok(
    KNOWN_ORIGINALS.includes(hash),
    `ink/build/output.js is ${hash}, which inkOutputPatch.ts does not know. The patch is NOT applied to it (the stock renderer runs). ` +
      "Re-run this file's equivalence tests against the new Ink, then add the hash to KNOWN_ORIGINALS.",
  );
});

test("patchInkOutput applies only to a file it knows, and can be switched off", () => {
  assert.equal(patchInkOutput("export default class Output {}"), null);
  const known = KNOWN_ORIGINALS.includes(createHash("sha256").update(stockSource).digest("hex"));
  if (known) {
    assert.equal(patchInkOutput(stockSource), PATCHED_OUTPUT);
    process.env["MINDWEAVE_NO_INK_PATCH"] = "1";
    try {
      assert.equal(patchInkOutput(stockSource), null);
    } finally {
      delete process.env["MINDWEAVE_NO_INK_PATCH"];
    }
  }
});

test("the patched Output draws exactly what the stock one does, frame after frame", async () => {
  const { stock, patched } = await loadBoth();
  try {
    let frames = 0;
    for (const [W, H] of [[40, 12], [17, 5], [80, 24], [3, 3]] as const) {
      const rand = rng(W * 1000 + H);
      for (let i = 0; i < 250; i++) {
        const f = frame(rand, W, H);
        const a = new stock({ width: W, height: H });
        const b = new patched({ width: W, height: H });
        f.apply(a);
        f.apply(b);
        const want = a.get();
        const got = b.get();
        assert.deepEqual(got, want, `frame ${i} at ${W}x${H} differs`);
        frames++;
      }
    }
    assert.equal(frames, 1000);
  } finally {
    rmSync(tmpFile, { force: true });
  }
});

test("a repeated frame, and a frame whose rows moved, are answered from the cache with the same text", async () => {
  const { stock, patched } = await loadBoth();
  try {
    const W = 60;
    const H = 10;
    const lines = Array.from({ length: 40 }, (_, i) => `\u001b[3${(i % 6) + 1}mline ${i} 你好 ${"x".repeat(i % 9)}\u001b[39m`);
    const draw = (C: Ctor, top: number) => {
      const o = new C({ width: W, height: H });
      o.clip({ x1: 0, x2: W, y1: 0, y2: H });
      o.write(0, -top, lines.join("\n"), { transformers: [] });
      o.unclip();
      o.write(0, H - 1, "─".repeat(W), { transformers: [] });
      return o.get();
    };
    // Scrolling through the text one row at a time, three times over: the second and third passes are all cache hits.
    for (let pass = 0; pass < 3; pass++) {
      for (let top = 0; top <= lines.length - H; top++) {
        assert.deepEqual(draw(patched, top), draw(stock, top), `pass ${pass}, offset ${top}`);
      }
    }
  } finally {
    rmSync(tmpFile, { force: true });
  }
});
