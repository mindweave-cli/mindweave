/**
 * messageQueue.test.ts — the rules a queued message obeys.
 *
 * Every case here is one a user hit or could hit: a message that came back doubled,
 * a slash command swallowed into prose, a footer tall enough to break the frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drain, isCommand, popAll, queueMessage, takeSteerable, visibleQueue, MAX_VISIBLE_QUEUED } from "./messageQueue.js";

/** The queue as it is actually built: every entry goes through the same factory the
 *  app uses, so a test can never assert against a shape the app cannot produce. */
const q = (...texts: string[]) => texts.map((t) => queueMessage(t));
/** The same, for messages typed after Esc. */
const afterEsc = (...texts: string[]) => texts.map((t) => queueMessage(t, { interrupting: true }));
/** Just the text of each entry, for comparing against what was typed. */
const texts = (entries: readonly { text: string }[]) => entries.map((e) => e.text);

test("an empty queue has nothing to send and nothing to pop", () => {
  assert.equal(drain([]), undefined);
  assert.equal(popAll([], "", 0), undefined);
  // Not the same as popping an empty string: the caller must be able to tell
  // "nothing was queued" from "a blank message was queued", because on Esc the
  // first has to fall through to the interrupt and the second must not.
  assert.equal(popAll([], "half a thought", 4), undefined);
});

test("messages typed one after another are sent as ONE turn", () => {
  const d = drain(q("fix the test", "and the types", "then build"))!;
  assert.equal(d.rest.length, 0, "something was left queued — this will cost an extra turn");
  assert.match(d.send, /fix the test/);
  assert.match(d.send, /and the types/);
  assert.match(d.send, /then build/);
});

test("they are separated so they don't read as one rambling line", () => {
  const d = drain(q("first", "second"))!;
  assert.equal(d.send, "first\n\nsecond");
});

test("a slash command goes alone, and does not swallow what follows", () => {
  // Batched, `/model` would be sent to the model as the literal word and nothing
  // would switch.
  const d = drain(q("/model", "now use the new one"))!;
  assert.equal(d.send, "/model");
  assert.deepEqual(texts(d.rest), ["now use the new one"]);
});

test("prose stops at a command instead of absorbing it", () => {
  const d = drain(q("fix it", "add a test", "/undo"))!;
  assert.equal(d.send, "fix it\n\nadd a test");
  assert.deepEqual(texts(d.rest), ["/undo"], "the command was consumed as text");
});

test("a command is recognised through leading whitespace", () => {
  assert.equal(isCommand("  /help"), true);
  assert.equal(isCommand("what does / mean"), false);
  assert.equal(isCommand("http://x/y"), false);
});

test("draining repeatedly empties the queue and never loops", () => {
  let pending = q("a", "/model", "b", "c");
  const sent: string[] = [];
  for (let i = 0; i < 10 && pending.length > 0; i++) {
    const d = drain(pending)!;
    assert.ok(d.rest.length < pending.length, "a drain that removed nothing would spin forever");
    sent.push(d.send);
    pending = d.rest;
  }
  assert.deepEqual(sent, ["a", "/model", "b\n\nc"]);
  assert.equal(pending.length, 0);
});

test("popping brings back EVERY queued message, not just the last", () => {
  // The bug this replaces: ↑ showed the last message from history while the queue
  // kept all of them, so editing and sending produced a duplicate.
  const p = popAll(q("one", "two", "three"), "", 0)!;
  assert.equal(p.text, "one\ntwo\nthree");
  assert.equal(p.cursor, p.text.length, "cursor is not at the end of what was restored");
});

test("a half-typed line survives the pop, and lands after the queue", () => {
  const p = popAll(q("queued one"), "typing thi", 10)!;
  assert.equal(p.text, "queued one\ntyping thi");
  assert.equal(
    p.text.slice(p.cursor),
    "",
    "the cursor did not follow the draft — the user resumes typing in the wrong place",
  );
  assert.equal(p.cursor, "queued one".length + 1 + 10);
});

test("the cursor keeps its place inside the draft, not just at the end", () => {
  const p = popAll(q("q"), "abcdef", 3)!;
  assert.equal(p.text, "q\nabcdef");
  assert.equal(p.text.slice(0, p.cursor), "q\nabc", "cursor drifted within the draft");
});

test("the footer never grows without limit", () => {
  const many = q(...Array.from({ length: 9 }, (_, i) => `msg ${i + 1}`));
  const v = visibleQueue(many);
  assert.equal(v.rows.length, MAX_VISIBLE_QUEUED);
  assert.equal(v.hidden, 9 - MAX_VISIBLE_QUEUED, "hidden messages are not accounted for");
  // A footer taller than the terminal corrupts the frame rather than clipping it.
  assert.ok(v.rows.length <= MAX_VISIBLE_QUEUED);
});

test("a short queue is shown whole, with nothing claimed hidden", () => {
  const v = visibleQueue(q("a", "b"));
  assert.deepEqual(texts(v.rows), ["a", "b"]);
  assert.equal(v.hidden, 0);
});

// ── steering: what may be handed to a turn that is already running ────────────
// The failure this replaces is not a crash. It is a message sitting in the footer,
// unread, while the thing it was about finishes anyway.

test("prose typed while working is handed to the running turn, all of it", () => {
  const pending = q("actually use the other file", "and skip the tests");
  const { send, rest } = takeSteerable(pending);
  assert.deepEqual(send, pending);
  assert.deepEqual(rest, []);
});

test("a slash command is NEVER steered — it needs the turn to be over", () => {
  // `/model` mid-flight would change models between two calls of one conversation.
  const { send, rest } = takeSteerable(q("/model", "and use haiku"));
  assert.deepEqual(send, []);
  assert.deepEqual(texts(rest), ["/model", "and use haiku"]);
});

test("nothing jumps ahead of a queued command", () => {
  // Typed in this order, "now try again" was meant to come AFTER the switch. Steering
  // it would run the three in an order the user never typed.
  const { send, rest } = takeSteerable(q("stop editing that", "/model", "now try again"));
  assert.deepEqual(texts(send), ["stop editing that"]);
  assert.deepEqual(texts(rest), ["/model", "now try again"]);
});

test("an empty queue steers nothing, and says so without allocating a turn", () => {
  const { send, rest } = takeSteerable([]);
  assert.deepEqual(send, []);
  assert.deepEqual(rest, []);
});

test("what steering leaves behind is exactly what the turn-end drain expects", () => {
  // The two drains have to compose: whatever is not steerable must still be sendable at
  // the boundary, or a queued command would be stranded forever.
  const { rest } = takeSteerable(q("fix the header", "/compact", "then push"));
  const first = drain(rest)!;
  assert.equal(first.send, "/compact");
  const second = drain(first.rest)!;
  assert.equal(second.send, "then push");
  assert.deepEqual(second.rest, []);
});

test("steering does not batch: each message stays its own", () => {
  // The turn-end drain joins consecutive prose into one turn, because it is building
  // ONE request out of them. Steering appends them to a conversation that already
  // exists, so each keeps its own line — and the chat shows one line per message, which
  // is only true if the transcript holds one entry per message too.
  const { send } = takeSteerable(q("first", "second"));
  assert.equal(send.length, 2);
  assert.deepEqual(texts(send), ["first", "second"]);
  assert.equal(drain(q("first", "second"))?.send, "first\n\nsecond");
});

test("the queue is actually WIRED to the running turn", async () => {
  // Mechanical, because the rules above pass whether or not anything calls them — which
  // is exactly how the queue sat unread for a whole turn while its own tests were green.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  assert.match(app, /steer: \(\) => steerRunningTurn\(s\)/, "the turn is started without a way to receive messages");
  const handler = app.slice(app.indexOf("async function steerRunningTurn"));
  assert.ok(handler.length > 0, "nothing answers the engine when it asks");

  // Drained through the shared rule, not by a second copy of it here.
  assert.match(handler.slice(0, 900), /takeSteerable\(queueRef\.current\)/, "the drain does not use the queue's own rule");
  // And shown in the chat AS IT GOES, through the pacer, so it lands in the order it
  // happened rather than after the tool rows that came later.
  assert.match(handler.slice(0, 2000), /\{ type: "user", text: displayText \}/, "a steered message is sent without ever appearing on screen");
  assert.match(handler.slice(0, 2000), /enqueueReveal\(a\)/, "a steered message skips the pacer");
  assert.match(handler.slice(0, 2000), /setDeparting\(/, "a steered message vanishes from the queue line before it reaches the chat");
});

// ── "now": typed after Esc, and therefore NOT for the turn being killed ───────
// Esc, then a fast correction. Without a priority of its own the correction is
// steerable, so it is fed into the turn the user just stopped — the stop happens, and
// then the very work that was stopped carries out the note about why.

test("a message typed after Esc is never steered into the dying turn", () => {
  const { send, rest } = takeSteerable(afterEsc("no, leave that file alone"));
  assert.deepEqual(send, [], "the message was handed to the turn the user had just stopped");
  assert.equal(rest.length, 1);
  assert.equal(rest[0]!.priority, "now");
});

test("it blocks steering of anything typed behind it, in order", () => {
  // Typed before Esc, then Esc, then more. The first was for the running turn, but the
  // turn is now being killed and the rest belong to what comes after it. Sending the
  // first into a dying turn and the rest into the next one would split one train of
  // thought across two turns.
  const pending = [...q("try the other parser"), ...afterEsc("actually stop"), ...q("start over")];
  const { send, rest } = takeSteerable(pending);
  assert.deepEqual(texts(send), ["try the other parser"]);
  assert.deepEqual(texts(rest), ["actually stop", "start over"]);
});

test("it goes as its own turn, never merged into the prose around it", () => {
  // The model is told the work was cut off on purpose, and that is only true of this
  // message. Batching it with an ordinary one would apply that to text it is false of.
  const first = drain([...afterEsc("stop"), ...q("and do this instead")])!;
  assert.equal(first.send, "stop");
  assert.equal(first.priority, "now");
  const second = drain(first.rest)!;
  assert.equal(second.send, "and do this instead");
  assert.equal(second.priority, "next");
});

test("the drain says WHICH kind it handed over, so the sender can frame it", () => {
  // The priority is not internal bookkeeping: it decides what the model is told about
  // how the message arrived. Losing it here loses the framing.
  assert.equal(drain(q("plain"))!.priority, "next");
  assert.equal(drain(afterEsc("after esc"))!.priority, "now");
  assert.equal(drain(q("/model"))!.priority, "later");
});

test("a slash command is a command whether or not Esc was pressed", () => {
  // Esc does not turn `/undo` into something to say to the model.
  assert.equal(queueMessage("/undo", { interrupting: true }).priority, "later");
  assert.equal(queueMessage("/undo").priority, "later");
});

test("popping brings back what was typed after Esc too", () => {
  // It is still a message the user wrote and may want to change; nothing about the
  // priority makes it un-editable.
  const p = popAll([...q("one"), ...afterEsc("two")], "", 0)!;
  assert.equal(p.text, "one\ntwo");
});

test("Esc actually sets the flag, and a new turn clears it", async () => {
  // Mechanical, because the whole tier hangs off one boolean and nothing else would
  // notice it being wrong: never set, and a post-Esc message is steered into the turn
  // the user stopped; never cleared, and every message for the rest of the session is
  // framed as an interrupt.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  const esc = app.slice(app.indexOf("if (key.escape) {"), app.indexOf("if (key.escape) {") + 500);
  assert.match(esc, /interrupting\.current = true/, "Esc does not mark the gap before the next turn");

  const start = app.slice(app.indexOf("function startTurn()"), app.indexOf("function startTurn()") + 500);
  assert.match(start, /interrupting\.current = false/, "the flag is never cleared, so it latches on for the session");

  // And it has to reach the queue, or it is a flag nothing reads.
  assert.match(app, /queueMessage\(text, \{ interrupting: interrupting\.current \}\)/, "the flag never reaches the queue");
  // And the priority has to reach the message, or the model is never told.
  assert.match(app, /arrival: next\.priority === "now" \? "interrupting" : undefined/, "the priority is dropped on the way out");
});

// ── the person's own shell commands, typed after ! ──────────────────────────────

test("a ! command queues like a slash command: it waits for the turn to end and goes on its own", () => {
  assert.equal(queueMessage("!git status").priority, "later");
  assert.equal(isCommand("!x"), true);
  assert.equal(isCommand("   !x"), true);
  assert.equal(isCommand("hello !x"), false, "a ! that is not the first character is just text");
});

test("a ! command is never steered into a turn that is running", () => {
  const queue = [queueMessage("fix the bug"), queueMessage("!npm test"), queueMessage("and the other bug")];
  const { send, rest } = takeSteerable(queue);
  assert.deepEqual(send.map((q) => q.text), ["fix the bug"]);
  assert.deepEqual(rest.map((q) => q.text), ["!npm test", "and the other bug"], "order kept, nothing overtakes the command");
});

test("after the turn a ! command goes alone, and the messages around it are not merged into it", () => {
  const queue = [queueMessage("a"), queueMessage("b"), queueMessage("!echo x"), queueMessage("c")];
  const first = drain(queue)!;
  assert.equal(first.send, "a\n\nb");
  const second = drain(first.rest)!;
  assert.equal(second.send, "!echo x");
  assert.equal(second.priority, "later");
  const third = drain(second.rest)!;
  assert.equal(third.send, "c");
});

test("a ! command typed right after Esc is still a command, not a message that interrupts", () => {
  assert.equal(queueMessage("!echo x", { interrupting: true }).priority, "later");
  assert.equal(queueMessage("echo x", { interrupting: true }).priority, "now");
});

// ── send now (ctrl+F) ─────────────────────────────────────────────────────────

test("send-now keeps the promises it was built on (source-enforced, as the Esc handler is)", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const input = await readFile(new URL("./components/PromptInput.tsx", import.meta.url), "utf8");
  // 1. A stopped turn takes nothing in: a message queued before Esc used to be steered into the turn that was
  //    being cancelled, drawn in the chat, and never answered.
  const steer = app.slice(app.indexOf("async function steerRunningTurn"), app.indexOf("async function steerRunningTurn") + 900);
  assert.match(steer, /if \(abortRef\.current\?\.signal\.aborted\) return \[\];/, "steering into a stopped turn would lose the message");
  // 2. Send-now is the queue, made quicker. It must never stop, abort or kill anything: a command moves to the
  //    background and keeps running, and everything else is left alone.
  const force = app.slice(app.indexOf("function forceSend"), app.indexOf("function forceSend") + 2200);
  assert.doesNotMatch(force, /\.abort\(|\.kill\(|stopUi|dismissWaiting/, "ctrl+F destroys nothing; only Esc stops things");
  assert.match(force, /pressBackground\(/, "a command in the way is moved to the background, as ctrl+X does");
  assert.match(force, /queueMessage\(text/, "the message goes through the same queue as Enter");
  // 3. The key reaches it from the box that knows what is typed.
  assert.match(input, /key\.ctrl && input === "f" && onForceSend/);
});
