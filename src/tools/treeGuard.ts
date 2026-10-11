/**
 * treeGuard.ts — did a run change the project's files, and which?
 *
 * A verifier is told it cannot change anything, and its edit and write tools are removed. But it
 * has a command tool now, because checking something means running it, and a command can write
 * a file by other means: a redirect, a formatter, a script, a build step that rewrites a source
 * file. "It cannot" is then a request, not a fact, and a verifier that can change the code it is
 * judging can make it pass. So the project's files are looked at before the run and again after.
 *
 * What counts is the project's own tree: the same files search sees, which leaves out version
 * control, installed packages, build output and whatever .gitignore excludes. A build that rewrites
 * `out/` is doing its job; a script that rewrites `src/` is not.
 *
 * It does not undo anything itself. Whoever changed a file between the two looks cannot be known:
 * the user may have been typing in their editor. So it reports, and it hands the files it holds a
 * "before" for to the undo net (checkpoints.ts), which already refuses to overwrite a file that is
 * no longer what we wrote.
 */
import { promises as fs } from "node:fs";
import { walkFiles } from "./walk.js";
import type { Checkpoints } from "./checkpoints.js";

/** Files looked at. A bigger tree is looked at in part, and says so. */
const MAX_FILES = 6000;
/** A file is held (so it can be put back) only up to this size, and only up to a total. */
const MAX_HELD_FILE_BYTES = 256 * 1024;
const MAX_HELD_TOTAL_BYTES = 24 * 1024 * 1024;

interface Entry {
  size: number;
  mtimeMs: number;
  /** The text, when it was small enough to hold and was text. Null otherwise. */
  content: string | null;
}

/** What the project's files looked like at one moment. */
export interface TreeSnapshot {
  root: string;
  files: Map<string, Entry>;
  /** The tree had more files than were looked at: a file past the limit is not covered. */
  truncated: boolean;
}

/** What changed between a snapshot and now. */
export interface TreeChanges {
  changed: string[];
  created: string[];
  deleted: string[];
  /** Files whose "before" is held, so the undo net can put them back. */
  heldBefore: Map<string, string | null>;
}

/** The text of a file when it is small and is valid UTF-8 text, or null (pure of the walk). */
async function readHeld(path: string, size: number, budget: { left: number }): Promise<string | null> {
  if (size > MAX_HELD_FILE_BYTES || size > budget.left) return null;
  try {
    const bytes = await fs.readFile(path);
    if (bytes.includes(0)) return null;
    const text = bytes.toString("utf8");
    // Bytes that are not UTF-8 would not come back the same; not held, rather than held wrongly.
    if (!Buffer.from(text, "utf8").equals(bytes)) return null;
    budget.left -= size;
    return text;
  } catch {
    return null;
  }
}

/** Look at the project's files now. Never throws: a file it cannot read is simply not covered. */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const files = new Map<string, Entry>();
  let found: Awaited<ReturnType<typeof walkFiles>>;
  try {
    found = await walkFiles(root, MAX_FILES);
  } catch {
    return { root, files, truncated: true };
  }
  const budget = { left: MAX_HELD_TOTAL_BYTES };
  for (const f of found.files) {
    try {
      const st = await fs.stat(f.abs);
      files.set(f.abs, { size: st.size, mtimeMs: st.mtimeMs, content: await readHeld(f.abs, st.size, budget) });
    } catch {
      // gone between the walk and the look: not covered
    }
  }
  return { root, files, truncated: found.truncated };
}

/** What changed since the snapshot (the files themselves are looked at again). */
export async function treeChanges(before: TreeSnapshot): Promise<TreeChanges> {
  const out: TreeChanges = { changed: [], created: [], deleted: [], heldBefore: new Map() };
  let found: Awaited<ReturnType<typeof walkFiles>>;
  try {
    found = await walkFiles(before.root, MAX_FILES);
  } catch {
    return out;
  }
  const now = new Set(found.files.map((f) => f.abs));
  for (const [abs, was] of before.files) {
    if (!now.has(abs)) {
      out.deleted.push(abs);
      out.heldBefore.set(abs, was.content);
      continue;
    }
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      out.deleted.push(abs);
      out.heldBefore.set(abs, was.content);
      continue;
    }
    // Same size and time is unchanged. A file touched but rewritten with the same text is not a change.
    if (st.size === was.size && st.mtimeMs === was.mtimeMs) continue;
    if (was.content !== null) {
      const budget = { left: MAX_HELD_FILE_BYTES };
      const text = await readHeld(abs, st.size, budget);
      if (text === was.content) continue;
    }
    out.changed.push(abs);
    out.heldBefore.set(abs, was.content);
  }
  // A new file can only be told from one past the limit when the whole tree was looked at.
  if (!before.truncated) {
    for (const abs of now) if (!before.files.has(abs)) out.created.push(abs);
  }
  out.changed.sort();
  out.created.sort();
  out.deleted.sort();
  return out;
}

/** How many files changed in all. */
export function changeCount(c: TreeChanges): number {
  return c.changed.length + c.created.length + c.deleted.length;
}

/**
 * Give the undo net what it needs to put these files back, where it can (see the header).
 * A created file is "was nothing"; a changed or deleted one is what the snapshot held. A file
 * whose "before" was too big to hold is left out, and the count says so.
 */
export async function giveToUndo(checkpoints: Checkpoints | undefined, c: TreeChanges): Promise<{ covered: number; notCovered: number }> {
  let covered = 0;
  let notCovered = 0;
  for (const abs of [...c.changed, ...c.deleted, ...c.created]) {
    const was = c.created.includes(abs) ? null : (c.heldBefore.get(abs) ?? undefined);
    if (was === undefined) {
      notCovered++;
      continue;
    }
    let now = "";
    if (!c.deleted.includes(abs)) {
      try {
        now = await fs.readFile(abs, "utf8");
      } catch {
        notCovered++;
        continue;
      }
    }
    if (!checkpoints) {
      notCovered++;
      continue;
    }
    checkpoints.backup(abs, was, now);
    covered++;
  }
  return { covered, notCovered };
}

/** The changed files, as names under the root, each marked when it is new or gone (pure). */
export function listChanges(root: string, c: TreeChanges): string[] {
  const rel = (p: string) => p.slice(root.length).replace(/^[\\/]+/, "").split("\\").join("/");
  return [...c.changed.map(rel), ...c.created.map((p) => `${rel(p)} (new)`), ...c.deleted.map((p) => `${rel(p)} (deleted)`)];
}

/** The files, as one line: a few and then a count (pure). */
export function nameChanges(root: string, c: TreeChanges, max = 4): string {
  const all = listChanges(root, c);
  const shown = all.slice(0, max).join(", ");
  return all.length > max ? `${shown} and ${all.length - max} more` : shown;
}
