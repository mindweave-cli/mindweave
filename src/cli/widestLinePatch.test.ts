/**
 * widestLinePatch.test.ts — the cached width function returns exactly what the original does.
 *
 * The replacement is loaded from a copy written beside the original package, so its own import
 * of `string-width` resolves to the very same module the original uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KNOWN_WIDEST_LINE, PATCHED_WIDEST_LINE, patchWidestLine } from "./widestLinePatch.js";

// The package exports only its entry point, so resolve that and work from its folder.
const originalFile = fileURLToPath(import.meta.resolve("widest-line"));
const pkgDir = dirname(originalFile);

test("the installed widest-line is the one the patch was written against", () => {
  // Fails on purpose when the dependency changes: re-check the replacement, then add the hash.
  const source = readFileSync(originalFile, "utf8");
  assert.equal(patchWidestLine(source), PATCHED_WIDEST_LINE, "unknown widest-line: the patch would not apply");
  assert.equal(patchWidestLine(source + "\n// changed"), null, "a changed file must not be replaced");
  assert.ok(KNOWN_WIDEST_LINE.length > 0);
});

test("the replacement measures every kind of text exactly as the original", async () => {
  const original = (await import(pathToFileURL(originalFile).href)).default as (s: string) => number;
  const copy = join(pkgDir, `index.mwtest-${process.pid}.js`);
  writeFileSync(copy, PATCHED_WIDEST_LINE);
  try {
    const patched = (await import(pathToFileURL(copy).href)).default as (s: string) => number;
    const samples = [
      "", "a", "hello world", "line one\nline two that is longer\nthree",
      "\x1b[1mbold\x1b[22m and \x1b[38;2;82;191;146mjade\x1b[39m",
      "日本語のテキスト", "한국어 문장", "emoji 👍🏽 🧑‍💻 🇯🇵 ❤️ done", "combining é ä ñ",
      "tabs\tand  spaces", "│ ⎿ ● ✓ ✖ — …", "x".repeat(500), "wide\n" + "全角".repeat(40),
    ];
    // Random mixes of the same pieces, many times, so a cache hit is exercised too.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 400; i++) {
      const parts = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => samples[Math.floor(rnd() * samples.length)]!);
      samples.push(parts.join(rnd() < 0.3 ? "\n" : " "));
    }
    for (const round of [1, 2]) {
      for (const s of samples) assert.equal(patched(s), original(s), `round ${round}: ${JSON.stringify(s.slice(0, 40))}`);
    }
  } finally {
    unlinkSync(copy);
  }
});
