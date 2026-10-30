/**
 * settleDraft.test.ts — a reply a gate set aside, when the turn ends before the model replies again.
 *
 * Seen as: a turn that ran a dozen commands and then failed at the provider showed no answer, and the session reopened with
 * the commands split in two around a reply nobody had seen. The reply had been written, dropped from the screen by the verify
 * gate, and left in the middle of the saved conversation because the turn ended before the replacement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { settleUnansweredDraft } from "./engine.js";
import type { Session } from "../memory/types.js";

const session = (transcript: unknown[]): Session => ({ transcript } as unknown as Session);
const tool = (id: string) => ({ role: "tool", toolCallId: id, content: "ok" });
const call = (id: string) => ({ role: "assistant", content: "", toolCalls: [{ id, name: "run_command", arguments: {} }] });
const NUDGE = { role: "user", content: "You edited files this turn but never ran a check.", synthetic: true };

test("the draft leaves the middle of the work and becomes the last reply, shown once", () => {
  const s = session([{ role: "user", content: "go" }, call("1"), tool("1"), { role: "assistant", content: "Done. The app passes." }, NUDGE, call("2"), tool("2")]);
  const shown: string[] = [];
  const reply = settleUnansweredDraft(s, [3], (e) => shown.push(e.delta));
  assert.equal(reply, "Done. The app passes.");
  assert.deepEqual(shown, ["Done. The app passes."]);
  const t = s.transcript as Array<{ role: string; content?: string }>;
  assert.deepEqual(t.map((e) => e.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  assert.equal(t[t.length - 1]!.content, "Done. The app passes.");
  assert.ok(!t.some((e) => (e as { synthetic?: boolean }).synthetic), "the gate's instruction is gone");
});

test("a turn that was stopped keeps one assistant entry at the end, not two in a row", () => {
  const s = session([{ role: "user", content: "go" }, { role: "assistant", content: "First answer." }, NUDGE, call("2"), tool("2"), { role: "assistant", content: "(interrupted)" }]);
  settleUnansweredDraft(s, [1]);
  const t = s.transcript as Array<{ role: string; content?: string }>;
  assert.deepEqual(t.map((e) => e.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(t[t.length - 1]!.content, "First answer.\n\n(interrupted)");
});

test("nothing is touched when no gate set a draft aside, or the positions no longer match", () => {
  const plain = [{ role: "user", content: "go" }, { role: "assistant", content: "Hello" }];
  const s = session([...plain]);
  assert.equal(settleUnansweredDraft(s, [null, null]), null);
  assert.deepEqual(s.transcript, plain);
  assert.equal(settleUnansweredDraft(s, [1]), null, "an assistant entry with no instruction after it is a real reply");
  assert.deepEqual(s.transcript, plain);
  assert.equal(settleUnansweredDraft(s, [9]), null, "out of range");
});

test("two drafts set aside: the later one is the reply and both instructions go", () => {
  const s = session([
    { role: "user", content: "go" },
    { role: "assistant", content: "Long first draft." },
    { role: "user", content: "Rewrite it shorter.", synthetic: true },
    call("1"),
    tool("1"),
    { role: "assistant", content: "Second draft." },
    NUDGE,
    call("2"),
    tool("2"),
  ]);
  assert.equal(settleUnansweredDraft(s, [1, 5]), "Second draft.");
  const t = s.transcript as Array<{ role: string; content?: string }>;
  assert.deepEqual(t.map((e) => e.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  assert.equal(t[t.length - 1]!.content, "Second draft.");
});

import { findUnsettledDrafts } from "../memory/unsettled.js";
import { VERIFY_NUDGE, replyRewrite } from "./verify.js";
import type { Entry } from "../memory/types.js";

test("a saved conversation is repaired only where a gate's reply was never replaced", () => {
  const draft = { role: "assistant", content: "Done." };
  const gate = { role: "user", content: VERIFY_NUDGE, synthetic: true };
  const open = [{ role: "user", content: "go" }, draft, gate, call("1"), tool("1")] as unknown as Entry[];
  assert.deepEqual(findUnsettledDrafts(open), [1]);
  const concluded = [...open, { role: "assistant", content: "Really done." }] as unknown as Entry[];
  assert.deepEqual(findUnsettledDrafts(concluded), [], "the model did reply again");
  const rewrite = { role: "user", content: replyRewrite({ kind: "length", detail: "40 lines" } as never), synthetic: true };
  assert.deepEqual(findUnsettledDrafts([{ role: "user", content: "go" }, draft, rewrite] as unknown as Entry[]), [1], "the reply gate's rewrite request counts too");
  const hook = { role: "user", content: "A hook the user set up says not to finish yet: x", synthetic: true };
  assert.deepEqual(findUnsettledDrafts([{ role: "user", content: "go" }, draft, hook] as unknown as Entry[]), [], "a Stop hook's reply is left as it is");
});
