/**
 * missingPath.ts — what to say when a file the model asked for is not there.
 *
 * "File not found: src/util.ts" leaves the model to guess again, and the usual cause is not that the file does not exist
 * but that it is one folder over, spelled with another case, or a letter off. A read that fails already knows the folder it
 * was looking in, so it can name what is actually there: a near name beside it, the same name elsewhere in the project, or
 * the nearest folder that does exist. Only on a failed read, so it costs nothing otherwise.
 */
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ToolContext } from "./types.js";
import { relativize } from "./paths.js";
import { excludedFromSearch } from "./guard.js";
import { walkFiles } from "./walk.js";

/** How many paths a hint names. */
const MAX_NAMED = 3;
/** Files looked through for the same name elsewhere. */
const WALK_LIMIT = 5000;

/** The number of single-character edits between two strings (pure). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Entries of `names` close to `wanted`: the same name in another case, or a few characters off. Pure. */
export function nearNames(wanted: string, names: readonly string[]): string[] {
  const w = wanted.toLowerCase();
  const slack = Math.max(2, Math.floor(w.length / 4));
  return names
    .map((n) => ({ n, d: editDistance(w, n.toLowerCase()) }))
    .filter(({ d }) => d <= slack)
    .sort((x, y) => x.d - y.d || x.n.localeCompare(y.n))
    .slice(0, MAX_NAMED)
    .map((x) => x.n);
}

/** The nearest ancestor of `path` that exists, or null. */
async function nearestExisting(path: string): Promise<string | null> {
  let dir = dirname(path);
  for (;;) {
    try {
      if ((await fs.stat(dir)).isDirectory()) return dir;
    } catch {
      /* keep climbing */
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * A sentence or two naming where the file may really be, or "" when nothing useful is known. Never throws: it runs
 * inside an error path and must not replace the error with another one.
 */
export async function missingFileHint(ctx: ToolContext, absPath: string): Promise<string> {
  try {
    const hints: string[] = [];
    const wanted = basename(absPath);
    const parent = await nearestExisting(absPath);
    if (parent && parent === dirname(absPath)) {
      const near = nearNames(wanted, await fs.readdir(parent));
      if (near.length) hints.push(`Similar names in ${relativize(ctx, parent)}/: ${near.join(", ")}.`);
    } else if (parent) {
      hints.push(`The folder ${relativize(ctx, dirname(absPath))}/ does not exist; the nearest folder that does is ${relativize(ctx, parent)}/.`);
    }
    const { files } = await walkFiles(ctx.cwd, WALK_LIMIT);
    const same = files
      .filter((f) => basename(f.abs).toLowerCase() === wanted.toLowerCase() && f.abs !== absPath && !excludedFromSearch(f.abs))
      .slice(0, MAX_NAMED)
      .map((f) => relativize(ctx, f.abs));
    if (same.length) hints.push(`A file with that name exists at: ${same.join(", ")}.`);
    return hints.join(" ");
  } catch {
    return "";
  }
}
