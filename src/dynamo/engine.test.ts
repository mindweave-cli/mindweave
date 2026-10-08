/**
 * engine.test.ts — stopReasonNote (pure) + the pause paths' one structural rule.
 *
 * The full agent loop isn't unit-tested here (it needs a live session and tool
 * context), but the wording shown to the user when a turn ends early is pure and
 * worth pinning: every non-"end" StopReason must produce a distinct, honest
 * explanation, so a truncated reply is never confused with a refused one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arrivalNote, resolveStepLimit, steeredMessage, stopReasonNote } from "./engine.js";
import type { StopReason } from "../drivers/types.js";

test("every early-stop reason gets its own, distinct explanation", () => {
  const reasons: Exclude<StopReason, "end">[] = ["truncated", "refused", "overflow", "overloaded"];
  const notes = reasons.map(stopReasonNote);
  assert.equal(new Set(notes).size, reasons.length, "two different reasons produced the same wording");
  for (const note of notes) assert.ok(note.length > 0);
});

test("truncated and overloaded both read as incomplete, but name a different cause", () => {
  const truncated = stopReasonNote("truncated");
  const overloaded = stopReasonNote("overloaded");
  assert.match(truncated, /incomplete/);
  assert.match(overloaded, /incomplete/);
  assert.notEqual(truncated, overloaded);
});

// ---------------------------------------------------------------------------
// Every pause must reach the SCREEN, not just the transcript.
//
// A source scan, which is unusual, and deliberate. This bug cannot fail loudly:
// a pause helper that only pushes to the transcript type-checks, passes every
// test, and returns a perfectly good string — the turn just ends with a blank
// screen and the user reads it as a crash. That happened. The only mechanical way
// to catch the next one is to check the shape of the code, the same approach
// promptAssembly.test.ts and providerNeutrality.test.ts take for their own
// silent failures.
// ---------------------------------------------------------------------------

const engineSource = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");

test("endTurnWith puts the pause message on the wire, not only in the transcript", () => {
  const body = engineSource.match(/function endTurnWith\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "endTurnWith not found — did it get renamed?");
  assert.match(body, /transcript\.push/, "the pause must be recorded for the next model turn");
  assert.match(body, /onEvent\?\.\(\s*\{\s*type:\s*"text"/, "the pause must also be emitted to the UI");
});

test("no pause helper ends a turn without going through endTurnWith", () => {
  const helpers = [...engineSource.matchAll(/\nfunction (pause\w*)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
  assert.ok(helpers.length >= 4, `expected the known pause helpers, found ${helpers.length}`);
  for (const [, name, body] of helpers) {
    assert.match(
      body!,
      /endTurnWith\(/,
      `${name} composes a message the user never sees — route it through endTurnWith`,
    );
  }
});

test("session memory is swept at turn END, not only at turn start", () => {
  // The turn-start check works one turn behind: it can only see what happened BEFORE
  // this turn ran. A session whose last turn did the real work therefore ended with
  // notes that never mentioned it, and a later read_session found nothing useful.
  // This bug cannot fail loudly — the notes are just quietly thinner — so it is pinned
  // structurally, the same way endTurnWith is.
  const sweeps = [...engineSource.matchAll(/sweepSessionMemory\(session, options\)/g)];
  assert.ok(sweeps.length >= 2, `expected a sweep at turn start AND turn end, found ${sweeps.length}`);
  assert.match(
    engineSource,
    /if \(!options\.signal\?\.aborted\) await sweepSessionMemory/,
    "the end-of-turn sweep must be skipped on abort — Esc should not buy a background model call",
  );
});

test("the end-of-turn sweep is not in the finally block", () => {
  // `finally` also runs on throw and on abort. A model call there would fire on paths
  // the user never paid for and cannot see.
  const finallyBody = engineSource.match(/\} finally \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(finallyBody, "the turn's finally block not found — did it get restructured?");
  assert.doesNotMatch(finallyBody, /sweepSessionMemory/);
});

test("the turn's MCP tools come from ONE snapshot, not two live reads", () => {
  // Reading live state twice let a server die between advertising a tool and
  // dispatching it, so the model could be refused a tool it had just been offered.
  // Silent when broken — the tool list still looks right — so it is pinned structurally.
  assert.match(engineSource, /mcp\?\.snapshot\(/, "the turn must take a snapshot");
  assert.doesNotMatch(engineSource, /mcp\?\.toolSchemas\(/, "the advertised list must come from the snapshot");
  assert.doesNotMatch(engineSource, /mcp\?\.asTool\(/, "dispatch must come from the same snapshot");
});

test("compaction counts the whole prompt, not just the transcript", () => {
  // Everything sent every turn but living outside the transcript — the system prompt,
  // every tool schema, the working-set block, the relevance map — used to be invisible
  // to the bars, so they fired that much too late. Also silent when broken.
  // The arithmetic lives in ONE place now, because the user-facing compaction bars are
  // drawn from the same figure the thresholds fire on. Two copies could drift, and the
  // display would then contradict the decision it is meant to explain.
  const body = engineSource.match(/function contextUsed\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "contextUsed not found — did it get renamed?");
  assert.match(body, /estimateEntriesTokens\(session\.transcript\)/, "the transcript is part of the budget");
  assert.match(body, /\+ overhead/, "and so is everything outside the transcript");
  // Both halves of the overhead must survive: the MEASURED prompt size once a call has
  // reported one, and the catalog estimate as the fallback before that. Lose either and
  // the bars go blind again to whichever is missing.
  assert.match(body, /const overhead =/, "the overhead term not found — did it get renamed?");
  assert.match(body, /contextOverhead/, "the measured prompt size is preferred");
  assert.match(body, /estimatedTokens\(\)/, "with the MCP catalog as the fallback");
  // A measurement from ANOTHER model must not be reused: switching provider changes the
  // tool-schema serialisation and the prompt shape, so the figure stops being about this
  // request. Without this comparison the first call after a /provider switch sizes its
  // bars from the old provider's prompt.
  assert.match(body, /\.model === session\.modelConfig\.model/, "a measurement from another model must not be reused");

  // And the thresholds must actually USE it rather than keeping their own copy.
  const compactBody = engineSource.match(/async function maybeCompact\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(compactBody, "maybeCompact not found — did it get renamed?");
  assert.match(compactBody, /contextUsed\(session\)/, "the bars must fire on the shared figure");
  // As must the report the user is shown, or the bars become a second opinion.
  assert.match(engineSource, /before,\s*\n\s*after: contextUsed\(session\)/, "the report must use it too");
  // And the measured branch must actually be fed, or it is dead code that reads as safety.
  assert.match(
    engineSource,
    /contextOverhead = \{/,
    "reported usage must be recorded as the overhead",
  );
  assert.match(engineSource, /tokens: measuredOverhead\(/, "…with the measured figure");
  assert.match(engineSource, /model: session\.modelConfig\.model/, "…and the model it belongs to");
  assert.doesNotMatch(body, /estimateEntriesTokens\(session\.transcript\) >=/, "no bar may be compared against the transcript alone");
});

test("the tool list is rebuilt per STEP, so a searched tool is callable at once", () => {
  // A large MCP catalog is held behind find_mcp_tools. If the tool list were fixed at
  // turn start, the model would search, be told a tool was loaded, and then still not
  // be able to call it until the next user message — a lie it cannot diagnose.
  // Silent when broken: the search still reports success.
  assert.match(engineSource, /const stepTools = \(\) =>/, "the tool list must be a per-step function");
  // Match to the end of the argument list rather than to the first `)`, so an argument
  // that is itself a call (or a reformat onto several lines) doesn't silently truncate
  // the match and turn this into a test that passes by finding nothing.
  const call = engineSource.match(/const request = buildRequest\([\s\S]*?\n\s*\);/)?.[0];
  assert.ok(call, "buildRequest call not found — did the signature change?");
  assert.match(call, /stepTools\(\)/, "each step must send the CURRENT tool list");
});

// autocompact is a thin wrapper (fires onCompactionStart/onCompactionEnd around the
// real work) so a front end can show a "compacting…" state; the gated logic these two
// tests pin actually lives in summarizeAndSplice, which it calls.
test("the summarizer's reply is gated before it can replace the transcript", () => {
  // Silent when broken: an accepted bad summary looks identical to a good one, and
  // the conversation it replaced is already gone.
  const body = engineSource.match(/async function summarizeAndSplice\([\s\S]*?\n\}/)?.[0];
  assert.ok(body, "summarizeAndSplice not found — did it move?");
  assert.match(body, /usableSummary\(turn\.content, turn\.stop\)/, "the stop reason must be part of the decision");
  assert.doesNotMatch(body, /const \{ content \}/, "destructuring content alone discards the stop reason");
});

test("EVERY summarizer rejection counts toward the circuit breaker", () => {
  // A rejection that doesn't count means a doomed summarizer is called on every step
  // forever, which is the runaway the breaker exists to stop.
  const body = engineSource.match(/async function summarizeAndSplice\([\s\S]*?\n\}/)?.[0];
  assert.ok(body);
  // Pin the property, not a count: BOTH ways out — a thrown error and a reply that
  // came back unusable — have to go through the same failure path.
  // The CALL is what is pinned, not its arguments: `fail` now also names the reason on
  // screen, and freezing the exact spelling would fail every time that wording improved
  // while still passing if the call vanished from one of the two paths.
  assert.match(body, /if \(!usable\) return void fail\(/, "an unusable reply must count as a failure");
  // The one exception is the user pressing Esc: a call they stopped did not fail, and
  // counting it would let a few stops switch compaction off for the session. The guard
  // must be that exact check and nothing broader, so every other throw still counts.
  assert.match(
    body,
    /\} catch [\s\S]{0,20}?\{\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(options\.signal\?\.aborted\) return;\s*\n[\s\S]{0,700}return void fail\(/,
    "a thrown error must count as a failure (only a user's stop is exempt)",
  );
  // The one legitimate branch in between (a clearer message for a known unfixable
  // refusal, see the agentic-harness test) still has to end in `fail(`, never a bare
  // return — that's what would silently skip the breaker for that one case.
  const catchBlock = body.match(/\} catch [\s\S]*$/)?.[0] ?? "";
  assert.doesNotMatch(catchBlock, /\n\s*return;\s*\n/, "no bare return in the catch block besides the signal-aborted guard");
  assert.doesNotMatch(body, /if \(!summary\) return;/, "a bare return skips the breaker");
});

test("the summarizer loads ITS OWN model's driver before calling it", () => {
  // Silent when broken, and confusing when it breaks: `activeDriver()` is a plain
  // global set by the last `ensureDriver` call, not scoped to this session. A
  // sub-agent (or any other background aux call) running a DIFFERENT model in
  // between leaves it pointed at that provider — this call would then hand THAT
  // provider its own model string, which the provider correctly refuses as one it
  // has never heard of. Real failure seen live: "Unknown Model, please check the
  // model code." on an OpenRouter model, from every retry, because the global had
  // been left on a different provider entirely.
  const body = engineSource.match(/async function summarizeAndSplice\([\s\S]*?\n\}/)?.[0];
  assert.ok(body);
  assert.match(
    body,
    /await ensureDriver\(model\.model\);[\s\S]{0,40}activeDriver\(\)/,
    "ensureDriver(model.model) must run immediately before activeDriver() is used",
  );
});

test("an agentic-harness-only refusal gets an honest explanation, not the raw provider JSON", () => {
  // Confirmed live against the real model: attaching real tool schemas (withAuxModel's
  // retry) does NOT get past this one — OpenRouter's own error names the cause as
  // `"failed_routing_step":"Gate Free Endpoints by Agentic Harness"`, a gate on the
  // CALLING APP's identity that no request shape can satisfy. Surfacing the raw JSON
  // here would read as a Mindweave bug; this is a model limit outside Mindweave's control.
  const body = engineSource.match(/async function summarizeAndSplice\([\s\S]*?\n\}/)?.[0];
  assert.ok(body);
  assert.match(
    body,
    /if \(isAgenticOnlyRefusal\(error\)\)/,
    "the agentic-harness-only refusal must be checked before falling back to the raw provider message",
  );
  assert.match(body, /won't serve Mindweave's background calls/, "the explanation must say plainly that this is a model limit");
});

test("microcompaction's result is never discarded on a counter nobody remembered", () => {
  // The original defect: gating the write on a hand-picked subset of counters meant a
  // pass that only cleared edit INPUTS, or only evicted IMAGES, did the work and threw
  // it away — and every new kind of clearing had to remember to add itself to that
  // condition or be silently dropped.
  //
  // The write IS conditional now, deliberately: clearing rewrites the cached prefix, so
  // a clear reclaiming a little costs more than it saves (see `clearIsWorthIt`). That
  // does not reintroduce the defect, and the reason is the point of this test — the
  // decision is made on TOKENS, which every kind of clearing moves, rather than on
  // counters, which each only see their own category. A measurement cannot forget a
  // category the way a hand-written boolean can.
  const body = engineSource.match(/if \(used\(\) >= microBar[^)]*\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(body, "microcompact block not found");
  assert.match(body, /const proposed = microcompact\(/, "the result must still be computed in full");
  // Committed whole; keepClearedOriginals only adds where each cleared original was saved.
  assert.match(body, /session\.transcript = keepClearedOriginals\(session, proposed\);/, "and committed as a whole, not merged piecemeal");
  // The decision must be a token measurement over the WHOLE proposed transcript.
  assert.match(body, /estimateEntriesTokens\(session\.transcript\)/, "the before size must be measured");
  assert.match(body, /estimateEntriesTokens\(proposed\)/, "and the after size, from the proposal itself");
  assert.match(body, /clearIsWorthIt\(/, "the commit decision belongs in the tested pure function");
  // No per-category counter may gate the write — that is the defect this test is named
  // for, and it is still forbidden.
  assert.doesNotMatch(body, /cleared > 0 \|\| recapsCleared > 0/, "no counter subset may gate the write");
  assert.doesNotMatch(body, /if \([a-z]+\.cleared/i, "nor any single counter");
  assert.doesNotMatch(body, /\.imagesCleared|\.inputsCleared|\.recapsCleared/, "nor any category counter at all");
});

test("nothing is pushed to the transcript between tool_calls and their results", () => {
  // A shipped 400 from DeepSeek: "An assistant message with 'tool_calls' must be
  // followed by tool messages responding to each 'tool_call_id'." The narration nudge
  // was pushed as a `user` message the moment the fault was judged — which is right
  // after the assistant's tool_calls and before any result. Every turn that called a
  // tool failed instantly.
  //
  // Pinned structurally because the unit tests around it all passed: they covered the
  // pure detector and never the transcript SHAPE. Any future nudge judged at that spot
  // has to queue and land after the results, like the batching and verify nudges do.
  const start = engineSource.indexOf('push({ role: "assistant", content, toolCalls: records })');
  assert.ok(start > 0, "the tool_calls append moved — re-anchor this test");
  const end = engineSource.indexOf("phase: \"start\"", start);
  assert.ok(end > start, "the tool announcement loop moved — re-anchor this test");

  const between = engineSource.slice(start, end);
  assert.doesNotMatch(
    between,
    /transcript\.push/,
    "something is appended between tool_calls and the tool results — that request is invalid",
  );
});

test("the reply-style rules live in the CACHED prefix, not the per-request tail", () => {
  // Reversed deliberately. They were moved to the boundary because the prefix buried
  // them by turn three — but that cure cost 645 tokens re-sent on EVERY step of every
  // turn, uncached, to govern one final message. Ten tool rounds paid for it ten times.
  //
  // If sprawling replies come back, the answer is a SHORT reassertion carried on
  // something already in the conversation, never a block on every request.
  const promptSource = readFileSync(fileURLToPath(new URL("./prompt.ts", import.meta.url)), "utf8");
  assert.match(promptSource, /FOUR LINES OR FEWER/, "the rule belongs in the cached system prompt");
  assert.doesNotMatch(engineSource, /parts\.push\(REPLY_STYLE\)/, "it must not be pushed into the tail");
});

test("the closing reply still asks what the user could not have seen", () => {
  // The one part of a turn that is NOT recoverable from the screen. Everything else in
  // this block describes what to leave out, so a later edit trimming it "for brevity"
  // would take the only line that adds something — and nothing would look wrong.
  const promptSource = readFileSync(fileURLToPath(new URL("./prompt.ts", import.meta.url)), "utf8");
  assert.match(promptSource, /unexpected that you did not act on/, "the surprise line is gone");
  assert.match(promptSource, /cannot see for themselves/, "the reason it outranks brevity is gone");
  assert.match(promptSource, /an invented next step is worse than none/, "the escape from a forced offer is gone");
  // And the rule it replaced must not come back alongside it: "just stop" and "offer the
  // next step" in the same block is a contradiction the model resolves at random.
  assert.doesNotMatch(promptSource, /After doing work, just stop\./, "the superseded rule is back");
});

test("the reply gate fires at the turn-end boundary and can only fire once", () => {
  // Prose asked for this budget in three wordings and was ignored each time; this is
  // the version that holds, so the wiring is worth pinning.
  assert.match(engineSource, /const fault = replyFault\(content, mutatedThisTurn\)/, "gated on the turn's own work flag");
  assert.match(engineSource, /if \(!replyRegated\)/, "one retry per turn — a gate that can fire twice is a loop");
  assert.match(engineSource, /options\.onEvent\?\.\(\{ type: "replyReset" \}\)/, "the draft must be dropped from the UI buffer");
});

test("a superseded reply is spliced out of history, so what is saved is what was shown", () => {
  // Otherwise a resumed session replays the text the gate just removed. Both gates that
  // re-open a concluded turn record where the reply they superseded sits, and both are
  // unwound by the same loop.
  assert.match(engineSource, /\[overlongReplyAt, prematureReplyAt\]/);
  assert.match(engineSource, /session\.transcript\.splice\(at, 2\)/);
});

test("a turn that is re-opened to verify does not end up saying goodbye twice", () => {
  // Seen on screen: the model finished, the verify gate re-opened the turn, and the model
  // concluded a SECOND time — two closing statements with nothing between them, because
  // the nudge is synthetic and a clean check reports nothing. The reply gate below it had
  // always dropped its superseded draft; this one had not.
  // Anchored on the gate's own condition, not on the words "Verification gate" — those
  // appear in a comment 45,000 characters earlier, and slicing from there swept in the
  // REPLY gate's reset, so this passed with the line it exists to check deleted.
  const start = engineSource.indexOf("if (VERIFY_GATE");
  const end = engineSource.indexOf("// Reply gate.");
  assert.ok(start > 0 && end > start, "the gates have moved; this test is looking at nothing");
  const gate = engineSource.slice(start, end);
  assert.ok(gate.length < 2000, `the slice is too wide to mean anything: ${gate.length} chars`);
  assert.match(gate, /prematureReplyAt = session\.transcript\.length - 1/, "the premature reply is not recorded");
  assert.match(gate, /type: "replyReset"/, "the premature reply still reaches the screen");
});

// ---------------------------------------------------------------------------
// The step ceiling, and who gets one.
//
// A ceiling is for a loop nobody is watching. The interactive turn has a person in
// front of it holding Esc; a sub-agent has neither a screen nor a keyboard. The old
// default capped both at fifty rounds, and on the interactive side what it stopped
// was ordinary work — a task across a dozen files spends fifty rounds with nothing
// wrong, and ended mid-flight on a pause the user then had to step over.

test("no ceiling by default: the interactive turn runs until it is finished or stopped", () => {
  assert.equal(resolveStepLimit(undefined, undefined), undefined);
  assert.equal(resolveStepLimit(undefined, ""), undefined);
});

test("a sub-agent's explicit budget always wins, and is never widened", () => {
  // The half that must not regress. A worker runs unattended, so its cap is the only
  // thing between a misread task and an unbounded bill.
  assert.equal(resolveStepLimit(20, undefined), 20);
  assert.equal(resolveStepLimit(20, "500"), 20);
});

test("the env var puts a ceiling back for an unattended run", () => {
  assert.equal(resolveStepLimit(undefined, "50"), 50);
  assert.equal(resolveStepLimit(undefined, "1"), 1);
});

test("a meaningless ceiling is no ceiling, never a silent zero", () => {
  // Zero or a negative would make the loop exit before its first call, which reads as
  // the model answering nothing at all. Junk falls back to unbounded, not to a value.
  for (const junk of ["0", "-5", "abc", "1.5", "NaN", " "]) {
    assert.equal(resolveStepLimit(undefined, junk), undefined, `"${junk}" was read as a ceiling`);
  }
});

test("the loop tolerates having no ceiling at all", () => {
  // Mechanical, because the failure is silent in the worst way: `step < undefined` is
  // false, so a loop that forgot this check would end BEFORE its first model call and
  // every turn would return the pause message having done nothing.
  const source = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
  const loop = source.match(/for \(let step = 0;[^)]*\)/);
  assert.ok(loop, "the step loop is gone or was rewritten");
  assert.match(
    loop[0],
    /stepLimit === undefined \|\|/,
    "the loop compares against a possibly-undefined ceiling without checking for one",
  );
});

// ---------------------------------------------------------------------------
// Steering: a message typed while the turn is running reaches THAT turn.

test("a steered message is put to the model with when it arrived, and what to do", () => {
  const framed = steeredMessage("use the other file");
  assert.match(framed, /use the other file/, "the message itself is gone");
  assert.match(framed, /while you were working/i, "nothing says when it arrived");
  // Both halves matter. Without the first a model already told to do something else
  // ignores it; without the second it abandons work in flight and restarts.
  assert.match(framed, /change course/i, "it is not told it may change course");
  assert.match(framed, /before you stop/i, "it is not told it must answer before finishing");
});

test("the framing wraps the message rather than replacing it", () => {
  // A steered message must survive whole: the model acts on what was typed, not on a
  // summary of it. Anything that shortened it here would be silent.
  const long = "rewrite the parser so it handles the ESC ] form, and add a test";
  assert.ok(steeredMessage(long).includes(long));
});

test("the transcript stores what was TYPED; only the wire is framed", () => {
  // Mechanical, and the reason is `/continue`. A framed message stored at rest replays
  // in the chat with the explanation showing, as if the person had typed that too — and
  // the session picker labels sessions by their first user message, so it would show up
  // there as well.
  const source = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
  assert.match(
    source,
    /content: message\.content,\s*\n\s*arrival: "steered"/,
    "a steered entry is being stored as something other than the raw text",
  );
  assert.match(
    source,
    /e\.arrival \? arrivalNote\(e\.arrival, e\.content\) : e\.content/,
    "the framing is not applied where the request is built, so the model is not told",
  );
});

test("the two arrivals are told apart, and neither reads like the other", () => {
  // A steer and an interrupt are different facts and must not share wording. "Finish the
  // current step" is right for a steer and exactly wrong after Esc, where finishing the
  // step is the thing the user just stopped.
  const steered = arrivalNote("steered", "look at the parser");
  const stopped = arrivalNote("interrupting", "look at the parser");
  assert.notEqual(steered, stopped);
  assert.match(steered, /while you were working/i);
  assert.match(stopped, /stopped you/i);
  assert.match(stopped, /cut off/i, "nothing says the work was ended deliberately");
  assert.doesNotMatch(stopped, /finish the current step/i, "an interrupted turn is told to resume");
  for (const framed of [steered, stopped]) assert.ok(framed.includes("look at the parser"));
});

test("a steered message lands AFTER the round's tool results, never among them", () => {
  // The rule every provider enforces: a user message between a tool_call and its result
  // is a malformed conversation and the request is rejected. `nothing is pushed to the
  // transcript between tool_calls and their results` guards the other pushes; this
  // guards the one that is driven from outside the engine.
  const source = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
  const resultsPush = source.indexOf('role: "tool"');
  const steerDrain = source.indexOf("await options.steer()");
  assert.ok(resultsPush > 0 && steerDrain > 0, "one of the two sites is gone");
  assert.ok(steerDrain > resultsPush, "the steer drain runs before the tool results are recorded");
});

test("a failure while resolving a steered message cannot kill the turn", () => {
  // The caller resolves attachments, which touches the disk: a file dropped into the
  // box and deleted before the message went out would otherwise throw out of the loop
  // and take a turn's work with it.
  const source = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
  const drain = source.slice(source.indexOf("if (options.steer)"), source.indexOf("if (options.steer)") + 700);
  assert.match(drain, /try \{/, "the steer callback is called without a guard");
  assert.match(drain, /catch/, "the steer callback is called without a guard");
});
