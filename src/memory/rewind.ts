/**
 * rewind.ts — take the conversation back to before one of your messages, files included.
 *
 * `/undo` puts FILES back and tells the agent it did; the conversation keeps every word
 * of the turns it undid. Rewind removes those turns: the transcript is cut back to just
 * before the chosen message, every file change made from that message onward is put
 * back through the same checkpoints `/undo` uses, and the message itself is handed back
 * so it can be edited and sent again. Conversation and files move together, so the
 * agent is never left reading about edits that are no longer on disk.
 *
 * What it cannot do, and says so rather than implying otherwise:
 *  - commands the agent ran are not reversed (an install stays installed);
 *  - a file somebody else changed afterwards is left alone (a conflict);
 *  - undo history lives in memory, so after a restart the conversation still rewinds
 *    but earlier file changes stay on disk, and are listed as not put back.
 */
import { stripAttachments, attachedFiles, hideAttachedNames } from "../cli/attachments.js";
import { collapsePastes } from "./pastedText.js";
import { writtenPaths } from "./presence.js";
import { resolvePath } from "../tools/paths.js";
import { rebuildReadLedger } from "./session.js";
import { clearSessionNotes, saveSession } from "./store.js";
import { loadMemoryIndex } from "./autoMemory.js";
import { planMcpServers } from "../mcp/projectApproval.js";
import { refreshGovernance } from "../dynamo/engine.js";
import { isStateItem, stateKindOf, type StateKind } from "../tools/stateCheckpoint.js";
import { undoNotice, type UndoResult } from "../tools/checkpoints.js";
import type { Entry, Session } from "./types.js";

/** The first words of `/undo`'s note to the agent. It is filed as a user message so the
 *  model treats it as a fact, but nobody typed it, so nothing rewinds to it. */
const UNDO_NOTICE_START = "The user ran /undo.";

type UserEntry = Extract<Entry, { role: "user" }>;

/**
 * A message the conversation can be rewound to: something the person typed that opened
 * a turn. Engine nudges are not theirs; a message steered into a running turn has no
 * boundary of its own to go back to (its turn's file changes began before it).
 */
export function isRewindPoint(e: Entry): e is UserEntry & { ts: number } {
  return (
    e.role === "user" &&
    !e.synthetic &&
    e.arrival !== "steered" &&
    e.ts !== undefined &&
    !e.content.startsWith(UNDO_NOTICE_START)
  );
}

/** One message on the rewind list, newest first. `files` is how many files going back to
 *  it would restore; `ranShell` says commands ran since then that cannot be undone. */
export interface RewindPoint {
  at: number;
  text: string;
  /** Project files going back to this message would put back. */
  files: number;
  /** Lines the turns since added and removed in those files (what a rewind undoes). */
  added: number;
  removed: number;
  /** Memories, rules, skills, permissions and MCP servers the agent changed since. */
  state: Partial<Record<StateKind, number>>;
  skipped: number;
  ranShell: boolean;
}

/** What to take back. The conversation, the files (project and agent state), or both. */
export type RewindMode = "both" | "conversation" | "files";

/** A message as it can be put back in the input box: what was typed, and what came with it. */
export interface EditableMessage {
  /** What was typed, with attachment names and pastes taken out. */
  text: string;
  /** The same text with each paste's place marked by `pasteSlot(i)`, for an input that
   *  keeps pastes inline (the CLI) rather than in a tray (the desktop). */
  template: string;
  /** Pasted blocks, whole, in order. */
  pastes: string[];
  /** Files that were attached in full, as absolute paths. */
  files: string[];
  /** Images that were attached, as absolute paths. */
  images: string[];
}

/** The marker `template` uses for the i-th paste. NUL cannot be typed, so it can't collide. */
export function pasteSlot(i: number): string {
  return `\u0000${i}\u0000`;
}

export interface RewindResult {
  message: EditableMessage;
  /** Project files put back to how they were before the message. */
  restored: string[];
  /** Agent state taken back (memories, rules, skills, permissions, MCP servers). */
  restoredState: { kind: StateKind; path: string }[];
  /** Which of the two halves were taken back. */
  mode: RewindMode;
  /** Changed by someone else since; left exactly as they are. */
  conflicts: string[];
  /** Could not be written (locked, permissions). */
  failed: string[];
  /** Too large to have been held, so still changed. */
  skipped: string[];
  /** Files the removed turns wrote that no checkpoint covered (history lost on restart). */
  notRestored: string[];
  /** Commands ran in the removed turns; their effects stay. */
  ranShell: boolean;
  /** How many entries the conversation lost. */
  removed: number;
}

const PASTE_RE = /<pasted_text lines="\d+">\n([\s\S]*?)\n<\/pasted_text>/g;

/** Split a stored message back into what was typed and what came with it. */
export function editableMessage(entry: UserEntry, cwd: string): EditableMessage {
  const files = attachedFiles(entry.content, cwd);
  const images = (entry.images ?? []).map((i) => i.path);
  const pastes: string[] = [];
  const withSlots = stripAttachments(entry.content).replace(PASTE_RE, (_m, body: string) => {
    pastes.push(body);
    return pasteSlot(pastes.length - 1);
  });
  const template = hideAttachedNames(withSlots, [...files, ...images]);
  const text = template
    .replace(/\u0000\d+\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, template, pastes, files, images };
}

/** One line for the picker: the message as the chat showed it. */
function pointText(entry: UserEntry, cwd: string): string {
  const files = attachedFiles(entry.content, cwd);
  const images = (entry.images ?? []).map((i) => i.path);
  const shown = hideAttachedNames(collapsePastes(stripAttachments(entry.content)), [...files, ...images]);
  const attached = files.length + images.length;
  const line = shown.replace(/\s+/g, " ").trim();
  if (line) return line;
  return attached ? `(${attached} attachment${attached === 1 ? "" : "s"})` : "(empty message)";
}

/** Lines `after` has that `before` lacks, and the other way round. Counted as multisets,
 *  so a moved line is not both; close enough to a real diff for a summary, and linear. */
export function lineDelta(before: string | null, after: string | null): { added: number; removed: number } {
  const count = (text: string | null) => {
    const m = new Map<string, number>();
    // A file's closing newline ends its last line; it does not start another one.
    if (text) for (const line of text.replace(/\r?\n$/, "").split(/\r?\n/)) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}

function projectRoot(session: Session): string {
  return session.toolContext.governance?.forbidden.root ?? session.cwd;
}

/** Every message the conversation can go back to, newest first. */
export function rewindPoints(session: Session): RewindPoint[] {
  const cp = session.toolContext.checkpoints;
  const root = projectRoot(session);
  const out: RewindPoint[] = [];
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    const e = session.transcript[i]!;
    if (!isRewindPoint(e)) continue;
    const since = cp?.changesSince(e.ts);
    let files = 0;
    let added = 0;
    let removed = 0;
    const state: Partial<Record<StateKind, number>> = {};
    for (const [path, fs] of since?.files ?? []) {
      const kind = stateKindOf(path, root);
      if (kind) {
        if (isStateItem(path, root)) state[kind] = (state[kind] ?? 0) + 1;
        continue;
      }
      files++;
      const d = lineDelta(fs.original, fs.written);
      added += d.added;
      removed += d.removed;
    }
    out.push({
      at: e.ts,
      text: pointText(e, session.cwd),
      files,
      added,
      removed,
      state,
      skipped: since?.skipped.length ?? 0,
      ranShell: since?.ranShell ?? false,
    });
  }
  return out;
}

/**
 * Bring the live session back in line with agent state that was just put back on disk:
 * the rules, skills and permissions it enforces, the memory index it is shown, and the
 * MCP servers it is connected to. Shared by rewind and `/undo`.
 */
export async function reloadAgentState(session: Session, paths: readonly string[]): Promise<void> {
  const root = projectRoot(session);
  const kinds = new Set(paths.map((p) => stateKindOf(p, root)).filter((k): k is StateKind => k !== null));
  if (kinds.has("rule") || kinds.has("skill") || kinds.has("permission")) await refreshGovernance(session, true);
  if (kinds.has("memory")) session.memoryIndex = await loadMemoryIndex(root);
  const mcp = session.toolContext.mcp;
  if (kinds.has("mcp") && mcp) {
    // Only what may start without asking; a project server that now needs approval is
    // held and asked about at the next turn, as it is when a session opens.
    const plan = await planMcpServers(root);
    session.toolContext.mcpPending = plan.pending;
    const wanted = new Map(plan.ready.map((c) => [c.name, c]));
    for (const s of mcp.statuses()) if (!wanted.has(s.name)) await mcp.removeServer(s.name);
    // Connecting can take a while (a process to start, a handshake); the rewind itself
    // does not wait for it, the same as a server added any other way.
    for (const [name, config] of wanted) {
      const live = mcp.configFor(name);
      if (!live || JSON.stringify(live) !== JSON.stringify(config)) void mcp.addServer(config).catch(() => {});
    }
  }
}

/**
 * Take the session back to just before the message stamped `at`. Returns null when no
 * such message is in the conversation (it was compacted away, or never existed). The
 * caller must not run this while a turn is in progress.
 */
export async function rewindTo(session: Session, at: number, mode: RewindMode = "both"): Promise<RewindResult | null> {
  const index = session.transcript.findIndex((e) => isRewindPoint(e) && e.ts === at);
  if (index < 0) return null;
  const entry = session.transcript[index] as UserEntry;
  const message = editableMessage(entry, session.cwd);
  const root = projectRoot(session);

  // Files first: if the process dies between the two steps, the conversation still
  // describes the edits, and a later /undo or rewind can find them again.
  const results: UndoResult[] = mode === "conversation" ? [] : ((await session.toolContext.checkpoints?.undoSince(at)) ?? []);
  const gather = (pick: (r: (typeof results)[number]) => string[]) => [...new Set(results.flatMap(pick))];
  const putBack = gather((r) => r.restored);
  const restored = putBack.filter((p) => stateKindOf(p, root) === null);
  const stateBack = putBack.filter((p) => stateKindOf(p, root) !== null);
  // Reported per item ("1 memory"); the index that changed along with it is not a second one.
  const restoredState = stateBack.filter((p) => isStateItem(p, root)).map((path) => ({ kind: stateKindOf(path, root)!, path }));
  if (stateBack.length) await reloadAgentState(session, stateBack);
  const conflicts = gather((r) => r.conflicts);
  const failed = gather((r) => r.failed);
  const skipped = gather((r) => r.skipped);

  const removed = session.transcript.slice(index);
  const resolve = (p: string): string | undefined => {
    try {
      return resolvePath(session.toolContext, p);
    } catch {
      return undefined;
    }
  };
  // Only a lost history leaves writes nobody can account for. With history intact, a
  // written file missing from the results was already put back (an earlier /undo) or
  // already gone, and listing it as "not restored" would be false.
  const cp = session.toolContext.checkpoints;
  const accounted = new Set([...restored, ...conflicts, ...failed, ...skipped]);
  const notRestored = mode !== "conversation" && (!cp || cp.wasResumed())
    ? [...writtenPaths(removed, resolve)].filter((p) => !accounted.has(p))
    : [];

  if (mode === "files") {
    // The conversation stays, so it still describes edits that are no longer on disk:
    // the agent is told, exactly as it is after /undo.
    if (results.length) {
      // Engine-written (synthetic): the model reads it, the chat never draws it as yours.
      session.transcript.push({ role: "user", content: undoNotice(results, (p) => p), synthetic: true, ts: Date.now() });
      await rebuildReadLedger(session);
      await saveSession(session);
    }
    return {
      message,
      restored,
      restoredState,
      mode,
      conflicts: gather((r) => r.conflicts),
      failed: gather((r) => r.failed),
      skipped: gather((r) => r.skipped),
      notRestored,
      ranShell: results.some((r) => r.ranShell),
      removed: 0,
    };
  }

  session.transcript = session.transcript.slice(0, index);

  // Session notes written after this point describe turns that no longer happened.
  // `sessionMemoryEntries` is how much of the transcript they cover; unknown is unsafe.
  if (session.sessionMemory && (session.sessionMemoryEntries === undefined || session.sessionMemoryEntries > index)) {
    session.sessionMemory = undefined;
    session.sessionMemoryInit = false;
    session.sessionMemoryTokens = 0;
    session.sessionMemoryEntries = undefined;
    await clearSessionNotes(session.cwd, session.id);
  }
  // A plan the agent wrote in the removed turns is about work that no longer happened.
  if (removed.some((e) => e.role === "assistant" && e.toolCalls?.some((c) => c.name === "todo_write"))) {
    session.toolContext.todos = [];
  }
  session.taskJustCompleted = false;
  // What the agent has read has to match what the conversation still shows it reading.
  await rebuildReadLedger(session);
  await saveSession(session);

  return {
    message,
    restored,
    restoredState,
    mode,
    conflicts,
    failed,
    skipped,
    notRestored,
    ranShell: results.some((r) => r.ranShell),
    removed: removed.length,
  };
}
