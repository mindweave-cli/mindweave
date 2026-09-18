/**
 * store.ts — where sessions live on disk.
 *
 * Sessions are persisted OUTSIDE the project, under the user's home directory
 * (`~/.mindweave/projects/<sanitized-project-path>/`), keyed by which project they
 * belong to. This keeps a project's git tree
 * clean while still letting you resume exactly where you left off, per project.
 *
 * Each session is two files:
 *   <id>.jsonl       — the transcript, one Entry per line (append-friendly, but
 *                      rewritten wholesale at end of turn so compaction's edits
 *                      to earlier entries are reflected — a transcript is bounded
 *                      by compaction, so the rewrite is cheap).
 *   <id>.meta.json   — small descriptor (prompts, timestamps) the resume picker
 *                      reads without parsing the whole transcript.
 *
 * All persistence is best-effort: a failed write logs nothing and never breaks a
 * turn (the in-memory session is the source of truth during a run). This is the
 * CLIENT side of the eventual client/server split — the pure engine never calls
 * anything in here.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import { collapsePastes } from "./pastedText.js";
import type { Entry, Session, SessionMeta } from "./types.js";

/** Turn a project path into a single safe directory name (e.g. `D:\proj` → `D--proj`). */
export function sanitizeProjectPath(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

/**
 * The per-project state directory under the user's home: where everything Mindweave
 * keeps for a given project lives — sessions today, and per-project rules /
 * skills / forbidden (the governor). One scheme, one source of truth, so a
 * project's state is always filed under the same key.
 */
export function projectDir(projectCwd: string): string {
  return join(stateRoot(), "projects", sanitizeProjectPath(projectCwd));
}

/**
 * Where Mindweave keeps everything, overridable.
 *
 * The override is not a feature, it is the fix for a real mess. This path is derived
 * from the working directory, so a test that ran anything against a temp directory
 * wrote a permanent folder into the user's HOME. Measured on this machine: 6,761 of
 * 6,770 directories under `~/.mindweave/projects` were test litter, growing with every
 * suite run and never cleaned up, because nothing knew they were disposable.
 *
 * Read on every call rather than once at import, so a test can point it somewhere
 * disposable before touching anything. The default is unchanged, so a real session is
 * unaffected.
 */
export function stateRoot(): string {
  const override = process.env.MINDWEAVE_STATE_DIR?.trim();
  return override ? override : join(homedir(), ".mindweave");
}

/** The directory holding all sessions for a given project (its state dir). */
export function sessionDir(projectCwd: string): string {
  return projectDir(projectCwd);
}

/** Where a session's transcript lives. Exported so a cleared session can tell the
 *  model where the conversation it just lost can still be read. */
export function transcriptPath(projectCwd: string, id: string): string {
  return join(sessionDir(projectCwd), `${id}.jsonl`);
}

/** Sidecar file holding a session's maintained "session memory" notes. */
function notesPath(projectCwd: string, id: string): string {
  return join(sessionDir(projectCwd), `${id}.notes.md`);
}

/** Load a session's session-memory notes, or "" if none. */
export async function loadSessionNotes(projectCwd: string, id: string): Promise<string> {
  try {
    return (await fs.readFile(notesPath(projectCwd, id), "utf8")).trim();
  } catch {
    return "";
  }
}

function metaPath(projectCwd: string, id: string): string {
  return join(sessionDir(projectCwd), `${id}.meta.json`);
}

function firstUserText(transcript: Entry[]): string {
  return transcript.find((e) => e.role === "user")?.content.trim() ?? "";
}

/** The last thing the PERSON said. Engine-written nudges arrive as `user` messages so
 *  the model treats them as instruction, but they are not prompts and must not be
 *  shown as one — this is what the session picker labels a session with. */
function lastUserText(transcript: Entry[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    // Collapsed, or a session that opened with a paste is labelled by the paste — or, once
    // it is wrapped, by the wrapper. The label is meant to be the thing the person typed.
    if (e.role === "user" && !e.synthetic) return collapsePastes(e.content).trim();
  }
  return "";
}

function clip(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/**
 * Write the session to disk (transcript + meta). Best-effort: returns false on
 * any failure instead of throwing, so a persistence hiccup never aborts a turn.
 */
export async function saveSession(session: Session): Promise<boolean> {
  try {
    const dir = sessionDir(session.cwd);
    await fs.mkdir(dir, { recursive: true });

    // Stamp anything not yet stamped, in place, on its way to disk.
    //
    // The stamp is what lets a resumed session judge each file on its OWN read rather
    // than on when the session happened to close: a file touched after the model read it
    // but before the session ended is stale, and without a per-entry time there is
    // nothing to notice that with. Done here because it is the ONE place every entry
    // passes through — stamping at the eighteen call sites that append to a transcript
    // would be eighteen chances to forget.
    //
    // First save wins, so the time recorded is when the entry was written rather than
    // when it was last persisted, and re-saving a long transcript never rewrites history.
    // Entries from sessions written before this simply have no stamp, and everything
    // reading it treats that as unknown rather than as zero.
    const now = Date.now();
    for (const e of session.transcript) {
      if (e.ts === undefined) e.ts = now;
    }
    const lines = session.transcript.map((e) => JSON.stringify(e)).join("\n");
    // ATOMIC, like every other write in the project. `fs.writeFile` truncates the
    // destination and then streams the new bytes in, so between those two moments the
    // file on disk is empty or half-written. This file is rewritten WHOLE on every
    // persist — before each tool batch, after each result, after each reply — so a
    // session crossing that window is not exotic, and the crash that lands there is
    // exactly the kind this project has already met (an OOM kill runs no handlers).
    // What is lost is the user's entire conversation, and a zero-byte transcript is
    // unrecoverable rather than merely damaged: the resume path finds nothing at all.
    // The same reasoning already protects the user's SOURCE files; their session was
    // the one thing still written the unsafe way.
    await writeFileAtomic(transcriptPath(session.cwd, session.id), lines + "\n");

    // Extra roots = everything on the tool context beyond the primary (session.cwd).
    const extraRoots = (session.toolContext.roots ?? []).filter((r) => r !== session.cwd);
    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      firstPrompt: clip(firstUserText(session.transcript)),
      lastPrompt: clip(lastUserText(session.transcript)),
      entryCount: session.transcript.length,
      // Unconditional: a session with no model recorded is one whose behaviour cannot
      // be compared against any other.
      ...(session.modelConfig?.model ? { model: session.modelConfig.model } : {}),
      ...(extraRoots.length > 0 ? { extraRoots } : {}),
      // Only once something has actually been spent, so a session that never ran a turn
      // does not carry a row of zeroes claiming to be a measurement.
      ...(session.spend && session.spend.turns > 0 ? { spend: session.spend } : {}),
      // The per-call breakdown, which is what makes a surprising bill diagnosable: the
      // totals above are identical whether a turn made one expensive call or six cheap
      // ones, and that difference is the whole answer.
      ...(session.callLog && session.callLog.length > 0 ? { callLog: session.callLog } : {}),
      // Deferred tools the model surfaced this session, so a resume re-advertises them
      // instead of stripping a tool it was mid-use of (see registry.toolSchemas).
      ...(session.toolContext.activatedTools && session.toolContext.activatedTools.size > 0
        ? { activatedTools: [...session.toolContext.activatedTools] }
        : {}),
    };
    await writeFileAtomic(metaPath(session.cwd, session.id), JSON.stringify(meta, null, 2));

    // Session-memory notes sidecar (the maintained running state), when present.
    if (session.sessionMemory && session.sessionMemory.trim()) {
      await writeFileAtomic(notesPath(session.cwd, session.id), session.sessionMemory);
    }
    return true;
  } catch {
    return false;
  }
}

/** Load a session's transcript from disk, or null if it isn't there / is unreadable. */
export async function loadTranscript(projectCwd: string, id: string): Promise<Entry[] | null> {
  try {
    const raw = await fs.readFile(transcriptPath(projectCwd, id), "utf8");
    const entries: Entry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as Entry);
      } catch {
        // Skip a corrupt line rather than losing the whole session.
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/** Load one session's descriptor (for resume — carries extraRoots/createdAt), or null. */
export async function loadMeta(projectCwd: string, id: string): Promise<SessionMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(projectCwd, id), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

/** List this project's sessions, most-recently-updated first. */
export async function listSessions(projectCwd: string): Promise<SessionMeta[]> {
  const dir = sessionDir(projectCwd);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const raw = await fs.readFile(join(dir, name), "utf8");
      const meta = JSON.parse(raw) as SessionMeta;
      // A session with nothing said in it is not something to continue or count. They are
      // written on purpose (`/include` before the first message, `/update` saving for the
      // restarted copy to pick up), and a third of one real project's list was these,
      // each reading "0 msgs" in /continue and each counted as an earlier session.
      if (meta.entryCount === 0) continue;
      metas.push(meta);
    } catch {
      // Skip unreadable/corrupt meta files.
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recent session for this project, or null if there are none. */
export async function latestSession(projectCwd: string): Promise<SessionMeta | null> {
  return (await listSessions(projectCwd))[0] ?? null;
}
