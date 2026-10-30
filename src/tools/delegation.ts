/**
 * delegation.ts — the rules for handing work to sub-agents (pure, apart from the lock table).
 *
 * Sub-agents are expensive: each is a whole agent with its own context, and a model asked to be thorough will happily start ten
 * for work one could do. So delegation is not just allowed, it is metered and checked here, in code, where a model cannot talk its
 * way past it:
 *
 *  - Workers that run side by side must each say which SLICE of the work they own, and two may not own the same one.
 *  - A worker that EDITS in parallel must name the files or folders it may change (its write scope). Scopes may not overlap, and
 *    the engine refuses any edit outside the worker's own (see `inScope`). Two workers can therefore never write the same file.
 *  - A turn has a ceiling on how many workers it may start and how many steps they may spend between them.
 *  - A task that is nearly the same as one already given this turn is turned away: the answer is already coming.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/** What one turn may spend on sub-agents. */
export interface DelegationLimits {
  /** Workers that may run at the same moment. The rest wait their turn. */
  concurrent: number;
  /** Workers one turn may start in all. */
  perTurn: number;
  /** Steps all of a turn's workers may take between them. */
  stepsPerTurn: number;
}

export const DEFAULT_LIMITS: DelegationLimits = { concurrent: 10, perTurn: 12, stepsPerTurn: 300 };

/** The shortest task a worker that runs in parallel may be given: a one-line prompt is a sign the work did not need one. */
export const MIN_PARALLEL_TASK_CHARS = 60;

/** What a turn has handed out so far. A fresh one starts with each message the person sends. */
export interface Delegation {
  started: number;
  steps: number;
  /** The task of every worker started this turn, for the duplicate check. */
  tasks: string[];
  /** The slice each started worker owns, lower-cased. */
  slices: Set<string>;
}

export const newDelegation = (): Delegation => ({ started: 0, steps: 0, tasks: [], slices: new Set() });

// ── write scopes ─────────────────────────────────────────────────────────────────────────

/**
 * A scope as a path inside the project, written with forward slashes and no trailing slash (pure). A scope names a file or a
 * folder; "the whole project" is not one, and neither is a pattern or a path that leaves the project.
 */
export function normalizeScope(raw: string, cwd: string): { ok: true; scope: string } | { ok: false; reason: string } {
  let text = raw.trim().replace(/\\/g, "/");
  if (!text) return { ok: false, reason: "an empty path" };
  text = text.replace(/\/\*\*?$/, "").replace(/\/+$/, ""); // "src/ui/**" and "src/ui/" both mean the folder
  if (/[*?[\]{}]/.test(text)) return { ok: false, reason: `"${raw}" is a pattern; name the files or folders themselves` };
  const abs = isAbsolute(text) ? resolve(text) : resolve(cwd, text);
  const rel = relative(resolve(cwd), abs).split(sep).join("/");
  if (rel === "" || rel === ".") return { ok: false, reason: `"${raw}" is the whole project, which is not a scope; name the files or folders it may change` };
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return { ok: false, reason: `"${raw}" is outside the project` };
  return { ok: true, scope: rel };
}

/** Whether one scope contains the other, or they are the same, by whole path segments (pure). */
export function scopesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/** Whether a file (relative to the project) is inside any of the scopes (pure). */
export function inScope(rel: string, scopes: readonly string[]): boolean {
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return scopes.some((s) => clean === s || clean.startsWith(s + "/"));
}

/** The project-relative form of a path a tool was given, or null when it is outside the project (pure). */
export function relativeToProject(path: string, cwd: string): string | null {
  const rel = relative(resolve(cwd), isAbsolute(path) ? resolve(path) : resolve(cwd, path)).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Who holds which scope right now, across everything running in this process. Taking a scope that overlaps one already held is
 * refused, not queued: the second worker would be waiting on the first for as long as it ran, and the lead agent is better placed
 * to decide whether to split the work differently or do the second part after the first.
 */
export class ScopeLocks {
  private held: Array<{ owner: string; label: string; scope: string }> = [];

  /** Take every scope for `owner`, or none. Returns who is in the way when it cannot. */
  acquire(owner: string, label: string, scopes: readonly string[]): { ok: true } | { ok: false; scope: string; heldBy: string; heldScope: string } {
    for (const scope of scopes) {
      const clash = this.held.find((h) => h.owner !== owner && scopesOverlap(h.scope, scope));
      if (clash) return { ok: false, scope, heldBy: clash.label, heldScope: clash.scope };
    }
    for (const scope of scopes) this.held.push({ owner, label, scope });
    return { ok: true };
  }

  release(owner: string): void {
    this.held = this.held.filter((h) => h.owner !== owner);
  }

  /** How many scopes are held (for tests). */
  get size(): number {
    return this.held.length;
  }
}

/** The one table for the process: workers of different sessions share a project's files too. */
export const scopeLocks = new ScopeLocks();

// ── writing to a worker while it runs ────────────────────────────────────────────────────

/** What the person has typed to each running worker, waiting for its next step. */
const inboxes = new Map<string, string[]>();

/** A worker is running and can be written to. */
export const openInbox = (agentId: string): void => void inboxes.set(agentId, []);

/** The worker has ended: nothing more can be sent to it. */
export const closeInbox = (agentId: string): void => void inboxes.delete(agentId);

/**
 * Put a message to a running worker (impure). It reaches the worker at the end of its current step, the way a message typed during the
 * main agent's turn reaches the main agent, and the worker reads it as a note from the person. "gone" when it is not running.
 */
export function sendToAgent(agentId: string, text: string): "queued" | "gone" {
  const box = inboxes.get(agentId);
  if (!box || !text.trim()) return "gone";
  box.push(text.trim());
  return "queued";
}

/** Take what is waiting for a worker (impure). */
export function takeInbox(agentId: string): string[] {
  const box = inboxes.get(agentId);
  return box && box.length > 0 ? box.splice(0) : [];
}

// ── what a scoped worker may do ──────────────────────────────────────────────────────────

/**
 * The only tools, beyond reading and searching, a worker with a write scope is offered: the ones that change a named file. It has no
 * shell, no memory writes and no app driver, because any of those could change a file outside its scope by another route. The lead
 * (or a verifier) builds and tests once the workers are back.
 */
export const SCOPED_EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write_file", "replace_symbol_body", "todo_write"]);

/** Tools among those above that name a file in `path`, which must lie inside the scope. */
const PATH_TOOLS = new Set(["edit", "write_file", "replace_symbol_body"]);

/**
 * Why a call by a scoped worker is refused, or null when it may run (pure). `replace_symbol_body` may leave out `path` and find the
 * symbol anywhere, which could be outside the scope, so for a scoped worker the path is required.
 */
export function scopeRefusal(tool: string, args: Record<string, unknown>, scopes: readonly string[], cwd: string): string | null {
  if (!SCOPED_EDIT_TOOLS.has(tool)) {
    return `Refused: '${tool}' could change files outside your scope. You may only edit ${scopes.join(", ")}. Report what you did and what is left.`;
  }
  if (!PATH_TOOLS.has(tool)) return null;
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return `Refused: '${tool}' needs the \`path\` of a file inside your scope (${scopes.join(", ")}).`;
  const rel = relativeToProject(path, cwd);
  if (rel === null || !inScope(rel, scopes)) {
    return `Refused: ${path} is outside your scope. You may only change ${scopes.join(", ")}. Another worker owns the rest; say in your report what you would need changed there.`;
  }
  return null;
}

// ── the checks a spawn goes through ──────────────────────────────────────────────────────

const STOP = new Set("the and for with that this from into over under about each every only also then them they their there which what when where will shall should would could have has had are was were been being your you our its not but can may must any all one two use used using make made file files code".split(" "));

/** The words that say what a task is about, for comparing two tasks (pure). */
function topicWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.\/-]+/)
      .filter((w) => w.length >= 2 && !STOP.has(w)),
  );
}

/** How alike two tasks are, 0 to 1: the share of their topic words they have in common (pure). */
export function taskSimilarity(a: string, b: string): number {
  const x = topicWords(a);
  const y = topicWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * Tasks this alike are the same job. Deliberately high: a lead that fans out over ten modules writes ten tasks that differ by one
 * name, and those are ten jobs. What this catches is the same task sent twice; the slices already keep two workers off the same part.
 */
export const DUPLICATE_AT = 0.95;

/** The file or folder names a task mentions: the part of it that says WHERE the work is. */
const pathWords = (text: string): Set<string> => new Set(text.toLowerCase().split(/[s,;()"'`]+/).filter((w) => /[/]/.test(w) || /.[a-z0-9]{1,5}$/.test(w)));

/** Whether two tasks are the same job: worded alike, and pointing at the same places (pure). */
export function sameJob(a: string, b: string): boolean {
  if (taskSimilarity(a, b) < DUPLICATE_AT) return false;
  const x = pathWords(a);
  const y = pathWords(b);
  if (x.size === 0 || y.size === 0) return true;
  // Tasks worded the same about different files are different jobs.
  for (const w of x) if (y.has(w)) return true;
  return false;
}

export interface SpawnRequest {
  task: string;
  slice: string;
  /** Can this worker run beside others (read-only, or an editor with its own scope)? */
  parallel: boolean;
}

/**
 * Whether a worker may be started now, and if not the reason, written for the model that asked (pure over the ledger it is given).
 * Everything is a plain refusal with what to do instead; nothing here starts, stops or changes a worker.
 */
export function refuseSpawn(ledger: Delegation, limits: DelegationLimits, req: SpawnRequest): string | null {
  if (ledger.started >= limits.perTurn) {
    return `Not started: this turn has already used its ${limits.perTurn} workers. Carry on with what they returned, or do the rest yourself.`;
  }
  if (ledger.steps >= limits.stepsPerTurn) {
    return `Not started: the workers of this turn have already taken ${ledger.steps} steps, and the limit is ${limits.stepsPerTurn}. Use what they found, or do the rest yourself.`;
  }
  if (req.parallel) {
    const slice = req.slice.trim().toLowerCase();
    if (!slice) {
      return "Not started: a worker that runs beside others must say which part of the work it owns. Give `slice` a short name for it (for example \"auth routes\"), different from every other worker's.";
    }
    if (ledger.slices.has(slice)) {
      return `Not started: another worker this turn already owns the slice "${req.slice.trim()}". Two workers on the same part do the same work twice. Give this one a different part, or leave it out.`;
    }
    if (req.task.trim().length < MIN_PARALLEL_TASK_CHARS) {
      return `Not started: that task is only ${req.task.trim().length} characters. A job short enough to describe in a line is quicker to do yourself than to hand over. Describe what the worker needs, or do it directly.`;
    }
  }
  for (const earlier of ledger.tasks) {
    if (sameJob(earlier, req.task)) {
      return "Not started: that task is almost the same as one already given this turn, and its answer is on the way. Use that one.";
    }
  }
  return null;
}

/** Record a worker as started (impure: edits the ledger it is given). */
export function noteSpawn(ledger: Delegation, req: SpawnRequest): void {
  ledger.started++;
  ledger.tasks.push(req.task);
  if (req.slice.trim()) ledger.slices.add(req.slice.trim().toLowerCase());
}

/** The line that closes a worker's result, so the model sees what the turn has spent (pure). */
export function delegationLine(ledger: Delegation, limits: DelegationLimits): string {
  return `Delegation this turn: ${ledger.started} of ${limits.perTurn} workers, ${ledger.steps} of ${limits.stepsPerTurn} steps.`;
}
