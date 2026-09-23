/**
 * vision.test.ts — V4.1 Flash and its native image input.
 *
 * Vision began as a separate `deepseek-v4-flash-vision-exp` model (2026-08-21). V4.1
 * Flash folded it into the base model, so the interesting facts moved: Flash itself
 * now reads images, and the old vision id survives only as an alias. The wire test at
 * the bottom is the one that has always mattered — `images` is our own field, and a
 * transport that spread it onto the request untouched sent a request that looked well
 * formed while the bytes never left the machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptsImages,
  contextWindow,
  normalize,
  price,
  thinkLevels,
  MODELS,
  FLASH,
  PRO,
  VISION_LEGACY,
} from "./manifest.js";
import { modelsOf } from "../registry.js";
import type { DriverManifest, ModelChoice } from "../types.js";
import { toWireMessages } from "../openaiCompat/wire.js";

test("Flash is the default and reads images; Pro does not", () => {
  assert.equal(MODELS[0]!.id, FLASH, "the first entry is the default");
  assert.equal(acceptsImages(FLASH), true);
  // Core degrades before sending when this is false, so a wrong answer here is the
  // difference between a clear message and a silently text-only attachment.
  assert.equal(acceptsImages(PRO), false);
});

test("the old vision id is an alias for Flash, not a model of its own", () => {
  assert.ok(!MODELS.some((m) => m.id === VISION_LEGACY), "it must not appear in /model");
  assert.equal(normalize({ model: VISION_LEGACY, thinking: false, effort: "high" }).model, FLASH);
});

test("both models expose the full reasoning ladder", () => {
  assert.deepEqual(thinkLevels(FLASH).map((l) => l.label), ["Standard", "High", "Maximum"]);
  assert.deepEqual(thinkLevels(PRO).map((l) => l.label), ["Standard", "High", "Maximum"]);
});

test("Flash is sized as its own model, not borrowed from Pro", () => {
  assert.notEqual(contextWindow(FLASH), contextWindow(PRO));
  assert.ok(price(FLASH).output > 0);
});

test("V4 Pro is an ordinary offered model, not retiring", () => {
  const pro = MODELS.find((m) => m.id === PRO)!;
  // Pro was expected to fold into Flash on 2026-09-14; DeepSeek's own docs confirm it
  // did not, so it carries no `until` — see the manifest's file header for the source.
  assert.equal(pro.until, undefined, "Pro is not scheduled to retire");
});

test("the registry drops a model once its `until` date passes", () => {
  // Generic behaviour of `modelsOf`'s retirement filter, exercised on a synthetic
  // manifest rather than a real model — a model whose `until` is in the past is
  // filtered out, one in the future is kept.
  const fake = {
    id: "fake",
    models: [
      { id: "keep", label: "keep", description: "" },
      { id: "gone", label: "gone", description: "", until: 1 },
      { id: "future", label: "future", description: "", until: Date.now() + 1_000_000 },
    ] as ModelChoice[],
  } as DriverManifest;
  assert.deepEqual(modelsOf(fake).map((m) => m.id), ["keep", "future"]);
});

test("an image actually reaches the wire, in the shape DeepSeek documents", () => {
  const [wire] = toWireMessages([
    {
      role: "user",
      content: "what is in this screenshot?",
      images: [{ path: "D:/shot.png", mediaType: "image/png", data: "AAAB" }],
    },
  ]) as { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] }[];

  assert.ok(Array.isArray(wire.content), "a message with images sends parts, not a bare string");
  assert.deepEqual(wire.content[0], { type: "text", text: "what is in this screenshot?" });
  // The text part comes first and is always present: a message that is only an image
  // reads as an attachment with no question attached to it.
  assert.deepEqual(wire.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } });
  // `images` is ours, not theirs. Leaving it on the request is how the picture used
  // to go nowhere while the request still looked well formed.
  assert.ok(!("images" in wire), "our own field must not be sent");
});

test("a message with no images is unchanged", () => {
  const [wire] = toWireMessages([{ role: "user", content: "plain text" }]) as { content: unknown }[];
  assert.equal(wire.content, "plain text", "no needless array for the ordinary case");
});

test("tool calls still survive the same path", () => {
  const [wire] = toWireMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
  ]) as { tool_calls: { id: string }[] }[];
  assert.equal(wire.tool_calls[0]!.id, "c1");
});
