/**
 * inkThrottlePatch.test.ts — Ink gets the same `throttle`, from the one file that holds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchInkThrottle, STOCK_THROTTLE_IMPORT } from "./inkThrottlePatch.js";

// The package exports only its entry point, so find its folder from there.
const inkEntry = fileURLToPath(import.meta.resolve("ink"));
const inkFile = inkEntry.replace(/index\.js$/, "ink.js");
const inkUrl = pathToFileURL(inkFile).href;

test("the installed Ink still has the import this replaces, and the patch finds the module", () => {
  // Fails on purpose when Ink changes the line: then the speedup is lost and this says so.
  const source = readFileSync(inkFile, "utf8");
  assert.ok(source.includes(STOCK_THROTTLE_IMPORT), "Ink no longer imports throttle the way the patch expects");
  const patched = patchInkThrottle(source, inkUrl);
  assert.ok(patched, "the throttle module was not found next to Ink");
  assert.ok(!patched.includes("es-toolkit/compat'"), "the stock import is still there");
  assert.match(patched, /import \{ throttle \} from 'file:\/\/\/.*es-toolkit\/dist\/compat\/function\/throttle\.mjs';/);
});

test("the patched import is the same function the stock import gives", async () => {
  const patched = patchInkThrottle(readFileSync(inkFile, "utf8"), inkUrl)!;
  const target = /from '(file:[^']+)'/.exec(patched)![1]!;
  const viaIndex = (await import("es-toolkit/compat")).throttle;
  const direct = (await import(target)).throttle;
  assert.equal(direct, viaIndex);
});

test("a changed import, a missing module, or the off switch leaves the text alone", () => {
  assert.equal(patchInkThrottle("import { throttle } from 'somewhere-else';", inkUrl), null);
  assert.equal(patchInkThrottle(STOCK_THROTTLE_IMPORT, pathToFileURL("C:/nowhere/node_modules/ink/build/ink.js").href), null);
  const before = process.env["MINDWEAVE_NO_INK_PATCH"];
  process.env["MINDWEAVE_NO_INK_PATCH"] = "1";
  try {
    assert.equal(patchInkThrottle(readFileSync(inkFile, "utf8"), inkUrl), null);
  } finally {
    if (before === undefined) delete process.env["MINDWEAVE_NO_INK_PATCH"];
    else process.env["MINDWEAVE_NO_INK_PATCH"] = before;
  }
});
