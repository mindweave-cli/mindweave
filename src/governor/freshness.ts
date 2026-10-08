/**
 * freshness.ts — noticing that the user edited their governance by hand.
 *
 * Rules, skills and the forbidden lists are files. The model writes them through tools,
 * but a person editing `rules/use-pnpm.md` in their editor is at least as likely, and
 * that edit used to do nothing at all until the session was restarted — silently, with
 * the old rule still being enforced and nothing on screen to say so.
 *
 * Freshness is kept two different ways, and both are here because they answer
 * different failure modes:
 *
 *   1. STAT FRESHNESS. A watched config is re-read when
 *      mtime moves, guarded so their own writes do not cause a re-read and so a
 *      concurrent write-through is never regressed to a stale snapshot. `stamp()` below
 *      is the same signal (mtime + size), sampled once per turn rather than by a
 *      persistent watcher: governance is only ever consulted while building a request,
 *      so checking it when it is used costs one stat pass and needs no watcher
 *      lifecycle, no polling thread, and no cleanup on exit.
 *
 *   2. LIFECYCLE INVALIDATION. A memoized snapshot has to be dropped at the moments that
 *      rebuild everything around it: starting a fresh conversation, and after a compaction.
 *      A compaction rebuilds the prompt from scratch, so it is the natural point to also
 *      rebuild what the prompt is made of. The engine forces a reload there.
 *
 * The stamp deliberately covers presence as well as content: a rule DELETED from disk
 * has to stop applying, and a stamp built only from surviving files would miss it.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir, stateRoot } from "../memory/store.js";

/** The files and directories a project's governance is read from. */
const FORBIDDEN_FILES = ["forbidden.md", "forbidden-commands.md", "forbidden-mcp-tools.md", "sentinel-allow.md", "command-rules.md", "context.json"];

/** One directory's entries as `name:mtime:size`, sorted so the stamp is order-stable. */
async function dirStamp(dir: string, depth: number): Promise<string> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).sort();
  } catch {
    return `${dir}:-`; // absent is a state too — creating the first rule must register
  }
  const parts: string[] = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = await fs.stat(full);
      // Skills are a directory each (SKILL.md plus bundled files), so one level of
      // recursion is what makes editing a skill body count as a change.
      if (st.isDirectory() && depth > 0) parts.push(`${name}/(${await dirStamp(full, depth - 1)})`);
      else parts.push(`${name}:${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push(`${name}:?`);
    }
  }
  return parts.join(",");
}

/**
 * A cheap fingerprint of everything `loadGovernance` reads.
 *
 * Compared as an opaque string: any difference means reload, and the cost of a false
 * positive is one directory read, so it errs towards reloading.
 */
export async function governanceStamp(cwd: string): Promise<string> {
  const stateDir = projectDir(cwd);
  const [rules, skills, globalRules, globalSkills, ...files] = await Promise.all([
    dirStamp(join(stateDir, "rules"), 0),
    dirStamp(join(stateDir, "skills"), 1),
    dirStamp(join(stateRoot(), "rules"), 0),
    dirStamp(join(stateRoot(), "skills"), 1),
    // Both scopes: an edit to a universal list must reach sessions already running.
    ...[stateDir, stateRoot()].flatMap((dir) =>
      FORBIDDEN_FILES.map(async (name) => {
        try {
          const st = await fs.stat(join(dir, name));
          return `${name}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${name}:-`;
        }
      }),
    ),
  ]);
  return `r[${rules}] s[${skills}] gr[${globalRules}] gs[${globalSkills}] f[${files.join("|")}]`;
}
