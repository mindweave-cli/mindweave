/**
 * memory.test.ts — behaviour tests for the memory lane.
 *
 * Covers the pure compaction transforms (deterministic) and the on-disk store
 * (pointed at a temp HOME so it never touches the real ~/.mindweave). Run with
 * `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the home dir at a throwaway folder BEFORE importing the store, since
// sessionDir() reads it. Both vars: USERPROFILE on Windows, HOME on POSIX.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "mindweave-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const {
  estimateEntriesTokens,
  microcompact,
  spliceSummary,
  usableSummary,
  stripAnalysis,
} = await import("./compaction.js");
const { saveSession, loadTranscript, listSessions, latestSession } = await import("./store.js");
const { createSession, resumeSession, reconcileInterruptedTools } = await import("./session.js");
type Entry = import("./types.js").Entry;
type Session = import("./types.js").Session;

// ── compaction: microcompact ────────────────────────────────────────────────
function sampleTranscript(): Entry[] {
  return [
    { role: "user", content: "find the bug" },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }] },
    // Long enough to be worth clearing: a result smaller than its own stub is left alone.
    { role: "tool", toolCallId: "1", content: "src/a.ts\nline1\nline2\nline3" + "\n// more of the file, enough to be worth clearing".repeat(8) },
    { role: "assistant", content: "", toolCalls: [{ id: "2", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "2", content: "src/b.ts\nfresh content" },
    { role: "assistant", content: "found it" },
  ];
}

test("microcompact clears an OLD tool body, keeps its first line, leaves the rest", () => {
  const { entries, cleared, clearedIds } = microcompact(sampleTranscript(), 1);
  assert.equal(cleared, 1);
  // The cleared results are reported by id. Nothing mutates the read ledger off the
  // back of this any more — presence is re-derived from the transcript each step
  // (memory/presence.ts) — but the ids stay part of the transform's honest output.
  assert.deepEqual(clearedIds, ["1"]);
  // Old tool result (id 1) cleared: first line kept, body gone.
  const t1 = entries[2];
  assert.equal(t1.role, "tool");
  assert.match(t1.content, /src\/a\.ts/);
  assert.match(t1.content, /cleared to save context/);
  assert.doesNotMatch(t1.content, /line2/);
  // User/assistant untouched.
  assert.equal(entries[0].content, "find the bug");
});

test("microcompact never clears the most-recent tool round", () => {
  // keepLastN=0 would clear everything, but the round after the last
  // assistant tool-call must survive (the model hasn't acted on it yet).
  const { entries } = microcompact(sampleTranscript(), 0);
  const t2 = entries[4];
  assert.equal(t2.role, "tool");
  assert.match(t2.content, /fresh content/);
});

test("microcompact is idempotent", () => {
  const once = microcompact(sampleTranscript(), 1);
  const twice = microcompact(once.entries, 1);
  assert.equal(twice.cleared, 0);
});

// ── compaction: spliceSummary ─────────────────────────────────────────────────
test("spliceSummary replaces the prefix and strips the analysis scratchpad", () => {
  const out = spliceSummary(sampleTranscript(), "<analysis>scratch</analysis>NINE SECTIONS", 2);
  assert.equal(out[0].role, "summary");
  assert.match(out[0].content, /Continue as if the break/);
  assert.match(out[0].content, /NINE SECTIONS/);
  assert.doesNotMatch(out[0].content, /scratch/);
});

test("spliceSummary drops an orphaned leading tool result in the kept tail", () => {
  // keepLastN=1 keeps only the last entry; if that boundary started on a tool
  // result it would be orphaned (no parent assistant) — must be dropped.
  const transcript = sampleTranscript();
  transcript.push({ role: "assistant", content: "", toolCalls: [{ id: "3", name: "grep", arguments: "{}" }] });
  transcript.push({ role: "tool", toolCallId: "3", content: "hit" });
  const out = spliceSummary(transcript, "SUM", 1);
  // Only the summary survives — the lone tail tool result was an orphan.
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "summary");
});

test("estimateEntriesTokens counts content and tool-call arguments", () => {
  const small = estimateEntriesTokens([{ role: "user", content: "hi" }]);
  const big = estimateEntriesTokens([
    { role: "assistant", content: "x".repeat(3500), toolCalls: [{ id: "1", name: "write_file", arguments: "y".repeat(3500) }] },
  ]);
  assert.ok(big > small);
  assert.ok(big >= 2000); // ~3500/3.5 + ~3500/3.5
});

// ── store + session roundtrip ─────────────────────────────────────────────────
function makeSession(cwd: string, id: string, transcript: Entry[]): Session {
  return {
    id,
    cwd,
    createdAt: Date.now(),
    transcript,
    toolContext: { cwd, reads: new Map(), todos: [] },
    projectMemory: "",
    memoryDir: "",
    memoryIndex: "",
    priorSessions: 0,
    projectContext: "",
    governance: { rules: [], skills: [], forbidden: { patterns: [], root: cwd } },
    modelConfig: { model: "deepseek-v4-flash", thinking: false, effort: "high" },
  };
}

test("saveSession → loadTranscript roundtrips the transcript", async () => {
  const cwd = "/proj/alpha";
  const transcript: Entry[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  assert.equal(await saveSession(makeSession(cwd, "sess-a", transcript)), true);
  const loaded = await loadTranscript(cwd, "sess-a");
  assert.equal(loaded?.length, 2);
  assert.equal(loaded?.[0].content, "hello");
});

test("listSessions / latestSession surface saved sessions with prompts", async () => {
  const cwd = "/proj/beta";
  await saveSession(makeSession(cwd, "sess-b", [{ role: "user", content: "first task" }]));
  const list = await listSessions(cwd);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "sess-b");
  assert.match(list[0].firstPrompt, /first task/);
  assert.equal((await latestSession(cwd))?.id, "sess-b");
});

test("resumeSession reloads the most recent session's transcript", async () => {
  const cwd = "/proj/gamma";
  await saveSession(makeSession(cwd, "sess-c", [
    { role: "user", content: "resume me" },
    { role: "assistant", content: "ok" },
  ]));
  const resumed = await resumeSession(cwd);
  assert.ok(resumed);
  assert.equal(resumed!.id, "sess-c");
  assert.equal(resumed!.transcript.length, 2);
  assert.equal(resumed!.toolContext.reads.size, 0); // starts fresh
});

// ── crash/shutdown recovery: mid-tool transcripts must resume cleanly ─────────────

test("reconcileInterruptedTools repairs a mid-tool cutoff (dangling tool_calls)", () => {
  const transcript: Entry[] = [
    { role: "user", content: "install it" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "run_command", arguments: "{}" }] },
    // machine died here — no tool result for call_1
  ];
  const fixed = reconcileInterruptedTools(transcript);
  assert.equal(fixed.length, 3);
  assert.equal(fixed[2].role, "tool");
  assert.equal((fixed[2] as Extract<Entry, { role: "tool" }>).toolCallId, "call_1");
  assert.match((fixed[2] as Extract<Entry, { role: "tool" }>).content, /interrupted/i);
});

test("reconcileInterruptedTools leaves a complete transcript untouched (same ref)", () => {
  const transcript: Entry[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", content: "contents" },
  ];
  assert.equal(reconcileInterruptedTools(transcript), transcript);
});

test("reconcileInterruptedTools fills ONLY the unanswered calls in a partial batch", () => {
  const transcript: Entry[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "grep", arguments: "{}" },
        { id: "b", name: "run_command", arguments: "{}" },
      ],
    },
    { role: "tool", toolCallId: "a", content: "grep done" }, // 'b' never finished
  ];
  const fixed = reconcileInterruptedTools(transcript);
  const answered = fixed.filter((e) => e.role === "tool").map((e) => (e as Extract<Entry, { role: "tool" }>).toolCallId).sort();
  assert.deepEqual(answered, ["a", "b"]); // every call now has a result → valid to replay
});

test("resumeSession reconciles a session closed mid-tool so /continue can pick up", async () => {
  const cwd = "/proj/delta";
  await saveSession(makeSession(cwd, "sess-d", [
    { role: "user", content: "run the installer" },
    { role: "assistant", content: "", toolCalls: [{ id: "x1", name: "run_command", arguments: "{}" }] },
    // persisted mid-tool: no result for x1 (the exact crash shape)
  ]));
  const resumed = await resumeSession(cwd, "sess-d");
  assert.ok(resumed);
  const repaired = resumed!.transcript.find(
    (e) => e.role === "tool" && (e as Extract<Entry, { role: "tool" }>).toolCallId === "x1",
  );
  assert.ok(repaired, "the interrupted tool call got a synthetic result → replayable");
  assert.match((repaired as Extract<Entry, { role: "tool" }>).content, /interrupted|re-check/i);
});

test("createSession loads MINDWEAVE.md as project memory when present", async () => {
  const proj = mkdtempSync(join(tmpdir(), "mindweave-proj-"));
  await fs.writeFile(join(proj, "MINDWEAVE.md"), "Uses pnpm. Tests in __tests__.", "utf8");
  const s = await createSession(proj);
  assert.match(s.projectMemory, /pnpm/);
  assert.equal(s.transcript.length, 0);
});

// ── the summarizer reply is UNTRUSTED ─────────────────────────────────────────
// Replacing the transcript is the most destructive thing the system does. Every one
// of these was a way to do it with something unusable, silently.

test("a TRUNCATED summary is rejected — half a summary must not replace the session", () => {
  // The reply looks exactly like a finished one; only `stop` distinguishes them.
  assert.equal(usableSummary("1. Task: build the cart. 2. Files touched: cart.ts", "truncated"), null);
});

test("an all-scratchpad summary is rejected, not spliced in as nothing", () => {
  // The prompt ASKS for <analysis> first, so this is the reply of a model that never
  // got past thinking. It is non-empty before stripping and empty after, which is how
  // it used to pass the check and then wipe the transcript to a bare heading.
  assert.equal(usableSummary("<analysis>let me think about this…</analysis>"), null);
});

test("an UNCLOSED analysis block does not become the summary", () => {
  // A cut-off reply leaves an opening tag with no closing one. Everything after it is
  // thinking, so stripping must drop it rather than keep the scratchpad as the record.
  const cut = "<analysis>I should start by looking at the cart code and then";
  assert.equal(stripAnalysis(cut), "");
  assert.equal(usableSummary(cut), null);
});

test("empty and trivial replies are rejected", () => {
  assert.equal(usableSummary(""), null);
  assert.equal(usableSummary("   \n  "), null);
  assert.equal(usableSummary("ok"), null);
});

test("a real summary survives, with its scratchpad removed", () => {
  const reply = "<analysis>thinking</analysis>\n1. Task: build the shopping cart end to end.\n2. Files: cart.ts";
  const out = usableSummary(reply);
  assert.ok(out);
  assert.ok(!out.includes("thinking"));
  assert.ok(out.startsWith("1. Task:"));
});

test("a session is labelled by what the PERSON said, never by an engine nudge", async () => {
  // Observed live: the session picker described a session as "That was 3 sentences
  // between tool calls, where the budget is 2..." — the narration nudge. Nudges arrive
  // as `user` messages so the model reads them as instruction, which also made them
  // look like prompts to everything scanning for the last user message.
  const cwd = "/proj/nudge-label";
  await saveSession(
    makeSession(cwd, "sess-nudge", [
      { role: "user", content: "hello so, where we left last session please" },
      { role: "assistant", content: "Looking." },
      { role: "user", content: "That was 3 sentences between tool calls.", synthetic: true },
    ]),
  );
  const [meta] = await listSessions(cwd);
  assert.equal(meta.lastPrompt, "hello so, where we left last session please");
  assert.doesNotMatch(meta.lastPrompt, /sentences between tool calls/);
});

test("a nudge wedged between tool_calls and its results is moved back out", async () => {
  // Sessions written by one build hold this order permanently. Every resume of one
  // fails on the first request: "An assistant message with 'tool_calls' must be
  // followed by tool messages responding to each 'tool_call_id'." Repairing only the
  // producer leaves the user's saved work unopenable.
  const { repairToolCallOrder } = await import("./session.js");
  const broken: Entry[] = [
    { role: "user", content: "alright, let's do that then please." },
    { role: "assistant", content: "I'll build it.", toolCalls: [{ id: "a", name: "read_symbol", arguments: "{}" }, { id: "b", name: "read_symbol", arguments: "{}" }] },
    { role: "user", content: "That was 3 sentences between tool calls.", synthetic: true },
    { role: "tool", toolCallId: "a", content: "getSubscriptionCost ..." },
    { role: "tool", toolCallId: "b", content: "getTotalExpenses ..." },
  ];
  const fixed = repairToolCallOrder(broken);
  assert.deepEqual(fixed.map((e) => e.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.equal(fixed.at(-1)!.content, "That was 3 sentences between tool calls.", "the stranded message was dropped, not moved");
});

test("repair leaves a healthy transcript exactly as it was", async () => {
  const { repairToolCallOrder } = await import("./session.js");
  const healthy: Entry[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read_file", arguments: "{}" }] },
    { role: "tool", toolCallId: "a", content: "contents" },
    { role: "assistant", content: "done" },
  ];
  assert.equal(repairToolCallOrder(healthy), healthy, "an untouched transcript should be the same array");
});

test("repair does not swallow a real user message typed during a tool run", async () => {
  // The stranded entry may be something the person actually said. Repair moves it.
  const { repairToolCallOrder } = await import("./session.js");
  const t: Entry[] = [
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "run_command", arguments: "{}" }] },
    { role: "user", content: "actually stop" },
    { role: "tool", toolCallId: "a", content: "output" },
  ];
  const fixed = repairToolCallOrder(t);
  assert.deepEqual(fixed.map((e) => e.role), ["assistant", "tool", "user"]);
  assert.ok(fixed.some((e) => e.content === "actually stop"));
});

test("a saved session records which model answered", async () => {
  // Attribution used to be a side effect of cost logging: the model lived only inside
  // callLog entries, which are written only when a session actually spent something.
  // Most sessions therefore carried none, and the question "did the behaviour change,
  // or did the model change?" had no answer in anything on disk.
  const cwd = "/proj/model-recorded";
  const s = makeSession(cwd, "sess-model", [{ role: "user", content: "hi" }]);
  s.modelConfig = { ...s.modelConfig, model: "acme-v4-pro" as never };
  assert.equal(await saveSession(s), true);

  const list = await listSessions(cwd);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.model, "acme-v4-pro", "the session does not say which model answered");
});

test("the model is recorded even when the session spent nothing", async () => {
  // The whole point: a session with no call log is exactly the one that used to be
  // unattributable, and those are the short sessions worth comparing.
  const cwd = "/proj/model-nospend";
  const s = makeSession(cwd, "sess-quiet", [{ role: "user", content: "hi" }]);
  assert.equal(await saveSession(s), true);
  const meta = (await listSessions(cwd))[0]!;
  assert.equal(meta.model, "deepseek-v4-flash");
  assert.ok(!meta.callLog, "this session has no call log, which is the case that mattered");
});
