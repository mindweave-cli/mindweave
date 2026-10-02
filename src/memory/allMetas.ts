/**
 * allMetas.ts — every saved session's metadata, from every project this machine has state for.
 *
 * One reader for the two things that need the whole picture rather than one session: the
 * Spend view (what has been used) and usage limits (what is left of a window). Both only read.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./store.js";
import type { SessionMeta } from "./types.js";

async function readMetaFiles(dir: string): Promise<SessionMeta[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const reads = names
    .filter((n) => n.endsWith(".meta.json"))
    .map(async (name) => {
      try {
        return JSON.parse(await fs.readFile(join(dir, name), "utf8")) as SessionMeta;
      } catch {
        return null; // unreadable/corrupt — skip rather than fail the whole total
      }
    });
  return (await Promise.all(reads)).filter((m): m is SessionMeta => m !== null && m.entryCount > 0);
}

export interface CallRecord {
  at: number;
  model: string;
  hit: number;
  miss: number;
  out: number;
}

/**
 * Every call a session made, as far as it can be known.
 *
 * The per-call log keeps only the newest 200 calls of a session, so a long one has lost its
 * early calls from the log while its own running total still counts them. What the log no
 * longer holds is put back as one record at the moment its oldest kept call began: the exact
 * time is gone, but the amount is not, and a month's total must not shrink because a session
 * ran long. A session saved before the log existed is a single lump where it was last touched.
 */
export function callRecords(meta: SessionMeta): CallRecord[] {
  const calls: CallRecord[] = (meta.callLog ?? []).map((c) => ({ at: c.at, model: c.model, hit: c.hit, miss: c.miss, out: c.out }));
  if (calls.length === 0) {
    if (!meta.spend) return [];
    const out = meta.spend.output;
    return [{ at: meta.updatedAt, model: meta.model ?? "unknown", hit: 0, miss: Math.max(0, meta.spend.billed - out), out }];
  }
  const loggedOut = calls.reduce((s, c) => s + c.out, 0);
  const loggedBilled = calls.reduce((s, c) => s + c.miss + c.out, 0);
  const lostBilled = (meta.spend?.billed ?? 0) - loggedBilled;
  if (lostBilled > 0) {
    const lostOut = Math.min(lostBilled, Math.max(0, (meta.spend?.output ?? 0) - loggedOut));
    calls.unshift({ at: calls[0]!.at, model: calls[0]!.model, hit: 0, miss: lostBilled - lostOut, out: lostOut });
  }
  return calls;
}

/** Every session's meta, from every project this machine has state for. */
export async function everyMeta(): Promise<SessionMeta[]> {
  const projectsDir = join(stateRoot(), "projects");
  let slugs: string[];
  try {
    slugs = await fs.readdir(projectsDir);
  } catch {
    return [];
  }
  const perProject = await Promise.all(slugs.map((slug) => readMetaFiles(join(projectsDir, slug))));
  return perProject.flat();
}
