/**
 * promptAssembly.test.ts — where each governance block lands in the request.
 *
 * Rules moved from the cached system PREFIX to the volatile BOUNDARY (salience:
 * a long session can't bury them). Forbidden paths/commands and skills stay in the
 * prefix (forbidden is enforced mechanically; skills are a reference catalog).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "../tools/registry.js";
import { volatileContext, staticSystemPrompt } from "./engine.js";
import { basePrompt } from "./prompt.js";

const gov = (over: Partial<{ rules: string; forbidden: string; forbiddenCommands: string; skills: string }>) => ({
  rules: "",
  forbidden: "",
  forbiddenCommands: "",
  skills: "",
  ...over,
});

test("standing rules render at the volatile boundary, with binding framing", () => {
  const ctx = volatileContext("- Use pnpm, never npm", false);
  assert.match(ctx, /<rules>/);
  assert.match(ctx, /Use pnpm, never npm/);
  assert.match(ctx, /BINDING/);
});

test("no rules → no rules block in the boundary", () => {
  const ctx = volatileContext("", false);
  assert.equal(ctx.includes("<rules>"), false);
});

test("rules are NOT in the cached system prefix anymore (moved to the boundary)", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({ rules: "- Use pnpm, never npm" }), "");
  assert.equal(sys.includes("<rules>"), false);
  assert.equal(sys.includes("Use pnpm, never npm"), false);
});

test("forbidden commands DO stay in the cached system prefix", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({ forbiddenCommands: "- tauri dev" }), "");
  assert.match(sys, /<forbidden_commands>/);
  assert.match(sys, /tauri dev/);
});

test("forbidden paths still stay in the cached system prefix", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({ forbidden: "- src/legacy" }), "");
  assert.match(sys, /<forbidden>/);
  assert.match(sys, /src\/legacy/);
});

// ── Its own past sessions ─────────────────────────────────────────────────────
//
// Transcripts are saved, and list_sessions / read_session can read them. The prompt
// carries the COUNT only — enough for the model to know the history exists — and
// points it at the tools for the content. It used to say the opposite ("you cannot
// see what was said"), which was true when nothing could read them and became a
// lie the moment the tools shipped; the model dutifully repeated it to the user.

test("with no prior sessions, nothing is claimed", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 0);
  assert.ok(!/worked in this project before/.test(sys));
});

test("prior sessions are announced, with the count and how to reach them", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 2);
  assert.match(sys, /worked in this project before/);
  assert.match(sys, /2 earlier sessions/);
  assert.match(sys, /\/continue/);
});

test("a single prior session reads as singular, not '1 sessions'", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 1);
  assert.match(sys, /1 earlier session of yours/);
  assert.ok(!/1 earlier sessions/.test(sys));
});

test("it is pointed at the tools that read those sessions, not told it is blind", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 3);
  // The tool NAME, checked against the registry rather than written out here. This test
  // used to hard-code `list_sessions` and `read_session`, and when those two were merged
  // into one `sessions` tool the assertion kept the dead names alive in the prompt — so
  // the model obeyed, called a tool that did not exist, and burned two round trips
  // recovering. A test that pins a name is a test that can pin a broken one.
  assert.ok(
    TOOLS.some((t) => t.name === "sessions"),
    "the tool this prompt points at must exist",
  );
  assert.match(sys, /`sessions`/);
  // The exact deflection the user hit: claiming no visibility, then paraphrasing
  // project files instead of looking. Both are now explicitly ruled out.
  assert.doesNotMatch(sys, /cannot see what was said/);
  assert.match(sys, /Do not say you cannot see your past sessions/);
  assert.match(sys, /do not guess from the project files/);
});

test("another tool's saved conversations are still never ours to claim", () => {
  const sys = staticSystemPrompt("", "", "", "", gov({}), "", 3);
  assert.match(sys, /never present another tool's saved conversations as your own/i);
});

// ── The shared prompt stays provider-neutral ──────────────────────────────────
//
// These phrases were written to correct one model's habit and lived in the prompt
// every provider reads. One of them was demonstrably not working on the very model
// it targeted, while still costing every other model tokens and attention. They
// were removed; these assertions stop them drifting back in.
// See BOUNDARY.md for when a behavioral line belongs in core at all.

test("no model-specific behavioral patches in the shared prompt", () => {
  const sys = basePrompt("bash");
  const banned: [RegExp, string][] = [
    [/repeat a summary you have already given/i, "repeat-summary rule (written for one model, didn't work on it)"],
    [/blindly retry the identical action/i, "retry rule (duplicates the REPEAT_FAIL_LIMIT breaker in engine.ts)"],
  ];
  for (const [pattern, why] of banned) {
    assert.ok(!pattern.test(sys), `shared prompt reintroduced the ${why}`);
  }
});

test("the prompt does not promise a capability only some providers document", () => {
  // Parallel tool calling is GA and documented for one provider, undocumented for
  // another. Encourage batching (a cost argument, true everywhere) rather than
  // asserting the models can all do it.
  const sys = basePrompt("bash");
  assert.ok(!/can be called several at a time/i.test(sys), "reasserted parallel tool calls as a guarantee");
  assert.match(sys, /issue them in one turn/i, "lost the batching guidance entirely");
});

test("the harness facts that every provider needs are still present", () => {
  // The counterweight: this must not become an excuse to hollow out the prompt.
  const sys = basePrompt("bash");
  assert.match(sys, /verify it actually works/i, "lost the verify-before-done rule");
  assert.match(sys, /Report what happened honestly/i, "lost the honest-reporting rule");
  assert.match(sys, /Do what was asked, then stop/i, "lost scope discipline (cross-model evidenced)");
});

// ── The prompt must not lie about what the user can see ───────────────────────
// Measured on a real session (scripts/narration.mjs): 418 chars of prose per tool
// call against a 120-260 target, 56% of blocks over the two-sentence rule, one block
// of 46 sentences, and 10 identifiers re-derived across 3+ blocks. The cause was in
// the prompt, not the model: it asserted the user could not see tool calls, and then
// demonstrated "Let me read the file." as the house style. The abstract rule two
// paragraphs above it ("do not narrate routine steps") lost to the concrete example.

test("the prompt never claims tool calls are invisible to the user", () => {
  const p = basePrompt("PowerShell");
  // Both false statements, in the two places they appeared.
  assert.doesNotMatch(p, /do(es)? NOT see your tool calls/i);
  assert.doesNotMatch(p, /tool calls are not part of the visible text/i);
  // And it states the truth, which is what makes "add, don't repeat" make sense.
  assert.match(p, /SEES every tool call you make/);
});

test("the prompt does not model narration as the house style", () => {
  const p = basePrompt("PowerShell");
  // The literal exemplar that produced ~25 "Let me..." lines in one session.
  assert.doesNotMatch(p, /"Let me read the file\.?"/);
});

test("the between-steps budget is stated as a hard rule with an earned exception", () => {
  const p = basePrompt("PowerShell");
  assert.match(p, /ONE or TWO sentences/);
  // A budget with no exception gets ignored the first time it genuinely matters, so
  // the escape hatch has to exist — and be a TEST the model applies, not a list of
  // cases. Enumerating cases is the failure BOUNDARY.md already names.
  assert.match(p, /would act differently for knowing/);
  assert.match(p, /Length is earned by consequence/);
});

test("deliberation is directed out of the transcript, and repeats are forbidden", () => {
  const p = basePrompt("PowerShell");
  assert.match(p, /thinking does not belong in the transcript/);
  assert.match(p, /Once you have said what you are going to do, do it/);
});

test("carrying a fact forward is not a licence to restate results", () => {
  const p = basePrompt("PowerShell");
  // The old line said "anything from a tool result you will need later, write into
  // your reply", which reads as permission to recite output the user is looking at.
  assert.match(p, /Carry the fact, not the result/);
});

test("restating the picture so far is forbidden, not just restating a plan", () => {
  // The rule about plans did not cover FINDINGS. Measured on a live session: the same
  // "subscriptions and settings are already built" assessment appeared five times and
  // the status table twice, one full block after each lookup.
  const p = basePrompt("PowerShell");
  assert.match(p, /Never re-summarise the picture so far/);
  assert.match(p, /give the assessment ONCE/);
});

test("the final reply rules are complete, and live in the cached prompt", () => {
  // Observed: "read the roadmap and tell me what to do" answered with a bold section
  // label, a status recap nobody asked for, bullets, a numbered list with several
  // sentences of justification each, six further phases, a digression and two closing
  // questions. The RULES are what fixed that, and every clause below earned its place —
  // a number without examples is the version that lost. Their POSITION has since moved
  // into the cached prefix, because at the boundary they cost 645 tokens per step.
  const prompt = basePrompt("PowerShell");
  assert.match(prompt, /FOUR LINES OR FEWER/);
  assert.match(prompt, /After doing work, lead with the outcome in one plain line/);
  // One question per turn still, but it is now the closing offer rather than a
  // clarification the model stopped to ask.
  assert.match(prompt, /the ONE question a turn may ask/);
  assert.match(prompt, /Long is not thorough/);
  assert.match(prompt, /Examples of the right length/, "a number without examples is the version that lost");
  // And nothing re-sends them per request — that is the whole point of the move.
  assert.doesNotMatch(volatileContext("", false), /FOUR LINES OR FEWER/);
});

test("the reply rule forbids appending what was not asked for", () => {
  // The specific habit: answering the question, then volunteering an improvement nobody
  // asked about. The closing offer is NOT that — it names the step the finished work
  // implies — so the rule draws the line rather than banning the ending outright.
  assert.match(basePrompt("PowerShell"), /do not raise an adjacent improvement the finished work does not imply/);
});

test("the reply rule asks for what the user could not have seen", () => {
  // The one part of a turn that is not recoverable from the screen, and the part a later
  // trim "for brevity" would take first, since everything around it says what to leave out.
  const prompt = basePrompt("PowerShell");
  assert.match(prompt, /unexpected that you did not act on/);
  assert.match(prompt, /an invented next step is worse than none/, "the escape from a forced offer");
});
