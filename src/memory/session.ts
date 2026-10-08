/**
 * session.ts — create a fresh session or resume a saved one.
 *
 * A `Session` bundles the transcript, the tool context (live cwd + read ledger),
 * and the project memory. This is the client-side init that does the disk reads
 * (MINDWEAVE.md, a saved transcript); the engine receives a ready Session and never
 * touches the filesystem itself.
 */
import { promises as fs, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ToolContext } from "../tools/types.js";
import { resolvePath, nextTouch, canonicalRoot } from "../tools/paths.js";
import type { Session, Entry } from "./types.js";
import { checkpointDir, latestSession, listSessions, loadEarlier, loadMeta, loadTranscript, loadSessionNotes } from "./store.js";
import { fullReadPaths, writtenPaths } from "./presence.js";
import { startChassis } from "../alternator/lane.js";
import { BackgroundShells } from "../tools/backgroundShells.js";
import { Checkpoints } from "../tools/checkpoints.js";
import { projectContextText } from "../project/context.js";
import { loadGovernance, governanceStamp } from "../governor/index.js";
import { createRuleScope } from "../governor/scope.js";
import type { Governance } from "../governor/types.js";
import { loadModelConfig } from "../dynamo/model.js";
import { ensureMemoryDir, loadMemoryIndex, memoryDir } from "./autoMemory.js";
import { planMcpServers } from "../mcp/projectApproval.js";
import { McpManager } from "../mcp/manager.js";
import { assembleNotes, NOTES_FILE } from "./projectNotes.js";

/**
 * Read the project's notes: MINDWEAVE.md, the user's own, and everything they import.
 *
 * The layers and their rules live in projectNotes.ts. This is only the seam the
 * session uses, kept as a single string because that is what the cached prefix takes.
 */
async function loadProjectMemory(cwd: string): Promise<string> {
  return (await assembleNotes(cwd)).text;
}

/**
 * Re-read MINDWEAVE.md into the live session, but only when it is FREE to do so.
 *
 * The model maintains MINDWEAVE.md, so it edits the file mid-session; `projectMemory`
 * is frozen into the cached system prompt at session start. Re-reading it every turn
 * kept the two in step, at a price that turned out to be the single most expensive
 * line in prompt assembly: changing the system prompt string invalidates the WHOLE
 * cached prefix — base prompt, tool schemas, project snapshot, governance — and the
 * next request pays a full cache rewrite at 1.25x normal input rate. One edit to a
 * small markdown file re-billed everything.
 *
 * The codebase already knew this hazard: standing rules were deliberately moved OUT of
 * the cached prefix precisely so a mid-session remember_rule could not bust it. This
 * does the same thing for the same reason.
 *
 * Serving the frozen copy is safe because of where the fresh copy already is. The model
 * that just edited MINDWEAVE.md has the new content in its own transcript — it wrote it
 * — so nothing is hidden from it. The frozen prefix is only how the NEXT session starts,
 * and it refreshes at points where the cache is being thrown away regardless: after a
 * compaction (which rewrites the transcript, taking the edit with it), and at session
 * start.
 */
export async function reloadProjectMemory(session: Session, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && !session.projectMemoryStale) return;
  session.projectMemory = await loadProjectMemory(session.cwd);
  session.projectMemoryStale = false;
}

/**
 * Attach the MCP server pool to a session.
 *
 * Deliberately NOT awaited. Servers are third-party processes and a slow one would sit
 * between the user pressing enter and the first paint, so the pool comes up in the
 * background and its tools appear once they are ready. Failures are already states
 * rather than exceptions, so nothing here can reject; the `catch` is belt and braces.
 *
 * The cost of not awaiting is that a server landing mid-session changes the tool list
 * and invalidates the cached prompt prefix. That cost is real and it is NOT designed
 * away: tool schemas are a structural API field rendered before every provider's cache
 * breakpoint, so there is no volatile tail to move them into (docs/mcp-plan.md §6, which
 * corrects an earlier claim that there was). What Phase 3 actually bought is a stable
 * catalog and one frozen snapshot per turn, so the cost lands once per real change
 * instead of once per turn — which is cheap enough that the fast start is worth keeping.
 */
function attachMcp(ctx: ToolContext, cwd: string): void {
  const manager = new McpManager();
  ctx.mcp = manager;
  // Before anything connects: a tool can be dispatched as soon as its server is up, and
  // spilled results have to land in this project's state dir rather than wherever the
  // process happened to start.
  manager.setProjectRoot(cwd);
  // The user's own servers, and project servers already approved, start now. The rest
  // wait for a question when the first turn starts (see mcp/projectApproval.ts).
  void planMcpServers(cwd)
    .then(async ({ ready, pending }) => {
      ctx.mcpPending = pending;
      await manager.start(ready);
      // Governance is applied AFTER connecting, because both gates are about the tools
      // a server actually turned out to advertise: a forbidden name only matters once
      // it exists, and a changed description can only be noticed against a live one.
      manager.setForbidden(ctx.governance?.forbidden.mcpTools ?? []);
      // Rug-pull check. `requestApproval` may not be attached yet (the CLI wires it
      // just after session creation), in which case `verifyTrust` fails closed and
      // changed tools stay blocked until the next session — the safe direction.
      await manager.verifyTrust(cwd, ctx.requestApproval);
    })
    .catch(() => {});
}

/**
 * Seed the read-ledger with MINDWEAVE.md when it exists on disk, so the model can UPDATE
 * the project's own memory file without a redundant read_file first. MINDWEAVE.md's content
 * is already loaded into the system prompt (projectMemory), so the read-before-edit gate
 * would otherwise trip on a file the model effectively already has — surfacing the
 * confusing "MINDWEAVE.md has not been read this session" error on routine housekeeping.
 * Keyed via resolvePath so it matches exactly what the edit gate looks up. Recorded
 * full:false (the model works from a window, never a held whole-file copy) so it can
 * never wrongly short-circuit a genuine read_file. Best-effort; no MINDWEAVE.md => no-op.
 */
async function seedProjectMemoryRead(ctx: ToolContext, projectMemory: string): Promise<void> {
  if (!projectMemory) return;
  const abs = resolvePath(ctx, "MINDWEAVE.md");
  try {
    const st = await fs.stat(abs);
    ctx.reads.set(abs, { mtimeMs: st.mtimeMs, size: st.size, full: false, touchedAt: nextTouch() });
  } catch {
    // No MINDWEAVE.md on disk — nothing to seed.
  }
}

/** Ensure the memory dir exists (so the model never mkdirs) and read its index. */
async function loadMemory(cwd: string): Promise<string> {
  await ensureMemoryDir(cwd);
  return loadMemoryIndex(cwd);
}

function freshToolContext(cwd: string, governance: Governance, roots: string[]): ToolContext {
  // Start the alternator: one code map per root warms up in the background while
  // the session is already usable. The forbidden config + skill catalog come from
  // the governor so the tools can enforce/invoke them.
  const chassisByRoot = new Map(roots.map((root) => [root, startChassis(root)] as const));
  return {
    cwd,
    roots,
    reads: new Map(),
    chassis: chassisByRoot.get(cwd), // the primary root's map (drives the auto-map)
    chassisByRoot,
    backgroundShells: new BackgroundShells(),
    checkpoints: new Checkpoints(),
    todos: [],
    // Deferred tools the model has surfaced via find_tools become callable from then on
    // (registry.toolSchemas). Empty at start; grows as the model searches; restored from
    // meta on resume.
    activatedTools: new Set<string>(),
    // Same governance object as Session.governance — shared so mid-session edits
    // (a new rule, a new forbidden path) are visible to both the tools and the
    // engine's prompt without a reload.
    governance,
    // Which glob-scoped rules this session has activated. Filled as paths are touched
    // (governor/scope.ts) rather than re-derived on every model call.
    ruleScope: createRuleScope(),
  };
}

/** The framing prepended to a sub-agent's task — it works alone and reports back. */
const SUBAGENT_PREAMBLE =
  "You are a focused sub-agent spawned by the main Mindweave agent to complete ONE task and report back. " +
  "Work autonomously with your tools — you cannot ask the user questions, and you do not see the main " +
  "conversation, so rely only on the task below. Do EXACTLY what it asks and stay inside its boundaries — " +
  "don't widen the scope, and don't change files the task didn't name. Stop as soon as the objective is met " +
  "rather than exploring further. When finished, reply with a DISTILLED result — the answer the main agent " +
  "needs, with concrete file:line references, and nothing else (no play-by-play). If the task specifies an " +
  "output format, follow it exactly. Keep it tight (aim for well under a page): the main agent sees only " +
  "your final message, not your intermediate steps.\n\nTask:\n";

/**
 * A scoped child session for a sub-agent. It gets its OWN transcript (seeded with
 * the task) and its OWN read ledger + todo list, so its work is isolated and never
 * pollutes the parent's working set. It SHARES the parent's code map, checkpoints
 * (so its edits are undoable too) and governance by reference — everything the parent
 * already stood up. What it does NOT get is anything the user granted in person: the
 * approval channel, session permission grants, and the parent's approved plan all stop
 * here. Only the child's final reply crosses back to the parent, through the spawn tool.
 */
export function forkSession(parent: Session, task: string, opts: { readOnly?: boolean; agentPrompt?: string } = {}): Session {
  const p = parent.toolContext;
  const id = randomUUID();
  const childContext: ToolContext = {
    ...p,
    reads: new Map(),
    todos: [],
    // Its OWN activation set, seeded with the parent's so it can call what is already
    // active. Without the copy the spread would share the parent's Set by reference, and a
    // sub-agent's find_tools would silently change the parent's advertised list.
    activatedTools: new Set(p.activatedTools),
    // Its own id, not the parent's. The spread carries `sessionId`, so a child asking
    // "which conversation am I?" answered with the parent's — harmless while nothing
    // writes session-scoped state from a child, and wrong the moment something does.
    sessionId: id,
    subagentDepth: (p.subagentDepth ?? 0) + 1,
    readOnlyTools: opts.readOnly === true ? true : p.readOnlyTools,
    // A ROLE for this child, appended to its system prompt. Not inherited: a nested child
    // of a verifier is not itself a verifier, and silently carrying the persona down would
    // make every descendant refuse to write.
    agentPrompt: opts.agentPrompt,
    // A child testing an app does not stream into the parent's view: its steps are drawn
    // in its own place, and frames with nowhere to go would only be copied for nothing.
    onLive: undefined,
    // CLEARED, not inherited. This line used to copy the parent's value under a
    // comment claiming it cleared it, and the engine's gate is
    // `guarded && !guardAllowed.has(tool)` — so an inherited grant skipped the check
    // outright. Combined with the missing approval channel below, a sub-agent the user
    // never saw start could edit files with no prompt at all, while SECURITY.md
    // promised Sentinel "covers every tool including sub-agent edits".
    //
    // "Allow all" is a judgement the user made about work they could see. It does not
    // transfer to an agent they did not know would run. A guarded child has no channel
    // to ask through, so its mutating tools are refused and it reports back instead —
    // which is the failing direction to pick.
    guardAllowed: undefined,
    // Cleared for the same reason, and it was missed when this one was added: a folder
    // the user allowed writing to is a judgement about work they were watching. The line
    // to draw is between permissions the session was STARTED with, which describe the job
    // and belong to every part of it, and permissions granted mid-session in answer to a
    // question about one specific piece of work. Only the first kind is inherited.
    allowedOutsideDirs: undefined,
    // The parent's approved plan is NOT the child's work. Two things go wrong when it
    // rides along: the child is handed a binding instruction to follow a plan it was not
    // spawned for, on top of the one task it was given — and because a child runs the
    // same turn loop, its turn ending settles that plan, marking the artifact DONE on
    // disk while the parent is still in the middle of carrying it out.
    //
    // Empty string, not undefined: undefined means "not looked for yet" and would send
    // the child to load the plan straight back off disk.
    activePlan: "",
    activePlanApprovedAt: undefined,
    // A child CANNOT reach the user. The spread above inherited the parent's approval
    // channel, so `ask_user` (which is read-only, and therefore offered even to a
    // read-only child) put a question on screen from an agent the user never saw start
    // — and a parallel fan-out could stack several, none of them attributable. It also
    // made spawn_subagent's own briefing advice false: "write a COMPLETE, standalone
    // task" only holds if the child truly cannot come back and ask.
    // Every consumer of this channel already degrades correctly without it: ask_user
    // tells the child to assume a sensible default and state it, and the guards fail
    // closed. The child's findings reach the user through its result, where the parent
    // can weigh them.
    requestApproval: undefined,
  };
  return {
    ...parent,
    id,
    createdAt: Date.now(),
    transcript: [{ role: "user", content: SUBAGENT_PREAMBLE + task }],
    toolContext: childContext,
  };
}

/** A brand-new session rooted at `cwd` (defaults to the process cwd). */
/**
 * A brand-new session.
 *
 * `carryRoots` is for starting over WITHOUT losing the workspace: `/clear` builds a
 * fresh session in the same folder, and the folders someone added with `/include` or
 * `/link` belong to the folder they are working in, not to the conversation they just
 * ended. Dropping them was silent — every tool quietly narrowed to one root and
 * nothing said so. Missing folders are filtered and the primary is de-duplicated, the
 * same way `resumeSession` treats the roots it restores.
 */
export async function createSession(
  rawCwd: string = process.cwd(),
  carryRoots: readonly string[] = [],
): Promise<Session> {
  // Canonicalise the root ONCE, here, before anything derives from it. run_command
  // reports where it ended up as a physical path, and on macOS a great deal sits
  // behind symlinks (/tmp, and all of os.tmpdir()), so a session opened at a logical
  // path would compare unequal to its own cwd after the first command. See
  // canonicalRoot. Doing it at the single point of entry is what keeps every root,
  // every recorded cwd, and every relativized path speaking the same form.
  const cwd = await canonicalRoot(rawCwd);
  const [projectMemory, memoryIndex, projectContext, governance, stamp, modelConfig, earlier] = await Promise.all([
    loadProjectMemory(cwd),
    loadMemory(cwd),
    projectContextText(cwd),
    loadGovernance(cwd),
    governanceStamp(cwd),
    loadModelConfig(cwd),
    listSessions(cwd),
  ]);
  const id = randomUUID();
  // Canonicalised BEFORE comparing. `cwd` has already been through canonicalRoot, so a
  // raw string comparison misses the primary root arriving in another spelling — an 8.3
  // short path, a symlinked temp directory, different drive-letter case — and adds it a
  // second time. CI caught exactly that: its temp directory canonicalises differently
  // from the path handed in, so the workspace came back with the same folder twice.
  const carried = await Promise.all(carryRoots.map((r) => canonicalRoot(r)));
  const seenRoot = new Set([cwd]);
  const extra = carried.filter((r) => {
    if (seenRoot.has(r) || !existsSync(r)) return false;
    seenRoot.add(r);
    return true;
  });
  const toolContext = freshToolContext(cwd, governance, [cwd, ...extra]);
  // So the session tools can exclude this conversation from "your past sessions".
  toolContext.sessionId = id;
  // Undo history is written next to the session, so it survives closing the app.
  toolContext.checkpoints?.persistTo(checkpointDir(cwd, id));
  attachMcp(toolContext, cwd);
  await seedProjectMemoryRead(toolContext, projectMemory);
  return {
    id,
    cwd,
    createdAt: Date.now(),
    transcript: [],
    toolContext,
    projectMemory,
    memoryDir: memoryDir(cwd),
    memoryIndex,
    // Everything already saved predates this brand-new session.
    priorSessions: earlier.length,
    projectContext,
    governance,
    // Stamped at load so the first turn's freshness check settles instead of reloading
    // what was just read. See governor/freshness.ts.
    governanceStamp: stamp,
    modelConfig,
  };
}

/**
 * Resume the most recent saved session for `cwd` (or a specific `id`), returning
 * a live Session with its transcript loaded. Returns null when there's nothing
 * to resume. The tool context starts fresh — the model re-reads files before it
 * edits them (that's the read-before-edit contract), so a resumed session simply
 * re-reads as needed rather than trusting a stale ledger.
 */
/**
 * Repair a transcript that was cut off mid-tool. If the session was closed between the
 * model issuing tool calls and their results being recorded (PC shutdown, force-kill,
 * crash), some `tool_calls` have no matching `tool` result — which the provider rejects
 * (breaking /continue) and which hides that the tool never finished. For every
 * unanswered call we insert a synthetic result, right after its assistant message so the
 * tool group stays contiguous, marking it interrupted so the model re-checks the real
 * state before trusting or repeating it. Pure; returns a new array (unchanged if nothing
 * was dangling). Exported for tests.
 */
/**
 * Move anything that got wedged BETWEEN a `tool_calls` message and its results back
 * out to after them. Pure; returns a new array (unchanged when nothing is stranded).
 *
 * Providers require a message carrying `tool_calls` to be followed immediately by one
 * `tool` message per call. A build of Mindweave briefly appended its narration nudge
 * the moment it judged the fault — right after the assistant message and before any
 * result — so sessions written in that window hold a permanently invalid order and
 * every resume of one dies on the first request:
 *
 *   assistant(tool_calls) → user(nudge) → tool → tool        ← rejected
 *   assistant(tool_calls) → tool → tool → user(nudge)        ← what it should be
 *
 * The engine no longer produces this, but a fix that only stops NEW corruption leaves
 * the already-saved sessions unopenable, and those hold the user's actual work. The
 * stranded message is MOVED rather than dropped: it may be something the person typed,
 * and repair is not a licence to lose it.
 */
export function repairToolCallOrder(transcript: Entry[]): Entry[] {
  const out: Entry[] = [];
  let moved = false;
  let i = 0;

  while (i < transcript.length) {
    const entry = transcript[i]!;
    out.push(entry);
    i++;
    if (entry.role !== "assistant" || !entry.toolCalls?.length) continue;

    const owed = new Set(entry.toolCalls.map((c) => c.id));
    const results: Entry[] = [];
    const stranded: Entry[] = [];
    // Walk forward while results are still outstanding, keeping them in order and
    // setting aside anything that does not belong inside the group. A new assistant
    // message means the group was abandoned — stop and let reconcile fill the gaps.
    while (i < transcript.length && owed.size > 0) {
      const next = transcript[i]!;
      if (next.role === "assistant") break;
      if (next.role === "tool" && owed.has(next.toolCallId)) {
        owed.delete(next.toolCallId);
        results.push(next);
      } else {
        stranded.push(next);
        moved = true;
      }
      i++;
    }
    out.push(...results, ...stranded);
  }

  return moved ? out : transcript;
}

export function reconcileInterruptedTools(
  transcript: Entry[],
  /** Why the results are missing, as the model is told. Defaults to the session having been closed. */
  why = "the session was closed before this tool returned",
): Entry[] {
  const answered = new Set<string>();
  for (const e of transcript) if (e.role === "tool") answered.add(e.toolCallId);

  let repaired = false;
  const out: Entry[] = [];
  for (const e of transcript) {
    out.push(e);
    if (e.role === "assistant" && e.toolCalls?.length) {
      for (const call of e.toolCalls) {
        if (answered.has(call.id)) continue;
        answered.add(call.id); // guard against a (malformed) duplicate id
        repaired = true;
        out.push({
          role: "tool",
          toolCallId: call.id,
          content:
            `[interrupted] '${call.name}' did not finish — ${why}, ` +
            `so its effect on disk/state is unknown. Re-check the current state (files, ` +
            `processes, installs) before relying on it or running it again.`,
          summary: `${call.name} — interrupted`,
          isError: true,
        });
      }
    }
  }
  return repaired ? out : transcript;
}

export async function resumeSession(
  cwd: string = process.cwd(),
  id?: string,
): Promise<Session | null> {
  const meta = id ? await loadMeta(cwd, id) : await latestSession(cwd);
  if (!meta) return null;

  const loaded = await loadTranscript(cwd, meta.id);
  if (!loaded || loaded.length === 0) return null;
  // A session closed mid-tool (PC shutdown, force-kill) leaves the model's tool_calls
  // with no results — invalid to replay and silent about what didn't finish. Repair it
  // so /continue resumes cleanly and the model re-checks the interrupted step.
  // Order first, then fill gaps: reconcile inserts results right after their assistant
  // message, so it must see a group that is already contiguous.
  const transcript = reconcileInterruptedTools(repairToolCallOrder(loaded));

  const [projectMemory, memoryIndex, projectContext, governance, stamp, modelConfig, sessionMemory, saved, earlier] =
    await Promise.all([
      loadProjectMemory(cwd),
      loadMemory(cwd),
      projectContextText(cwd),
      loadGovernance(cwd),
      governanceStamp(cwd),
      loadModelConfig(cwd),
      loadSessionNotes(cwd, meta.id),
      listSessions(cwd),
      loadEarlier(cwd, meta.id),
    ]);
  // Restore any added roots that still exist on disk (primary first).
  const extra = (meta.extraRoots ?? []).filter((r) => existsSync(r));
  const roots = [cwd, ...extra];
  const toolContext = freshToolContext(cwd, governance, roots);
  // Undo history was written next to the session; bring it back. A session from before
  // that existed (or one whose history was pruned) has none even though its turns really
  // did change files, and marking it lets /undo and rewind say so rather than claim
  // nothing happened.
  const kept = (await toolContext.checkpoints?.restoreFrom(checkpointDir(cwd, meta.id), cwd)) ?? 0;
  if (kept === 0) toolContext.checkpoints?.noteResumed();
  toolContext.sessionId = meta.id;
  // Re-advertise the deferred tools this session had already surfaced, so a continued
  // session keeps them callable instead of stripping a tool the model was mid-use of.
  if (meta.activatedTools && meta.activatedTools.length > 0) {
    toolContext.activatedTools = new Set(meta.activatedTools);
  }
  // The task list, so a continued session still has the work it was tracking.
  if (Array.isArray(meta.todos)) toolContext.todos = meta.todos;
  attachMcp(toolContext, cwd);
  await seedProjectMemoryRead(toolContext, projectMemory);
  // What the model has already read is in the transcript it is about to be handed, so the
  // ledger has to agree with it. See restoreReadLedger for what a stale ledger cost.
  await restoreReadLedger(toolContext, transcript, meta.updatedAt ?? 0);
  return {
    id: meta.id,
    cwd,
    createdAt: meta.createdAt ?? Date.now(),
    transcript,
    toolContext,
    projectMemory,
    memoryDir: memoryDir(cwd),
    memoryIndex,
    // The session being resumed is not "prior" to itself.
    priorSessions: Math.max(0, saved.filter((m) => m.id !== meta.id).length),
    // What compaction took out, for redrawing the chat only (memory/earlier.ts).
    ...(earlier.length > 0 ? { earlier } : {}),
    projectContext,
    governance,
    // Stamped at load so the first turn's freshness check settles instead of reloading
    // what was just read. See governor/freshness.ts.
    governanceStamp: stamp,
    modelConfig,
    // The maintained session notes survive a resume, so a continued session keeps its
    // crisp running state. The watermark starts fresh; it'll refresh as it grows again.
    ...(sessionMemory ? { sessionMemory, sessionMemoryInit: true } : {}),
    // What the session has already cost, and the per-call detail behind it.
    //
    // Restored, not restarted. Leaving these out did not merely forget the earlier
    // turns — the next save OVERWRITES the meta file, so a resumed session replaced a
    // true running total with a smaller one and the earlier spend was gone for good. A
    // session's cost is the cost of the whole session; `/continue` is not a new session.
    //
    // Deliberately unlike `prefixPrint`, which is NOT restored: that one asserts the
    // provider still holds a cache, and after a resume it does not. These are records of
    // what happened, and what happened does not stop being true.
    ...(meta.spend ? { spend: meta.spend } : {}),
    ...(meta.callLog ? { callLog: meta.callLog } : {}),
    // What the session did so far, so the counts of a continued session are the whole session's.
    ...(meta.counters ? { counters: meta.counters } : {}),
    // A measurement of this session, true after a resume as long as the model is the
    // same (the engine checks that before using it). Without it a reopened session read
    // as nearly empty until its first call.
    ...(meta.contextOverhead ? { contextOverhead: meta.contextOverhead } : {}),
    // A goal in progress (or its outcome) is a fact about the session, same as spend —
    // resuming must not silently drop it, or a Marathon paused by a restart just vanishes.
    ...(meta.marathon ? { marathon: meta.marathon } : {}),
  };
}

/**
 * Put back what the model has ALREADY READ, on resume.
 *
 * The read ledger lives on the tool context, so `/continue` started with it empty while
 * the transcript still carried whole files the model could plainly see. Everything
 * downstream then disagreed with what was on screen: the read-before-overwrite gate
 * refused ("hasn't been read this session") for a file whose contents were three
 * messages up, and the read-dedup could not fire, so the model re-read it and appended a
 * SECOND full copy to the transcript.
 *
 * That is a compounding cost, not a one-off. Every resume added another copy of the same
 * file, so each `/continue` replayed a bigger transcript than the last — with a cold
 * provider cache — and took longer than the last. Restoring the ledger is what stops the
 * loop; the transcript was always the evidence, it just was not being read.
 *
 * SAFETY, and why this cannot simply trust the transcript. A file may have been edited on
 * disk while the session was closed, and the copy in the transcript is then stale — so
 * opening the write gate on it would let the model replace a file it has an out-of-date
 * view of. A path is therefore only restored when the file has NOT been touched since the
 * session was last saved. The failure direction is the safe one: a file that changed
 * while away is re-read, exactly as it is today.
 */
/**
 * Make the read ledger agree with the transcript again, after the transcript was cut
 * back (a rewind). The same restore a resume does: a file counts as read only if the
 * conversation still holds that read and nothing changed the file since. Entries with
 * no stamp are judged against 0, so an unknown read is re-read rather than trusted.
 */
export async function rebuildReadLedger(session: Session): Promise<void> {
  const ctx = session.toolContext;
  ctx.reads.clear();
  await seedProjectMemoryRead(ctx, session.projectMemory);
  await restoreReadLedger(ctx, session.transcript, 0);
}

async function restoreReadLedger(ctx: ToolContext, transcript: Entry[], savedAt: number): Promise<void> {
  const resolve = (p: string): string | undefined => {
    try {
      return resolvePath(ctx, p);
    } catch {
      return undefined;
    }
  };

  // READ **and** WRITTEN. A file the model wrote last session is a file it has seen: the
  // whole content was in the call's own arguments, and an edit could only have followed a
  // read. Restoring reads alone left the gate refusing files the model itself created,
  // and it re-read them — appending another full copy of each, which is the exact cost
  // this restore exists to remove.
  const seen = new Set([...fullReadPaths(transcript, resolve), ...writtenPaths(transcript, resolve)]);

  // When each file was last read or written, so freshness is judged per file rather than
  // against the moment the session closed. A file touched after the model read it, but
  // before the session ended, is stale — and comparing everything against one session-wide
  // time cannot see that. Entries from before stamps existed fall back to the session's
  // own save time, which is the best that can be said about them.
  const lastSeenAt = new Map<string, number>();
  for (const entry of transcript) {
    const at = entry.ts ?? savedAt;
    for (const path of new Set([...fullReadPaths([entry], resolve), ...writtenPaths([entry], resolve)])) {
      lastSeenAt.set(path, Math.max(lastSeenAt.get(path) ?? 0, at));
    }
  }

  // Newest first, capped. An unbounded restore turns a long session's every mentioned
  // file into a stat at startup, and the oldest of them are the least likely to be what
  // the next turn is about.
  const ordered = [...seen].sort((a, b) => (lastSeenAt.get(b) ?? 0) - (lastSeenAt.get(a) ?? 0));

  for (const abs of ordered.slice(0, RESTORE_LEDGER_MAX)) {
    try {
      const st = await fs.stat(abs);
      // Touched since the model last saw it: the transcript's copy may be stale, so it is
      // left out and re-read. The failure direction is the safe one.
      if (st.mtimeMs > (lastSeenAt.get(abs) ?? savedAt)) continue;
      ctx.reads.set(abs, { mtimeMs: st.mtimeMs, size: st.size, full: true, touchedAt: nextTouch() });
    } catch {
      // Gone from disk. Nothing to claim, and the model will find out when it looks.
    }
  }
}

/** How many files a resume puts back. Past this it stops being "where I was" and becomes
 *  a stat of the whole session's history at startup. */
const RESTORE_LEDGER_MAX = 100;
