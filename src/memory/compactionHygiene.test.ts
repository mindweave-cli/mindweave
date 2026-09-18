/**
 * compactionHygiene.test.ts — the long-work context-hygiene additions: condensing
 * old assistant recaps (so finished tasks can't resurface), the aggressive
 * task-boundary keep, and the continuation detector that guards the boundary sweep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { microcompact, isContinuation, estimateEntriesTokens, KEEP_LAST_N_BOUNDARY } from "./compaction.js";
import type { Entry } from "./types.js";

const recap = (text: string): Entry => ({ role: "assistant", content: text });
const userMsg = (text: string): Entry => ({ role: "user", content: text });
const longRecap = "Session 6 delivered the folder tree, context menu, and SVG icons. ".repeat(6);

const note = (text: string): Entry => ({ role: "user", content: text, synthetic: true });

test("old standalone assistant recaps are condensed; recent ones are kept", () => {
  const entries: Entry[] = [
    recap(longRecap), // old, and nobody answered it — should be stubbed
    note("[Background shell #1 finished]"),
    ...Array.from({ length: 8 }, (_, i) => userMsg(`turn ${i}`)),
    recap(longRecap), // within the recent window — kept
  ];
  const { entries: out, recapsCleared } = microcompact(entries, 8);
  assert.equal(recapsCleared, 1, "one old recap condensed");
  assert.notEqual(out[0]!.content, longRecap, "old recap was replaced with a stub");
  assert.equal(out.at(-1)!.content, longRecap, "recent recap untouched");
});

test("short acknowledgements are NOT condensed (only real recaps)", () => {
  const entries: Entry[] = [recap("Done."), ...Array.from({ length: 9 }, (_, i) => userMsg(`t${i}`))];
  const { recapsCleared } = microcompact(entries, 8);
  assert.equal(recapsCleared, 0);
});

test("an assistant message WITH tool calls is never recap-stubbed (keeps tool pairing)", () => {
  const withCalls: Entry = { role: "assistant", content: longRecap, toolCalls: [{ id: "a", name: "read_file", arguments: "{}" }] };
  const entries: Entry[] = [withCalls, ...Array.from({ length: 9 }, (_, i) => userMsg(`t${i}`))];
  const { recapsCleared, entries: out } = microcompact(entries, 8);
  assert.equal(recapsCleared, 0);
  assert.equal(out[0]!.content, longRecap, "narration tied to a tool call is preserved");
});

test("the boundary keep is much tighter than the normal keep", () => {
  assert.ok(KEEP_LAST_N_BOUNDARY < 8);
});

const bigContent = "x".repeat(4000);
// Narrow a union Entry to an assistant's tool calls (throws if it isn't one).
function toolCallsOf(e: Entry) {
  if (e.role === "assistant" && e.toolCalls) return e.toolCalls;
  throw new Error("expected an assistant entry with tool calls");
}
// A write of a whole file, its result, then a LATER tool round so the write is old.
function writeThenLaterRound(): Entry[] {
  return [
    userMsg("build the app shell"),
    { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "src/App.tsx", content: bigContent }) }] },
    { role: "tool", toolCallId: "w1", content: "wrote src/App.tsx (820 lines)" },
    { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ path: "src/x.ts" }) }] },
    { role: "tool", toolCallId: "r1", content: "file body" },
  ];
}

test("old edit/write tool-call INPUTS are cleared once the write is stale", () => {
  const { entries: out, inputsCleared } = microcompact(writeThenLaterRound(), 1);
  assert.equal(inputsCleared, 1, "the stale write's input was cleared");
  const args = JSON.parse(toolCallsOf(out[1]!)[0]!.arguments) as Record<string, unknown>;
  assert.ok(!("content" in args), "the 820-line content payload is gone");
  assert.equal(args.path, "src/App.tsx", "which file was edited is preserved");
  assert.ok(typeof args._cleared === "string", "a cleared marker is left");
});

test("clearing INPUTs is idempotent — a second pass clears nothing", () => {
  const once = microcompact(writeThenLaterRound(), 1);
  const twice = microcompact(once.entries, 1);
  assert.equal(twice.inputsCleared, 0, "already-cleared inputs are left alone");
});

test("a RECENT write keeps its full input (only stale ones are cleared)", () => {
  // keepLastN large enough that the write's result stays in the recent window.
  const { inputsCleared, entries: out } = microcompact(writeThenLaterRound(), 8);
  assert.equal(inputsCleared, 0);
  const args = JSON.parse(toolCallsOf(out[1]!)[0]!.arguments) as Record<string, unknown>;
  assert.equal(args.content, bigContent, "recent write content untouched");
});

test("isContinuation: trivial continuations vs genuine new tasks", () => {
  for (const t of ["continue", "keep going", "go ahead", "yes", "ok", "next", "  proceed  "]) {
    assert.equal(isContinuation(t), true, `"${t}" is a continuation`);
  }
  for (const t of [
    "now add drag and drop between folders",
    "delete the selective-delete feature and add word count",
    "the icons look wrong, redo them as filled shapes instead",
  ]) {
    assert.equal(isContinuation(t), false, `"${t}" is a new task`);
  }
});

// ── image eviction ────────────────────────────────────────────────────────────
// An attached image is the most expensive thing a turn can carry and the most
// perfectly reconstructible, so it evicts on the same window as a tool-result body
// and leaves the file name behind as the key to ask for it again.

const shot = { path: "/tmp/proj/shot.png", mediaType: "image/png", width: 1920, height: 1080 };
const withImage = (text: string): Entry => ({ role: "user", content: text, images: [shot] });

test("an OLD image payload is dropped, leaving the full path as the restoration key", () => {
  const entries: Entry[] = [withImage("look at this"), ...Array.from({ length: 8 }, (_, i) => userMsg(`turn ${i}`))];
  const { entries: out, imagesCleared } = microcompact(entries, 2);

  assert.equal(imagesCleared, 1);
  const first = out[0] as Extract<Entry, { role: "user" }>;
  assert.equal(first.images, undefined, "the payload must be gone from the wire");
  assert.ok(first.content.startsWith("look at this"), "the person's own words are never touched");
  assert.match(first.content, /shot\.png/, "the name stays — it is how the model asks for it again");
  assert.ok(first.content.includes(shot.path), "the full path stays, so the image can be opened again, not guessed at");
  assert.match(first.content, /view_image/, "the stub says how to get it back");
  assert.match(first.content, /no longer in context/);
});

test("a RECENT image is kept — evicting the image the model is working from is the bug", () => {
  const entries: Entry[] = [userMsg("earlier"), withImage("fix what you see here")];
  const { entries: out, imagesCleared } = microcompact(entries, 8);

  assert.equal(imagesCleared, 0);
  assert.deepEqual((out[1] as Extract<Entry, { role: "user" }>).images, [shot]);
});

test("image eviction is idempotent — a second pass neither re-clears nor re-annotates", () => {
  const entries: Entry[] = [withImage("look"), ...Array.from({ length: 8 }, (_, i) => userMsg(`turn ${i}`))];
  const once = microcompact(entries, 2);
  const twice = microcompact(once.entries, 2);

  assert.equal(twice.imagesCleared, 0);
  assert.deepEqual(twice.entries, once.entries, "a stable transcript must stay byte-identical");
});

test("an attached image is COUNTED, not treated as a few characters of path", () => {
  // The failure this guards is silent and expensive: a screenshot is ~40 characters of
  // text and thousands of tokens of context. Counted by its text alone, every
  // compaction bar fires late by exactly the amount that matters most.
  const bare = estimateEntriesTokens([userMsg("look at this")]);
  const withShot = estimateEntriesTokens([withImage("look at this")]);

  assert.ok(withShot - bare > 2000, `a 1080p screenshot must move the estimate (moved ${withShot - bare})`);
});

test("once the payload is evicted, so is its token cost", () => {
  const entries: Entry[] = [withImage("look"), ...Array.from({ length: 8 }, (_, i) => userMsg(`turn ${i}`))];
  const before = estimateEntriesTokens(entries);
  const after = estimateEntriesTokens(microcompact(entries, 2).entries);

  assert.ok(after < before - 2000, "eviction has to show up in the bars, or it bought nothing");
});

// ── superseded transcript copies ──────────────────────────────────────────────

test("a file the working set carries WHOLE is cleared even inside the protected window", () => {
  // The double-representation case: the same file sits in the transcript (a snapshot of
  // what it said when read) and in <working_files> (current by construction). Normally
  // keepLastN and the live-round rule protect recent results so the model is never blind
  // on something it has not acted on — but a file rendered whole at the boundary is the
  // one case where it cannot be blind.
  const entries: Entry[] = [
    { role: "user", content: "look at a.ts" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
    { role: "tool", toolCallId: "c1", content: "export const a = 1;\nexport const b = 2;", fullContentOf: "/p/a.ts" },
  ];

  // Without the signal, the recent result is protected and survives.
  const untouched = microcompact(structuredClone(entries), 5);
  assert.equal(untouched.cleared, 0, "the protection must still hold when nothing supersedes it");

  // With it, the redundant copy goes.
  const swept = microcompact(structuredClone(entries), 5, new Set(["/p/a.ts"]));
  assert.equal(swept.cleared, 1, "a superseded copy must be cleared despite being recent");
  const tool = swept.entries.find((e) => e.role === "tool")!;
  assert.match(tool.content, /cleared|superseded|removed/i, "and leave a navigable stub");
});

test("a batched read is cleared only when EVERY file it carries is superseded", () => {
  // One read_file call can carry several files, so one tool entry can be the transcript's
  // only copy of four of them. Clearing it because one was superseded would drop the
  // other three out from under the model — and it would not even know, because the entry
  // it can still see says "cleared", not "three files you were relying on are gone".
  const entries: Entry[] = [
    { role: "user", content: "look at them" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", arguments: '{"paths":["a.ts","b.ts","c.ts"]}' }],
    },
    {
      role: "tool",
      toolCallId: "c1",
      content: "contents of a, b and c",
      fullContentOf: ["/p/a.ts", "/p/b.ts", "/p/c.ts"],
    },
  ];

  const partial = microcompact(structuredClone(entries), 5, new Set(["/p/a.ts"]));
  assert.equal(partial.cleared, 0, "clearing on one of three would lose the other two");

  const all = microcompact(structuredClone(entries), 5, new Set(["/p/a.ts", "/p/b.ts", "/p/c.ts"]));
  assert.equal(all.cleared, 1, "once every file is superseded the copy is genuinely redundant");
});

test("a file the working set does NOT carry whole is left alone", () => {
  // Localized files (shown as outline + focus, not whole) are NOT superseded: clearing
  // the transcript copy would lose the parts the boundary is not showing.
  const entries: Entry[] = [
    { role: "user", content: "look at big.ts" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"big.ts"}' }] },
    { role: "tool", toolCallId: "c1", content: "line one\nline two", fullContentOf: "/p/big.ts" },
  ];
  const swept = microcompact(entries, 5, new Set(["/p/other.ts"]));
  assert.equal(swept.cleared, 0, "only files carried WHOLE are redundant");
});

test("a reply the person answered is never condensed, however old", () => {
  // Real session: "yes you can pick that up good choice" answered a proposal that was
  // later replaced by the recap stub, so the model held an agreement to something it
  // could no longer see, and did far more than was agreed.
  const proposal = "I can wire the decode sandbox into the present path next, or stop at the probe. " + longRecap;
  const entries: Entry[] = [
    userMsg("hey"),
    recap(proposal),
    userMsg("yes you can pick that up good choice"),
    ...Array.from({ length: 12 }, (_, i) => recap(`step ${i}`)),
  ];
  const { entries: out, recapsCleared } = microcompact(entries, 8);
  assert.equal(recapsCleared, 0);
  assert.equal(out[1]!.content, proposal, "the reply the user said yes to was condensed away");
});
