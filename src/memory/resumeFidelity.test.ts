/**
 * resumeFidelity.test.ts — a resumed row looks like the row that was there live.
 *
 * The failure this guards was visible and quiet at the same time: every edit came back
 * from `/continue` as dim plain lines. The `+` and `-` markers were still there, so the
 * content looked complete; only the green and the red were gone, and the shell blocks
 * had lost their rail. Nothing errored, nothing was missing, and the transcript was
 * simply no longer the transcript.
 *
 * The cause was that a tool result's display fields are stored on its transcript entry
 * so a resume can replay them — and `detailKind`, the field that says whether `detail`
 * is a diff, was not among them. `detail` alone is only text.
 *
 * So this asserts the WHOLE display surface round-trips, by name, rather than checking
 * the one field that happened to break: the next field added to a row will be forgotten
 * here in exactly the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Entry } from "./types.js";

/** Everything about a tool row that decides how it is DRAWN. */
const DISPLAY_FIELDS = ["summary", "detail", "detailFull", "detailKind", "quiet", "isError"] as const;

test("a stored tool entry can carry every field a row is drawn from", () => {
  // Typed, so a field removed from the entry breaks this at compile time rather than
  // at the next resume.
  const entry: Entry = {
    role: "tool",
    toolCallId: "call_1",
    content: "the model's copy",
    summary: "2 edits · L20-146 · -4 +6",
    detail: "- old line\n+ new line",
    detailFull: "- old line\n+ new line\n+ and the rest",
    detailKind: "diff",
    quiet: false,
    isError: false,
  };
  assert.equal(entry.role, "tool");
  for (const field of DISPLAY_FIELDS) {
    assert.ok(field in entry, `${field} cannot be stored, so a resume cannot replay it`);
  }
});

test("the engine writes every display field onto the entry it stores", () => {
  // Read from the source: the write is one object literal in the step loop, and there is
  // nowhere else the stored shape and the renderer's needs meet.
  const engine = readFileSync(fileURLToPath(new URL("../dynamo/engine.ts", import.meta.url)), "utf8");
  // Anchored on the transcript entry specifically. `role: "tool"` also builds the WIRE
  // message, which carries only `content` by design — matching that one instead would
  // report every display field as missing, which is true of it and beside the point.
  const start = engine.indexOf("toolCallId: result.call.id");
  assert.ok(start > 0, "the transcript push has moved; this test is looking at nothing");
  const block = engine.slice(start, engine.indexOf("});", start));
  for (const field of DISPLAY_FIELDS) {
    assert.match(block, new RegExp(`result\\.${field}`), `${field} is never stored, so a resume loses it`);
  }
});

test("the replay hands every stored display field back to the renderer", () => {
  // The other half. Storing a field and not replaying it looks identical from here.
  const app = readFileSync(fileURLToPath(new URL("../cli/App.tsx", import.meta.url)), "utf8");
  const replay = app.slice(app.indexOf("function showResumed"));
  const toolEnd = replay.slice(replay.indexOf('type: "toolEnd"'), replay.indexOf("Close any discovery group"));
  for (const field of DISPLAY_FIELDS) {
    if (field === "isError") continue; // carried as `ok`, inverted, just above
    assert.match(toolEnd, new RegExp(`e\\.${field}`), `${field} is stored but never replayed`);
  }
});
