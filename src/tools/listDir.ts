/**
 * listDir.ts — list the entries of one directory.
 *
 * The quickest way for the model to get its bearings: what's in this folder?
 * Read-only, single level (use glob for a recursive search). Directories are
 * marked with a trailing slash so the model can tell them from files at a glance.
 */
import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { isMultiRoot, relativize, searchUnits, type SearchUnit } from "./paths.js";
import { DEFAULT_IGNORES } from "./walk.js";
import { fail } from "./results.js";

/** Entries shown per directory before the list is cut short (the cut is always
 *  announced). Exported so the number in the description is pinned to the real value. */
export const MAX_ENTRIES = 400;

export const listDir: Tool = {
  name: "list_dir",
  readOnly: true,
  // The trailing-slash promise was the whole reading key and it was silently wrong on
  // symlinked directories, so the marks each get spelled out now. The paragraph about
  // seeing more than a search does is the one that earns its place: this is the only
  // tool that reports the disk as it is, so it is where the model finds out that a
  // file it cannot grep for, or cannot read at all, nevertheless exists.
  description:
    "List the immediate contents of a directory: one level, not recursive. Use glob to " +
    "match paths recursively, and grep to search inside files. Given no path it lists " +
    "every session root.\n" +
    "HOW TO READ IT: entries come directories first, then alphabetically. A trailing " +
    "slash means a directory. `(symlink)` means the entry is a link, and it still gets " +
    "the slash when it points at a directory; `(broken symlink)` means the target is " +
    "gone. `(skipped by search)` marks a directory that is really there but that glob " +
    "and grep will not descend into, which is why a file inside it can exist and still " +
    `never appear in a search. Long listings stop after ${MAX_ENTRIES} entries and say ` +
    "how many were left out.\n" +
    "This reports the DISK, not the searchable tree, so it shows more than the search " +
    "tools do: secrets, other agents' folders, and ignored build output all appear " +
    "here. Seeing something listed is therefore not a promise you may open it — " +
    "read_file still refuses secrets, and asks before another agent's data. Treat a " +
    "listing as evidence of what exists, and let the read decide what you may see.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Directory (or a root's label) to list. Defaults to every session root.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const units = searchUnits(ctx, rawPath);
    const multi = isMultiRoot(ctx) && !rawPath; // group with headers when sweeping roots

    const blocks: string[] = [];
    let total = 0;
    for (const unit of units) {
      const dir = unit.sub ? join(unit.root, unit.sub) : unit.root;
      const listed = await listOne(ctx, dir, unit);
      if (!listed) {
        if (rawPath) return fail(await whyUnreadable(dir, rawPath));
        continue;
      }
      total += listed.count;
      blocks.push(multi ? `${relativize(ctx, dir)}/\n${indent(listed.body)}` : listed.body);
    }

    if (blocks.length === 0) return fail(`directory not found: ${rawPath ?? "."}`);
    return {
      output: blocks.join("\n\n"),
      summary: `list ${units.length > 1 ? `${units.length} roots` : relativize(ctx, units[0]!.sub ? join(units[0]!.root, units[0]!.sub) : units[0]!.root)} (${total} item${total === 1 ? "" : "s"})`,
    };
  },
};

/**
 * What an entry actually IS, following symlinks.
 *
 * `readdir` reports a symlink as a symlink and nothing else: for a junction or
 * symlink pointing at a directory, `isDirectory()` and `isFile()` are BOTH false
 * (measured, not assumed). So the trailing slash this tool promises never appeared
 * on a linked directory and it read as an ordinary file — which matters most exactly
 * where links are common, in node_modules/.bin and in a linked monorepo package.
 * Only symlinks cost an extra stat, and a broken one is reported rather than thrown.
 */
async function classify(dir: string, e: Dirent): Promise<{ isDir: boolean; note: string }> {
  if (!e.isSymbolicLink()) return { isDir: e.isDirectory(), note: "" };
  try {
    const st = await fs.stat(join(dir, e.name)); // follows the link
    return { isDir: st.isDirectory(), note: "  (symlink)" };
  } catch {
    return { isDir: false, note: "  (broken symlink)" };
  }
}

/** List one directory's immediate entries (dirs first), or null if unreadable. */
async function listOne(ctx: ToolContext, dir: string, _unit: SearchUnit): Promise<{ body: string; count: number } | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const resolved = await Promise.all(
    entries.map(async (e) => ({ name: e.name, ...(await classify(dir, e)) })),
  );
  resolved.sort((a, b) => {
    const ad = a.isDir ? 0 : 1;
    const bd = b.isDir ? 0 : 1;
    return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
  });

  if (resolved.length === 0) return { body: "(empty directory)", count: 0 };

  const truncated = resolved.length > MAX_ENTRIES;
  const shown = resolved.slice(0, MAX_ENTRIES).map((e) => {
    const noisy = e.isDir && DEFAULT_IGNORES.has(e.name);
    return `${e.name}${e.isDir ? "/" : ""}${e.note}${noisy ? "  (skipped by search)" : ""}`;
  });
  if (truncated) {
    shown.unshift(`Showing ${MAX_ENTRIES} of ${resolved.length} entries. The rest exist and are not shown.`);
    shown.push(`… (${resolved.length - MAX_ENTRIES} more)`);
  }
  return { body: shown.join("\n"), count: resolved.length };
}

/**
 * Say why a directory could not be listed instead of always claiming it is missing.
 *
 * `readdir` fails the same way for a path that does not exist, a path that is a FILE,
 * and a directory the OS will not open. Reporting all three as "directory not found"
 * sent the model looking for a file it had already found: pointing `list_dir` at a
 * real file answered as though the file were not there.
 */
async function whyUnreadable(dir: string, shown: string): Promise<string> {
  try {
    const st = await fs.stat(dir);
    if (st.isDirectory()) return `cannot read directory (permission denied?): ${shown}`;
    return `not a directory, it is a file: ${shown} — use read_file to see its contents`;
  } catch {
    return `directory not found: ${shown}`;
  }
}

function indent(text: string): string {
  return text.split("\n").map((l) => `  ${l}`).join("\n");
}

