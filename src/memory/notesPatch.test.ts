/**
 * notesPatch.test.ts — the session notes are updated by saying what changed, not by writing the
 * whole document again.
 *
 * Writing the whole thing back cost as many output tokens as the notes are long (6.5K for a 25 KB
 * document, per refresh, several in a minute during busy work), and a document long enough no longer
 * fits in one answer: the reply was cut off, thrown away, and paid for again at the next refresh. A
 * changed section is a few hundred tokens however long the notes have grown. These pin the reply
 * format, how it is folded in, what is refused, and the two ways the call is made: standing alone,
 * or on the main request so the provider reads the conversation from its cache.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_MEMORY_TEMPLATE,
  applyNotesPatch,
  notesAreUsable,
  oversizedSections,
  parseNotesPatch,
  saysNothingChanged,
  updateSessionMemory,
} from "./sessionMemory.js";
import { createSession } from "./session.js";
import { stopChassis } from "../alternator/lane.js";
import type { ModelRequest } from "../drivers/types.js";
import type { Entry, Session } from "./types.js";

// ── a document to change ──────────────────────────────────────────────────────
const DESC = {
  state: "_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._",
  worklog: "_Step by step, what was attempted, done? Very terse summary for each step_",
};

const NOTES = SESSION_MEMORY_TEMPLATE.replace("# Session Title\n_", "# Session Title\n_")
  .replace(DESC.state, `${DESC.state}\nreducers are half rewritten`)
  .replace(DESC.worklog, `${DESC.worklog}\n1. read the sidebar\n2. changed the model`);

// ── reading a reply ───────────────────────────────────────────────────────────
test("a reply names the sections that change, and only those", () => {
  const patch = parseNotesPatch("# Current State\nthe sidebar renders folders\n\n# Worklog\nAPPEND:\n3. wired the drag handlers");
  assert.deepEqual([...patch.keys()], ["# Current State", "# Worklog"]);
  assert.deepEqual(patch.get("# Current State"), { mode: "set", body: "the sidebar renders folders" });
  assert.deepEqual(patch.get("# Worklog"), { mode: "append", body: "3. wired the drag handlers" });
});

test("only a template heading starts a section, so a chatty or fenced reply still parses", () => {
  const reply = [
    "Sure, here is the update.",
    "```",
    "# Current State",
    "the parser works",
    "# A heading of the model's own",
    "still part of the section",
    "```",
  ].join("\n");
  const patch = parseNotesPatch(reply);
  assert.deepEqual([...patch.keys()], ["# Current State"], "the preamble and the made-up heading start nothing");
  assert.match(patch.get("# Current State")!.body, /the parser works\n# A heading of the model's own\nstill part of the section/);
});

test("the italic description a model repeats is not content", () => {
  const patch = parseNotesPatch(`# Current State\n${DESC.state}\nnow doing the sidebar`);
  assert.equal(patch.get("# Current State")!.body, "now doing the sidebar");
});

test("filler sections are not changes", () => {
  const patch = parseNotesPatch("# Learnings\nN/A\n\n# Key results\nno change\n\n# Workflow\nnpm run build, then the checks");
  assert.deepEqual([...patch.keys()], ["# Workflow"]);
});

test("a reply cut off by the output limit loses its last section, which is the incomplete one", () => {
  const reply = "# Current State\nfinished the model\n\n# Worklog\nAPPEND:\n3. wired the dr";
  assert.deepEqual([...parseNotesPatch(reply, true).keys()], ["# Current State"]);
  assert.deepEqual([...parseNotesPatch(reply, false).keys()], ["# Current State", "# Worklog"]);
});

test("'nothing changed' is an answer, and a refusal is not", () => {
  assert.equal(saysNothingChanged("NO CHANGES."), true);
  assert.equal(saysNothingChanged("Nothing new since the notes were written."), true);
  assert.equal(saysNothingChanged("I'm sorry, I can't help with that."), false);
  assert.equal(parseNotesPatch("I'm sorry, I can't help with that.").size, 0);
});

// ── folding it in ─────────────────────────────────────────────────────────────
test("a listed section replaces the old one and the rest of the document is untouched", () => {
  const { notes, changed } = applyNotesPatch(NOTES, parseNotesPatch("# Current State\nthe sidebar renders folders"));
  assert.deepEqual(changed, ["# Current State"]);
  assert.match(notes, /the sidebar renders folders/);
  assert.doesNotMatch(notes, /reducers are half rewritten/);
  assert.ok(notes.includes(DESC.state), "the section's own description is kept");
  const before = NOTES.slice(NOTES.indexOf("# Task specification"));
  assert.equal(notes.slice(notes.indexOf("# Task specification")), before, "every later section is byte for byte what it was");
});

test("APPEND adds to a section without rewriting it", () => {
  const { notes, changed } = applyNotesPatch(NOTES, parseNotesPatch("# Worklog\nAPPEND:\n3. wired the drag handlers"));
  assert.deepEqual(changed, ["# Worklog"]);
  assert.match(notes, /1\. read the sidebar\n2\. changed the model\n3\. wired the drag handlers/);
});

test("a section the notes lack is added from the template", () => {
  const old = NOTES.replace(/\n# Key results[\s\S]*?(?=\n# Worklog)/, "");
  assert.doesNotMatch(old, /# Key results/);
  const { notes } = applyNotesPatch(old, parseNotesPatch("# Key results\nthe export is 55/55"));
  assert.match(notes, /# Key results\n_[^\n]+_\nthe export is 55\/55/);
});

test("a reply that only repeats the notes changes nothing and refuses nothing", () => {
  const { notes, changed, refused } = applyNotesPatch(NOTES, parseNotesPatch("# Current State\nreducers are half rewritten"));
  assert.deepEqual([changed, refused], [[], []]);
  assert.equal(notes, NOTES);
});

test("a replacement that would throw away most of a long section is refused", () => {
  const long = NOTES.replace("1. read the sidebar", "1. read the sidebar\n" + "a detailed line of the log that carries real information\n".repeat(40));
  const { notes, changed, refused } = applyNotesPatch(long, parseNotesPatch("# Worklog\ndone"));
  assert.deepEqual([changed, refused], [[], ["# Worklog"]]);
  assert.match(notes, /a detailed line of the log/, "the record survives a bad answer");
  // ...but appending is always fine, and a real condensation (a quarter or more kept) is allowed.
  assert.deepEqual(applyNotesPatch(long, parseNotesPatch("# Worklog\nAPPEND:\n3. more")).changed, ["# Worklog"]);
});

test("what comes out is still a whole, usable notes document", () => {
  const { notes } = applyNotesPatch(NOTES, parseNotesPatch("# Current State\nnew state\n\n# Worklog\nAPPEND:\n3. step"));
  assert.equal(notesAreUsable(NOTES, notes), true);
});

test("a section over its budget is named, so the writer is told to rewrite it shorter", () => {
  assert.deepEqual(oversizedSections(NOTES), []);
  const fat = NOTES.replace("2. changed the model", "2. changed the model\n" + "x".repeat(9_000));
  assert.deepEqual(oversizedSections(fat), ["Worklog"]);
});

// ── the call ──────────────────────────────────────────────────────────────────
let bodies: Record<string, unknown>[] = [];
let replies: { content?: string; toolCalls?: boolean; finish?: string; status?: number }[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      const next = replies.shift() ?? { content: "NO CHANGES." };
      if (next.status && next.status >= 400) {
        res.writeHead(next.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "the provider refused" } }));
        return;
      }
      const message = next.toolCalls
        ? { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] }
        : { content: next.content ?? "" };
      const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: next.finish ?? (next.toolCalls ? "tool_calls" : "stop") }], usage }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

const marked = (count: number): Entry[] =>
  Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `entry-marker-${i}` }) as Entry);

async function withSession<T>(fn: (s: Session) => Promise<T>, entries = 6): Promise<T> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-notes-patch-")));
  const s = await createSession(root);
  s.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  s.transcript.push(...marked(entries));
  s.sessionMemory = NOTES;
  s.sessionMemoryInit = true;
  s.sessionMemoryEntries = 2;
  bodies = [];
  replies = [];
  try {
    return await fn(s);
  } finally {
    await stopChassis(s.toolContext.chassis).catch(() => {});
  }
}

const messagesOf = (body: Record<string, unknown>) => body["messages"] as { role: string; content: string }[];
const textOf = (body: Record<string, unknown>) => messagesOf(body).map((m) => m.content).join("\n");

test("standing alone, it sends the unseen entries and takes back only the changed sections", () =>
  withSession(async (s) => {
    replies = [{ content: "# Current State\nthe sidebar renders folders" }];
    assert.equal(await updateSessionMemory(s), true);
    const sent = textOf(bodies[0]!);
    assert.ok(sent.includes("entry-marker-2") && sent.includes("entry-marker-5"), "what the notes have not seen");
    assert.ok(!sent.includes("entry-marker-0"), "not what they have");
    assert.match(sent, /Reply with ONLY the sections of the notes that need to change/);
    assert.match(s.sessionMemory!, /the sidebar renders folders/);
    assert.match(s.sessionMemory!, /1\. read the sidebar/, "the sections it did not mention are intact");
    assert.equal(s.sessionMemoryEntries, 6);
  }));

test("'nothing changed' keeps the notes and still moves the boundary", () =>
  withSession(async (s) => {
    replies = [{ content: "NO CHANGES." }];
    assert.equal(await updateSessionMemory(s), true);
    assert.equal(s.sessionMemory, NOTES);
    assert.equal(s.sessionMemoryEntries, 6, "what was read is covered, even with nothing to say about it");
  }));

test("a refusal, a collapse and a cut-off answer all keep the last good notes", () =>
  withSession(async (s) => {
    replies = [{ content: "I can't help with that." }];
    assert.equal(await updateSessionMemory(s), false);
    assert.equal(s.sessionMemory, NOTES);
    assert.equal(s.sessionMemoryEntries, 2, "nothing was recorded as covered");
    // Cut off in the only section it gave: nothing complete is left to use.
    replies = [{ content: "# Worklog\nAPPEND:\n3. wired the dr", finish: "length" }];
    assert.equal(await updateSessionMemory(s), false);
    assert.equal(s.sessionMemory, NOTES);
  }));

test("a cut-off answer still gives the sections that were finished", () =>
  withSession(async (s) => {
    replies = [{ content: "# Current State\nthe model is done\n\n# Worklog\nAPPEND:\n3. wired the dr", finish: "length" }];
    assert.equal(await updateSessionMemory(s), true);
    assert.match(s.sessionMemory!, /the model is done/);
    assert.doesNotMatch(s.sessionMemory!, /wired the dr/, "the half-written section was not used");
  }));

// A request standing in for the main one: its own system prompt, a conversation, a volatile tail.
function mainRequest(): ModelRequest {
  return {
    system: "THE MAIN SYSTEM PROMPT",
    messages: [
      { role: "user", content: "main-conversation-first" },
      { role: "assistant", content: "main-conversation-second" },
      { role: "user", content: "main-conversation-third" },
    ],
    context: "THE VOLATILE TAIL",
    model: { model: "gemini-3.7-flash", thinking: false, effort: "high" },
  };
}

test("built on the main request, the call carries the real conversation and puts its instruction after it", () =>
  withSession(async (s) => {
    replies = [{ content: "# Current State\nfrom the shared call" }];
    const request = mainRequest();
    assert.equal(await updateSessionMemory(s, undefined, undefined, async () => ({ request, entries: 6, last: s.transcript[5]! })), true);
    assert.equal(bodies.length, 1);
    const wire = messagesOf(bodies[0]!);
    assert.equal(wire[0]!.content, "THE MAIN SYSTEM PROMPT", "the same system prompt, so the cached prefix matches");
    assert.deepEqual(
      wire.slice(1, 4).map((m) => m.content),
      request.messages.map((m) => m.content),
      "then the conversation exactly as the main request sent it",
    );
    assert.equal(wire.length, 5, "and one message more");
    const last = wire.at(-1)!;
    assert.equal(last.role, "user");
    assert.match(last.content, /CURRENT NOTES\. They already cover everything up to and including the assistant message that begins: "entry-marker-1"/);
    assert.match(last.content, /Reply with ONLY the sections/);
    assert.ok(!textOf(bodies[0]!).includes("THE VOLATILE TAIL"), "the volatile tail would sit between the cached part and the instruction");
    assert.match(s.sessionMemory!, /from the shared call/);
    assert.equal(s.sessionMemoryEntries, 6, "covers what the request carried");
  }));

test("when the main request is refused, the plain call is made instead, in the same refresh", () =>
  withSession(async (s) => {
    replies = [{ status: 400 }, { content: "# Current State\nfrom the plain call" }];
    assert.equal(await updateSessionMemory(s, undefined, undefined, async () => ({ request: mainRequest(), entries: 6, last: s.transcript[5]! })), true);
    assert.equal(bodies.length, 2);
    assert.ok(textOf(bodies[0]!).includes("main-conversation-first"), "first the shared attempt");
    assert.ok(!textOf(bodies[1]!).includes("main-conversation-first"), "then the stand-alone one, with its own prompt");
    assert.match(s.sessionMemory!, /from the plain call/);
    assert.equal(s.sharedNotesOff, undefined, "a refusal is not a reason to stop trying it");
  }));

test("a model that answers the main request with a tool call is not asked that way again", () =>
  withSession(async (s) => {
    replies = [{ toolCalls: true }, { content: "# Current State\nfrom the plain call" }];
    const shared = async () => ({ request: mainRequest(), entries: 6, last: s.transcript[5]! });
    assert.equal(await updateSessionMemory(s, undefined, undefined, shared), true);
    assert.equal(s.sharedNotesOff, true);
    assert.equal(bodies.length, 2);
    // The next refresh does not even build the shared request.
    replies = [{ content: "NO CHANGES." }];
    let asked = 0;
    await updateSessionMemory(s, undefined, undefined, async () => (asked++, { request: mainRequest(), entries: 6, last: s.transcript[5]! }));
    assert.equal(asked, 0);
  }));

test("a shared request whose entries moved while the call was out is dropped, not claimed", () =>
  withSession(async (s) => {
    replies = [{ content: "# Current State\nwritten about entries that moved" }];
    const before = s.sessionMemory;
    const run = updateSessionMemory(s, undefined, undefined, async () => {
      const prefix = { request: mainRequest(), entries: 6, last: s.transcript[5]! };
      // The conversation is compacted while the notes call is being prepared.
      s.transcript = [{ role: "summary", content: "earlier" } as Entry, ...s.transcript.slice(-2)];
      return prefix;
    });
    assert.equal(await run, false);
    assert.equal(s.sessionMemory, before);
  }));
