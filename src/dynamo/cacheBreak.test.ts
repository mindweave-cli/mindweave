/**
 * cacheBreak.test.ts — the detector that would have caught the two expensive bugs.
 *
 * Both shipped, both were invisible, and both were found by reading a session file after
 * the fact: a skill catalog inside the system prompt that varied with which files had
 * been read, and a tool search that added what it found to the advertised list. Each test
 * below is one of those shapes, plus the ordering rule that makes a report actionable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefixPrint, diffPrefix, hashString, cacheCallLine, writeCacheLog } from "./cacheBreak.js";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSchema } from "../tools/types.js";
import type { ChatMessage } from "../drivers/types.js";

const tool = (name: string, description = "does a thing"): ToolSchema => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
});

const print = (model = "m", system = "SYSTEM", tools: ToolSchema[] = [tool("read"), tool("edit")]) =>
  prefixPrint(model, system, tools);

test("an unchanged prefix reports nothing", () => {
  assert.equal(diffPrefix(print(), print()), null);
});

test("REGRESSION: a system prompt that varies with session state", () => {
  // The skill-catalog bug. The catalog was filtered by which files had been read, so
  // reading a matching file rewrote the system prompt and invalidated tools, system AND
  // messages — the most expensive invalidation the API has — with nothing on screen.
  const broke = diffPrefix(print(), print("m", "SYSTEM\n- deploy: does deploy"));
  assert.equal(broke?.kind, "system");
  assert.match(broke!.detail, /system prompt changed/);
  assert.match(broke!.detail, /\+\d+ chars/, "the size of the change is what tells you which section moved");
});

test("REGRESSION: a search that adds what it found to the advertised list", () => {
  // The find_tools bug. One search re-billed the whole prefix to save a few hundred
  // tokens of schema. The report has to NAME the tool, or the next person is guessing.
  const broke = diffPrefix(print(), print("m", "SYSTEM", [tool("read"), tool("edit"), tool("sessions")]));
  assert.equal(broke?.kind, "tools");
  assert.match(broke!.detail, /\+sessions/);
});

test("a tool whose schema changes under a stable name is caught and named", () => {
  // The case a name-and-count check cannot see: same tools, same order, different bytes,
  // because a description is built from live state. It breaks the cache every call.
  const broke = diffPrefix(print(), print("m", "SYSTEM", [tool("read"), tool("edit", "does a thing (3 open)")]));
  assert.equal(broke?.kind, "tool-schema");
  assert.match(broke!.detail, /^edit /, "the changed tool must be named, not just counted");
});

test("a removed tool is reported as removed", () => {
  const broke = diffPrefix(print(), print("m", "SYSTEM", [tool("read")]));
  assert.equal(broke?.kind, "tools");
  assert.match(broke!.detail, /-edit/);
});

test("the outermost cause wins when several things moved", () => {
  // The parts are nested: on a model switch every downstream difference is meaningless,
  // so reporting "the tool list changed" would send someone chasing a non-problem.
  const broke = diffPrefix(print(), print("other-model", "DIFFERENT", [tool("read")]));
  assert.equal(broke?.kind, "model");
});

test("the fingerprint is small enough to hold for a session", () => {
  // It is kept per session and compared every call. Storing the content instead of
  // hashes would mean carrying a second copy of the whole prompt for diagnostics.
  const p = print("m", "x".repeat(50_000));
  assert.equal(typeof p.system, "number");
  assert.ok(Object.values(p.tools).every((h) => typeof h === "number"));
  assert.ok(JSON.stringify(p).length < 2_000);
});

test("the hash actually distinguishes near-identical text", () => {
  assert.notEqual(hashString("tool_a"), hashString("tool_b"));
  assert.notEqual(hashString("abc"), hashString("acb"));
  assert.equal(hashString("same"), hashString("same"));
});

const msg = (content: string): ChatMessage => ({ role: "user", content });

test("appending to the conversation is not a break", () => {
  // The normal case, and it must stay silent or every call reports one. Growth costs
  // nothing: every earlier byte is untouched, which is the whole point of append-only.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two")]);
  const after = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two"), msg("three")]);
  assert.equal(diffPrefix(before, after), null);
});

test("REGRESSION: rewriting an earlier message is caught and located", () => {
  // The blind spot this closes. Microcompaction clearing an old tool body, a read being
  // de-duplicated, an image ref dropped — each rewrites history in place, invalidating
  // everything after it, and NONE of them touch the system prompt or a tool schema. The
  // detector reported nothing at all for this whole class of break.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two"), msg("three")]);
  const after = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("CLEARED"), msg("three")]);
  const broke = diffPrefix(before, after);
  assert.equal(broke?.kind, "history");
  assert.match(broke!.detail, /message 2 /, "the report must locate the rewrite, not just announce it");
});

test("REGRESSION: a changed system prompt is reported as the system prompt, not as a rewritten message", () => {
  // A real session's biggest break (48k tokens re-billed) was a system prompt that grew by a few
  // hundred characters, and the note blamed "message 167 of 168". The system prompt comes first.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two")]);
  const after = prefixPrint("m", "SYSTEM + notes", [tool("read")], [msg("one"), msg("CLEARED")]);
  assert.equal(diffPrefix(before, after)?.kind, "system");
});

test("a dropped turn is a rewrite even when every surviving message matches", () => {
  // Overflow recovery drops the oldest rounds. Nothing was edited, but everything moved.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two"), msg("three")]);
  const after = prefixPrint("m", "SYSTEM", [tool("read")], [msg("one"), msg("two")]);
  assert.equal(diffPrefix(before, after)?.kind, "history");
});

test("the first rewritten message wins, not the last", () => {
  // Everything after the first break is a consequence of it. Reporting the last one
  // points at a symptom and sends someone looking in the wrong turn.
  const before = prefixPrint("m", "SYSTEM", [tool("read")], [msg("a"), msg("b"), msg("c")]);
  const after = prefixPrint("m", "SYSTEM", [tool("read")], [msg("a"), msg("X"), msg("Y")]);
  assert.match(diffPrefix(before, after)!.detail, /message 2 /);
});

test("a call line carries the break AND the hit, because neither means anything alone", () => {
  // The whole point of the line. A zero hit WITH a break is our prefix moving and is
  // ours to fix; a zero hit with NO break is the provider's cache having expired, and no
  // amount of prefix work would have prevented it. The two are indistinguishable from
  // either half on its own, so they are never written on separate lines.
  const ours = cacheCallLine({
    call: 5,
    gapMs: 412_000,
    broke: { kind: "tools", detail: "sessions appeared" },
    promptTokens: 18_851,
    cacheHitTokens: 0,
    model: "glm-5.3-flash",
  });
  assert.match(ours, /call=5/);
  assert.match(ours, /gap=412\.0s/);
  assert.match(ours, /prompt=18851 hit=0 \(0%\)/);
  assert.match(ours, /broke=tools — sessions appeared/);

  const theirs = cacheCallLine({
    call: 5,
    gapMs: 412_000,
    broke: null,
    promptTokens: 18_851,
    cacheHitTokens: 0,
    model: "glm-5.3-flash",
  });
  assert.match(theirs, /broke=none/, "a call with nothing changed must say so, not go unlogged");
});

test("a first call is not reported as an instant one", () => {
  // `gap=0.0s` on the opening call would read as a cache that expired in no time.
  assert.match(
    cacheCallLine({ call: 1, gapMs: null, broke: null, promptTokens: 100, cacheHitTokens: 0, model: "m" }),
    /gap=first/,
  );
});

test("the hit share is of the prompt, and an empty prompt does not divide by zero", () => {
  assert.match(
    cacheCallLine({ call: 2, gapMs: 1000, broke: null, promptTokens: 1000, cacheHitTokens: 750, model: "m" }),
    /hit=750 \(75%\)/,
  );
  assert.match(
    cacheCallLine({ call: 2, gapMs: 1000, broke: null, promptTokens: 0, cacheHitTokens: 0, model: "m" }),
    /\(0%\)/,
  );
});

test("nothing is written without the variable, and the line is appended with it", () => {
  const before = process.env.MINDWEAVE_CACHE_LOG;
  const path = join(mkdtempSync(join(tmpdir(), "mindweave-cachelog-")), "cache.txt");
  try {
    delete process.env.MINDWEAVE_CACHE_LOG;
    writeCacheLog("call=1");
    assert.equal(existsSync(path), false, "a diagnostic that is off must touch nothing");

    process.env.MINDWEAVE_CACHE_LOG = path;
    writeCacheLog("call=1 hit=0");
    writeCacheLog("call=2 hit=900");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "the second call overwrote the first");
    assert.match(lines[1]!, /^\d{4}-\d\d-\d\dT.*call=2 hit=900$/, "a line with no timestamp cannot be lined up with a bill");
  } finally {
    if (before === undefined) delete process.env.MINDWEAVE_CACHE_LOG;
    else process.env.MINDWEAVE_CACHE_LOG = before;
  }
});
