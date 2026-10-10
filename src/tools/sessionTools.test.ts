/**
 * sessionTools.test.ts — the agent can actually read its own past work.
 *
 * Written against real files on disk, because the bug was never in the logic: the
 * sessions were saved correctly the whole time and simply had no reader. So these
 * save sessions the way the app does, then assert the tools find and report them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsTool, timeAgo } from "./sessionTools.js";
import { sessionDir } from "../memory/store.js";
import type { ToolContext } from "./types.js";

const project = mkdtempSync(join(tmpdir(), "mindweave-sessions-"));

const ctx = (sessionId?: string): ToolContext =>
  ({ cwd: project, roots: [project], reads: new Map(), todos: [], sessionId }) as unknown as ToolContext;

/** Write a saved session the same shape store.ts does: a meta file + notes + transcript. */
async function saveFixture(
  id: string,
  opts: {
    first: string;
    last: string;
    updatedAt: number;
    notes?: string;
    transcript?: Array<{ role: string; content: string }>;
    notesCover?: { entries: number; tokens: number; of: number };
  },
) {
  const dir = sessionDir(project);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, `${id}.meta.json`),
    JSON.stringify({
      id,
      cwd: project,
      createdAt: opts.updatedAt - 1000,
      updatedAt: opts.updatedAt,
      firstPrompt: opts.first,
      lastPrompt: opts.last,
      entryCount: opts.transcript?.length ?? 12,
      ...(opts.notesCover ? { notesCover: opts.notesCover } : {}),
    }),
  );
  if (opts.notes) await fs.writeFile(join(dir, `${id}.notes.md`), opts.notes);
  if (opts.transcript) {
    await fs.writeFile(join(dir, `${id}.jsonl`), opts.transcript.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

const NOW = Date.now();

test("setup: two past sessions on disk", async () => {
  await saveFixture("aaaaaaaa-1111", {
    first: "fix the login 500",
    last: "run the tests",
    updatedAt: NOW - 2 * 86400_000,
    notes: "Fixed middleware ordering: RequestScoringMiddleware had to run first.",
  });
  // Deliberately NO notes, but a real transcript: the session that did work and
  // ended before session memory ever wrote anything.
  await saveFixture("bbbbbbbb-2222", {
    first: "harden the rate limiter",
    last: "does manage.py check pass",
    updatedAt: NOW - 3600_000,
    transcript: [
      { role: "user", content: "harden the rate limiter" },
      { role: "assistant", content: "Added a per-IP token bucket in throttles.py and wired it into settings." },
      { role: "user", content: "does manage.py check pass" },
    ],
  });
});

test("sessions reports past sessions, newest first", async () => {
  const r = await sessionsTool.execute({}, ctx());
  assert.equal(r.isError, undefined);
  assert.match(r.output, /harden the rate limiter/);
  assert.match(r.output, /fix the login 500/);
  assert.ok(
    r.output.indexOf("harden the rate limiter") < r.output.indexOf("fix the login 500"),
    "newest session must come first",
  );
});

test("sessions excludes the session you are currently in", async () => {
  const r = await sessionsTool.execute({}, ctx("bbbbbbbb-2222"));
  assert.doesNotMatch(r.output, /harden the rate limiter/);
  assert.match(r.output, /fix the login 500/);
});

test("sessions answers with what that session actually recorded", async () => {
  const r = await sessionsTool.execute({ id: "aaaaaaaa-1111" }, ctx());
  assert.equal(r.isError, undefined);
  assert.match(r.output, /RequestScoringMiddleware had to run first/);
});

test("sessions defaults to the most recent past session", async () => {
  const r = await sessionsTool.execute({ id: "latest" }, ctx());
  assert.match(r.output, /harden the rate limiter/);
});

test("sessions is honest when a session kept no notes", async () => {
  const r = await sessionsTool.execute({ id: "bbbbbbbb-2222" }, ctx());
  assert.match(r.output, /kept no notes/);
  // It still hands back what it does know, rather than nothing.
  assert.match(r.output, /harden the rate limiter/);
});

test("a session with no notes still ANSWERS in one call, from its transcript", async () => {
  const r = await sessionsTool.execute({ id: "bbbbbbbb-2222" }, ctx());
  assert.equal(r.isError, undefined);
  // The actual work done that session, not just the bracketing prompts from the header.
  assert.match(r.output, /per-IP token bucket in throttles\.py/);
  // And it must NOT bounce the model into a second call: that round trip bought
  // nothing, and "call again" reads as failure to a model that then guesses instead.
  assert.doesNotMatch(r.output, /full:true/);
});

test("sessions rejects an unknown id instead of inventing one", async () => {
  const r = await sessionsTool.execute({ id: "nope" }, ctx());
  assert.equal(r.isError, true);
  assert.match(r.output, /sessions with no id/);
});

// ── Both are internal bookkeeping, not news — never a visible row ──────────────

test("sessions never shows a row: looking up its own history is bookkeeping", async () => {
  assert.equal((await sessionsTool.execute({}, ctx())).quiet, true);
});

test("sessions never shows a row, notes or transcript or no-notes fallback", async () => {
  assert.equal((await sessionsTool.execute({ id: "aaaaaaaa-1111" }, ctx())).quiet, true);
  assert.equal((await sessionsTool.execute({ id: "bbbbbbbb-2222" }, ctx())).quiet, true, "no-notes fallback");
  assert.equal((await sessionsTool.execute({ id: "aaaaaaaa-1111", full: true }, ctx())).quiet, true, "full transcript");
});

test("an unknown session id is still a real, visible error — quiet is for routine lookups, not failures", async () => {
  assert.equal((await sessionsTool.execute({ id: "nope" }, ctx())).quiet, undefined);
});

test("both tools are read-only", () => {
  assert.equal(sessionsTool.readOnly, true);
});

test("a project with no history says so plainly", async () => {
  const empty = mkdtempSync(join(tmpdir(), "mindweave-empty-"));
  const emptyCtx = { cwd: empty, roots: [empty], reads: new Map(), todos: [] } as unknown as ToolContext;
  const r = await sessionsTool.execute({}, emptyCtx);
  assert.match(r.output, /No earlier sessions/);
});

test("notes that stop before the session ended are followed by what came after them", async () => {
  await saveFixture("cccccccc-3333", {
    first: "wire the importer",
    last: "ship it",
    updatedAt: NOW - 4 * 86400_000,
    notes: "Importer reads the CSV and writes rows.",
    notesCover: { entries: 2, tokens: 900, of: 5 },
    transcript: [
      { role: "user", content: "wire the importer" },
      { role: "assistant", content: "Importer is wired to the CSV reader." },
      { role: "user", content: "now add the retry on timeout" },
      { role: "assistant", content: "Added a three-try retry with backoff in importer.ts." },
      { role: "user", content: "ship it" },
    ],
  });
  const r = await sessionsTool.execute({ id: "cccccccc-3333" }, ctx());
  assert.match(r.output, /Importer reads the CSV and writes rows/);
  assert.match(r.output, /last written 3 messages before that session ended/);
  assert.match(r.output, /Added a three-try retry with backoff/, "what came after the notes");
  assert.doesNotMatch(r.output, /Importer is wired to the CSV reader/, "what the notes already hold is not repeated");
});

test("notes that reach the end, or whose reach is unknown, get nothing added", async () => {
  const r = await sessionsTool.execute({ id: "aaaaaaaa-1111" }, ctx());
  assert.doesNotMatch(r.output, /last written/);
});

test("timeAgo reads the way a person refers to past work", () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 5_000, now), "just now");
  assert.equal(timeAgo(now - 60_000, now), "1 minute ago");
  assert.equal(timeAgo(now - 7_200_000, now), "2 hours ago");
  assert.equal(timeAgo(now - 3 * 86_400_000, now), "3 days ago");
  assert.equal(timeAgo(now - 14 * 86_400_000, now), "2 weeks ago");
});
