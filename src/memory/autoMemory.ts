/**
 * autoMemory.ts — Mindweave's cross-session memory store.
 *
 * This is the persistence layer for what Mindweave learns and is asked to remember:
 * facts about the user, feedback on how to work, project context, and pointers
 * to external systems. It is the personal-memory layer, SEPARATE from two things
 * it must not duplicate:
 *   - MINDWEAVE.md          — the project's own knowledge file (read each session).
 *   - the governor      — standing rules / skills / forbidden paths.
 *
 * Layout (under the same per-project state dir as sessions and the governor):
 *   ~/.mindweave/projects/<slug>/memory/
 *     MEMORY.md      — the index: one line per memory, ALWAYS loaded into the
 *                      prompt. Capped, so it stays a cheap table of contents.
 *     <name>.md      — one topic file per memory, with a small frontmatter
 *                      header. Read on demand by the model (grep/read), not
 *                      auto-loaded.
 *
 * The model writes here through the `save_memory` tool, which saves SILENTLY: the
 * user asked not to be made to approve each one. (This comment used to say the tool
 * "confirms with the user first", which stopped being true when the prompt was
 * dropped — worth stating plainly, because "we ask first" is exactly the kind of
 * assurance someone reads once and then relies on.) This module is the mechanism
 * only — it does not decide WHAT is worth remembering; that is the model's
 * judgment, guided by the prompt.
 *
 * Like store.ts, this is the CLIENT side of the eventual client/server split:
 * the pure engine never calls in here. All writes are best-effort.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import { projectDir } from "./store.js";

/** The closed set of memory types (mirrors the prompt's taxonomy). */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

export const MEMORY_INDEX = "MEMORY.md";
// Caps for the always-loaded index. Lines is the natural boundary; bytes catches
// a short index with very long lines. Past either, we load a prefix + a warning.
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;

/** The memory directory for a project (under its state dir). */
export function memoryDir(projectCwd: string): string {
  return join(projectDir(projectCwd), "memory");
}

/** Create the memory directory if absent, so the model never has to mkdir. */
export async function ensureMemoryDir(projectCwd: string): Promise<void> {
  try {
    await fs.mkdir(memoryDir(projectCwd), { recursive: true });
  } catch {
    // Best-effort: a real perms error surfaces when save_memory's write fails.
  }
}

/**
 * Read MEMORY.md for injection into the prompt, truncated to the caps. Returns
 * "" when there is no index yet (the prompt then says memory is empty).
 */
export async function loadMemoryIndex(projectCwd: string): Promise<string> {
  const dir = memoryDir(projectCwd);
  let raw: string;
  try {
    raw = await fs.readFile(join(dir, MEMORY_INDEX), "utf8");
  } catch {
    return "";
  }
  return truncateIndex(await markStale(dir, (await reconcileIndex(dir, raw)).trim()));
}

/** Old enough that acting on it without checking is a real risk. Two months is past any
 *  normal "we were just doing that" window without flagging this week's notes. */
const STALE_AFTER_DAYS = 60;
const DAY_MS = 86_400_000;

/**
 * Append an age marker to index lines whose topic file is old (impure — stats the files).
 *
 * WHY A MARKER AND NOT A DATE. Models are poor at date arithmetic: a raw
 * `2026-03-02T…` timestamp does not make a model hesitate the way being told the thing
 * is old does. The arithmetic has to be done for it, or it may as well not be there.
 *
 * WHY COARSE, AND ONLY WHEN OLD. This index is rendered into the system prompt, which is
 * the CACHED prefix of every request. An exact age ("47 days ago") changes daily, so each
 * memory would silently break the cache once a day for the rest of its life, and with a
 * hundred memories that is a break most days — paying a full prefix rewrite for a
 * cosmetic difference. Two buckets change at most twice in a memory's whole existence,
 * and recent memories get no marker at all, so the common line is byte-identical to what
 * it was before this existed.
 *
 * Failure is silent by design: an unreadable file just goes unmarked. The index being
 * loadable matters more than any one line carrying its age.
 */
async function markStale(dir: string, index: string, now = Date.now()): Promise<string> {
  const lines = index.split("\n");
  const marked = await Promise.all(
    lines.map(async (line) => {
      const file = /\]\(([^)]+\.md)\)/.exec(line)?.[1];
      if (!file || line.includes(" — older]") || /\(months old\)|\(over a year old\)/.test(line)) return line;
      let days: number;
      try {
        days = (now - (await fs.stat(join(dir, file))).mtimeMs) / DAY_MS;
      } catch {
        return line;
      }
      if (days < STALE_AFTER_DAYS) return line;
      return `${line} (${days >= 365 ? "over a year old" : "months old"})`;
    }),
  );
  return marked.join("\n");
}

/**
 * Give back a pointer to any memory that has one on disk but none in the index (pure
 * except for reading the directory).
 *
 * This is what makes a lost index line survivable instead of fatal. The index is
 * read-modify-write, so two Mindweave instances open on one project can each write an
 * index that lacks the other's line. Serialising fixes that inside a process and cannot
 * fix it between two, and the alternatives all rest on a guess: a retry budget large
 * enough, or a lock file with a staleness timeout long enough. Both are timing, and
 * timing is what this project has learned not to trust.
 *
 * Reconciling needs no timing at all. The topic FILE is the durable record and it is
 * never the thing lost; the pointer is derived from it. So a dropped line costs
 * visibility until the next read rather than forever, and the repair is deterministic:
 * the same directory always produces the same index.
 *
 * The recovered line is rebuilt from the file's own frontmatter, which is why the hook
 * comes back as its `description` rather than the original prose. That is a real loss of
 * flavour and the right trade: a memory listed plainly is found, and one not listed at
 * all may as well not exist.
 *
 * Costs one directory read per session when nothing is missing, which is the normal case.
 */
async function reconcileIndex(dir: string, index: string): Promise<string> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return index;
  }
  const orphans = names.filter((n) => n.endsWith(".md") && n !== MEMORY_INDEX && !indexLists(index, n));
  if (orphans.length === 0) return index;

  let out = index;
  for (const file of orphans.sort()) {
    const meta = await frontmatterOf(join(dir, file));
    // Skip a file we cannot read a name out of rather than listing it as "undefined":
    // an unreadable entry in the always-loaded index is worse than a missing one.
    if (!meta.name) continue;
    out = applyIndexUpsert(out, file, `- [${meta.name}](${file}) — ${meta.description || "recovered entry"}`);
  }
  return out;
}

/** The `name:` and `description:` from a memory file's frontmatter. */
async function frontmatterOf(path: string): Promise<{ name: string; description: string }> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return {
      name: /^name:[ \t]*(.*)$/m.exec(raw)?.[1]?.trim() ?? "",
      description: /^description:[ \t]*(.*)$/m.exec(raw)?.[1]?.trim() ?? "",
    };
  } catch {
    return { name: "", description: "" };
  }
}

/** Line-cap first (clean boundary), then byte-cap at the last newline that fits. */
function truncateIndex(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  const overLines = lines.length > MAX_INDEX_LINES;
  const overBytes = content.length > MAX_INDEX_BYTES;
  if (!overLines && !overBytes) return content;

  let out = overLines ? lines.slice(0, MAX_INDEX_LINES).join("\n") : content;
  if (out.length > MAX_INDEX_BYTES) {
    const cut = out.lastIndexOf("\n", MAX_INDEX_BYTES);
    out = out.slice(0, cut > 0 ? cut : MAX_INDEX_BYTES);
  }
  return `${out}\n\n> WARNING: ${MEMORY_INDEX} is too long and was only partly loaded. Keep each index entry to one short line; move detail into the topic files.`;
}

/** A memory the model wants to persist. `indexLine` is the one-line hook for MEMORY.md. */
export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  indexLine: string;
}

export interface SavedMemory {
  name: string;
  file: string; // the topic file name, e.g. "user-role.md"
  updated: boolean; // true when it replaced an existing memory of the same name
  /**
   * Set only when the memory overwritten was filed under a DIFFERENT name.
   *
   * Names are slugified and clipped to 60 characters, so two distinct names can land
   * on one file — and then the write is not the update it appears to be, it is a
   * deletion. "Memory is non-destructive" is the stated reason the user is never
   * asked about a save, so the one case where that is untrue has to be reported
   * rather than absorbed.
   */
  replaced?: string;
}

/**
 * Write a memory: the topic file (frontmatter + body) plus its pointer line in
 * MEMORY.md. A memory whose name slugs to an existing file is an UPDATE — the
 * topic file is overwritten and its index line replaced in place, so the model
 * refining a fact never creates a duplicate.
 */
export async function saveMemory(projectCwd: string, m: MemoryInput): Promise<SavedMemory> {
  await ensureMemoryDir(projectCwd);
  const dir = memoryDir(projectCwd);
  const slug = slugify(m.name);
  const file = `${slug}.md`;
  const path = join(dir, file);

  const previous = await existingName(path);
  const updated = previous !== null;
  // Atomic: cross-session memory is the one thing here that OUTLIVES the session, so a
  // torn write costs a fact the user expected to be remembered permanently.
  await writeFileAtomic(path, renderMemoryFile(m));
  await upsertIndexLine(dir, file, `- [${oneLine(m.name)}](${file}) — ${oneLine(m.indexLine)}`);

  const replaced = previous && previous !== oneLine(m.name) ? previous : undefined;
  return { name: m.name, file, updated, ...(replaced ? { replaced } : {}) };
}

/** The `name:` of the memory already at `path`, or null if there is no file there.
 *  Returns "" for a file we cannot parse, which still counts as "something was here". */
async function existingName(path: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return /^name:[ \t]*(.*)$/m.exec(raw)?.[1]?.trim() ?? "";
  } catch {
    return null;
  }
}

function renderMemoryFile(m: MemoryInput): string {
  // Flat key: value frontmatter, the same shape the governor and skills use.
  // Values are flattened to ONE line: these are model-supplied strings going into a
  // line-oriented format, so an embedded newline would start what parses as a new
  // frontmatter key — a `description` ending in "\ntype: user" would silently
  // re-file the memory. Nothing malicious is needed for this, just a pasted title.
  return [
    "---",
    `name: ${oneLine(m.name)}`,
    `description: ${oneLine(m.description)}`,
    `type: ${m.type}`,
    "---",
    "",
    m.body.trim(),
    "",
  ].join("\n");
}

/** Collapse any newline/carriage return into a space, so a value stays one field. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this line point at `file`?
 *
 *  Anchored to the start on purpose. The old test was `line.includes("(file.md)")`,
 *  which matched anywhere in the line — so an index entry whose prose referenced
 *  another memory ("supersedes (user-role.md)") was deleted when that other memory was
 *  next saved. Index lines are model-written prose about memories, so cross-references
 *  are expected content, and losing one silently removes a memory from the only listing
 *  that is always loaded. */
function pointsAt(line: string, file: string): boolean {
  return new RegExp(`^\\s*-\\s*\\[[^\\]]*\\]\\(${escapeRegExp(file)}\\)`).test(line);
}

/** Whether `index` already lists `file`. */
export function indexLists(index: string, file: string): boolean {
  return index.split("\n").some((l) => pointsAt(l, file));
}

/** Add or replace the pointer line for `file` in an index's text (pure). */
export function applyIndexUpsert(current: string, file: string, line: string): string {
  if (!current.trim()) return `# Memory Index\n\n${line}\n`;
  const kept = current
    .split("\n")
    .filter((l) => !pointsAt(l, file))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return `${kept}\n${line}\n`;
}

/** How many times to re-attempt a write the filesystem refused. Bounded so two
 *  instances colliding cannot spin. */
const INDEX_WRITE_ATTEMPTS = 4;

/**
 * Add or replace the index line that points at `file`, keeping MEMORY.md a flat list.
 *
 * Read, edit, write — which is a lost update waiting to happen, and the consequence is
 * out of proportion to the window. Two instances saving at once both read the same
 * index, and the second write drops the first one's line. The topic FILE survives, so
 * nothing looks broken, but MEMORY.md is the only listing that is ever loaded and
 * nothing rebuilds it: that memory is invisible from then on, permanently.
 *
 * So the write is verified rather than assumed. After writing we re-read and check our
 * own pointer is actually there; if another writer landed on top of us, we re-read
 * their content, re-apply our line to it, and write again. Each attempt starts from
 * whatever is on disk NOW, so the two writers converge on an index containing both
 * lines instead of racing to overwrite each other.
 *
 * Atomic writes (which this already uses) solve a different problem — they stop a
 * reader seeing a half-written file. They cannot help here, because both writes are
 * individually complete and simply describe different pasts.
 */
async function upsertIndexLine(dir: string, file: string, line: string): Promise<void> {
  return serializeIndexWrite(() => upsertIndexLineNow(dir, file, line));
}

/**
 * Index edits from THIS process, one at a time.
 *
 * Two writers need two different answers and this is the half that can be made
 * airtight. Inside one instance the collisions are ordinary: the engine runs
 * concurrency-safe tools in parallel, so several `save_memory` calls can be in flight
 * together. Read-modify-write under that loses lines, and no amount of retrying fixes
 * it — measured at twelve concurrent saves, ten were lost, because every writer retried
 * in step with the others and collided again.
 *
 * Serialising removes the race rather than narrowing it: each edit reads an index that
 * already contains every edit before it. It also removes the Windows EPERM this
 * uncovered, where several overlapping atomic writes fought over renaming onto the same
 * destination.
 *
 * Cross-PROCESS contention (a second Mindweave open on the same project) is out of
 * reach of a queue, and that is what the verify-and-retry below is for. The two are
 * complementary, not alternatives.
 */
let indexWrites: Promise<unknown> = Promise.resolve();
function serializeIndexWrite<T>(run: () => Promise<T>): Promise<T> {
  // Chained off settled OR failed, so one failing write cannot wedge the queue for the
  // rest of the session.
  const next = indexWrites.then(run, run);
  indexWrites = next.catch(() => undefined);
  return next;
}

async function upsertIndexLineNow(dir: string, file: string, line: string): Promise<void> {
  const indexPath = join(dir, MEMORY_INDEX);
  const read = async (): Promise<string> => {
    try {
      return await fs.readFile(indexPath, "utf8");
    } catch {
      return ""; // no index yet
    }
  };

  // Retried only for a FAILED write, never to win a race. Windows refuses a rename
  // while another process holds the destination, so two instances landing together
  // produce EPERM; starting over from whatever is on disk now clears it.
  //
  // There is deliberately no "did my line survive" check here. One was written, and
  // measured: across two processes it still lost 3 of 12, because both sides retry into
  // each other. Convergence by retrying is a guess about budgets, and the reconcile on
  // read makes a dropped line recoverable without guessing anything.
  for (let attempt = 1; attempt <= INDEX_WRITE_ATTEMPTS; attempt++) {
    try {
      await writeFileAtomic(indexPath, applyIndexUpsert(await read(), file, line));
      return;
    } catch (error) {
      if (attempt === INDEX_WRITE_ATTEMPTS) throw error;
      await settle(attempt);
    }
  }
}

/**
 * A short, jittered pause between attempts.
 *
 * Correctness comes from re-reading and re-checking, not from this: with no pause the
 * loop is still right, it just collides again immediately. The jitter is what stops two
 * instances retrying in lockstep forever, which is the one way a bounded retry can burn
 * its whole budget without either side making progress.
 */
function settle(attempt: number): Promise<void> {
  const ms = Math.round(15 * attempt * (0.5 + Math.random()));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A filesystem-safe slug from a memory name. Falls back to "memory" if empty. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "memory"
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
