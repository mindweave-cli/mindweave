/**
 * sessionMemoryRefresh.test.ts — the notes are refreshed during the work, from what they have
 * not seen, and always say exactly how much they cover.
 *
 * A real session lost its footing because its notes lagged behind it. These pin the parts of
 * keeping them current that cannot fail loudly: a refresh that runs while the transcript
 * grows must record what it READ, one that straddles a compaction must not claim anything, two
 * must not run at once, and how far the notes reach must survive closing the session.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshSessionMemory, settleSessionMemory, SESSION_MEMORY_TEMPLATE } from "./sessionMemory.js";
import { replaceTranscript } from "./earlier.js";
import { createSession, resumeSession } from "./session.js";
import { saveSession } from "./store.js";
import { stopChassis } from "../alternator/lane.js";
import type { Entry, Session } from "./types.js";

const GOOD = SESSION_MEMORY_TEMPLATE + "\nthe parser is half rewritten";

let auxBodies: string[] = [];
let auxReply = GOOD;
/** While set, the notes call does not answer until it is called. */
let hold: Promise<void> | null = null;
/** While set, the notes call fails. */
let auxFails = false;
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      auxBodies.push(body);
      if (hold) await hold;
      if (auxFails) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "the provider is down" } }));
        return;
      }
      const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: auxReply }, finish_reason: "stop" }], usage }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_API_KEY"] = "test-key";
  process.env["MINDWEAVE_GEMINI_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

async function withSession<T>(fn: (s: Session) => Promise<T>, entries = 6): Promise<T> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-notes-refresh-")));
  const s = await createSession(root);
  s.modelConfig = { model: "gemini-3.7-flash", thinking: false, effort: "high" };
  s.transcript.push(...marked(0, entries));
  s.sessionMemory = GOOD;
  s.sessionMemoryInit = true;
  auxBodies = [];
  auxReply = GOOD;
  hold = null;
  auxFails = false;
  try {
    return await fn(s);
  } finally {
    hold = null;
    auxFails = false;
    await stopChassis(s.toolContext.chassis).catch(() => {});
  }
}

const marked = (from: number, count: number): Entry[] =>
  Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `entry-marker-${from + i}` }) as Entry);

/** A gate the test opens by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

test("a refresh records what it read, not what the transcript grew into while it ran", () =>
  withSession(async (s) => {
    const g = gate();
    hold = g.wait;
    const run = refreshSessionMemory(s);
    // The work goes on while the notes are being written.
    await new Promise((r) => setTimeout(r, 30));
    s.transcript.push(...marked(6, 3));
    g.open();
    assert.equal(await run, true);
    assert.equal(s.sessionMemoryEntries, 6, "the three newer entries were never read, so they are not covered");
    assert.equal(s.transcript.length, 9);
  }));

test("a refresh that straddles a compaction is dropped, not claimed", () =>
  withSession(async (s) => {
    const g = gate();
    hold = g.wait;
    s.sessionMemoryEntries = 2;
    const before = s.sessionMemory;
    const run = refreshSessionMemory(s);
    await new Promise((r) => setTimeout(r, 30));
    // The transcript is replaced by a compaction while the call is out.
    replaceTranscript(s, [{ role: "summary", content: "earlier" } as Entry, ...s.transcript.slice(-2)]);
    g.open();
    assert.equal(await run, false);
    assert.equal(s.sessionMemory, before, "notes written about entries that moved were not used");
    assert.notEqual(s.sessionMemoryEntries, 6);
  }));

test("a rewrite that is not a whole notes document keeps the last good notes", () =>
  withSession(async (s) => {
    auxReply = "Sorry, I can't help with that.";
    const before = s.sessionMemory;
    assert.equal(await refreshSessionMemory(s), false);
    assert.equal(s.sessionMemory, before);
    assert.equal(s.sessionMemoryEntries, undefined, "nothing was recorded as covered");
  }));

test("a refresh that fails is not tried again until the work has grown another step", () =>
  withSession(async (s) => {
    // The refresh is considered after every round of tool results; a model that cannot do the
    // call must not be asked again after each one.
    s.sessionMemoryInit = false;
    s.sessionMemoryTokens = 0;
    s.transcript.push({ role: "user", content: "x".repeat(40_000) } as Entry);
    auxFails = true;
    const before = s.sessionMemory;
    assert.equal(await refreshSessionMemory(s), false);
    assert.equal(s.sessionMemory, before, "the last good notes are kept");
    assert.ok((s.sessionMemoryTokens ?? 0) > 5_000, "the watermark moved to where the attempt was made");
    assert.equal(s.sessionMemoryInit, true);
    const { sessionMemoryDue } = await import("./sessionMemory.js");
    assert.equal(sessionMemoryDue(s, true), false, "not due again straight away");
    assert.equal(sessionMemoryDue(s, false), false);
  }));

test("it reads only what the notes have not seen, and tells the writer what time it is", () =>
  withSession(async (s) => {
    s.sessionMemoryEntries = 4;
    assert.equal(await refreshSessionMemory(s), true);
    const sent = auxBodies.at(-1)!;
    assert.ok(sent.includes("entry-marker-4") && sent.includes("entry-marker-5"), "the unseen entries");
    assert.ok(!sent.includes("entry-marker-3") && !sent.includes("entry-marker-0"), "not the ones already in the notes");
    assert.match(sent, /NOW: \d{4}-\d\d-\d\dT/);
  }, 6));

test("the writer is told not to record facts that go stale on their own", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./sessionMemory.ts", import.meta.url), "utf8");
  assert.match(source, /process ids, whether/, "the instruction against recording running processes");
  assert.match(source, /the new activity is right/, "and the rule that what just happened wins over the notes");
});

test("two refreshes at once are one: the second joins the first", () =>
  withSession(async (s) => {
    const g = gate();
    hold = g.wait;
    const a = refreshSessionMemory(s);
    const b = refreshSessionMemory(s);
    assert.equal(a, b, "the same promise");
    await new Promise((r) => setTimeout(r, 30));
    g.open();
    await Promise.all([a, b]);
    assert.equal(auxBodies.length, 1, "one call, not two reading the same entries");
    assert.equal(s.sessionMemoryRun, undefined, "and nothing left marked as running");
  }));

test("something waiting on the notes gets them: settle returns once the refresh is written", () =>
  withSession(async (s) => {
    s.sessionMemory = SESSION_MEMORY_TEMPLATE;
    const g = gate();
    hold = g.wait;
    void refreshSessionMemory(s);
    await new Promise((r) => setTimeout(r, 30));
    const settled = settleSessionMemory(s).then(() => s.sessionMemory);
    g.open();
    assert.equal(await settled, GOOD);
    await settleSessionMemory(s); // nothing running: returns at once
  }));

test("how far the notes reach is saved, so a reopened session measures staleness from the real point", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-notes-cover-")));
  const s = await createSession(root);
  s.transcript.push(...marked(0, 8));
  s.sessionMemory = GOOD;
  s.sessionMemoryEntries = 6;
  s.sessionMemoryTokens = 1234;
  let again: Session | null = null;
  try {
    await saveSession(s);
    again = await resumeSession(root, s.id);
    assert.equal(again?.sessionMemoryEntries, 6);
    assert.equal(again?.sessionMemoryTokens, 1234, "so the staleness is measured from the real point, not from zero");
  } finally {
    await stopChassis(s.toolContext.chassis).catch(() => {});
    await stopChassis(again?.toolContext.chassis).catch(() => {});
  }
});

test("a boundary is dropped when reopening changed the transcript's length, since it would name other entries", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mw-notes-cover2-")));
  const s = await createSession(root);
  // A tool call that never got its result (the session was closed mid-tool): reopening has to
  // add one, and an entry added in front of the boundary moves what "the first six" means.
  s.transcript.push(
    { role: "user", content: "run it" } as Entry,
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "run_command", arguments: "{}" }] } as Entry,
    ...marked(2, 6),
  );
  s.sessionMemory = GOOD;
  s.sessionMemoryEntries = 6;
  s.sessionMemoryTokens = 1234;
  let again: Session | null = null;
  try {
    await saveSession(s);
    again = await resumeSession(root, s.id);
    assert.ok((again?.transcript.length ?? 0) > s.transcript.length, "reopening added the missing result");
    assert.equal(again?.sessionMemoryEntries, undefined, "so the boundary is not trusted");
    assert.equal(again?.sessionMemory, GOOD, "the notes themselves are kept");
  } finally {
    await stopChassis(s.toolContext.chassis).catch(() => {});
    await stopChassis(again?.toolContext.chassis).catch(() => {});
  }
});

test("dropping the oldest entries moves the boundary with them, so it still names the same ones", () =>
  withSession(async (s) => {
    s.sessionMemoryEntries = 4;
    replaceTranscript(s, s.transcript.slice(2));
    assert.equal(s.sessionMemoryEntries, 2, "of the four covered entries, the last two are still there");
    replaceTranscript(s, []);
    assert.equal(s.sessionMemoryEntries, 0, "everything covered is gone");
  }));
