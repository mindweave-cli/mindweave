/**
 * trustStore.ts — where tool fingerprints live between sessions.
 *
 * Kept in the project's governor state dir, alongside `forbidden.md` and
 * `forbidden-commands.md`, because this is the same kind of thing: a persisted decision
 * about what this project is allowed to do, owned by the user rather than the model.
 *
 * Per PROJECT, not global. The same server can legitimately be a different build in two
 * checkouts, and a global record would make an ordinary version difference look like a
 * rug pull in every other project.
 *
 * Failure is always "no record": a missing or corrupt file means every tool reads as
 * fresh. That is the safe direction for availability (MCP keeps working) and the honest
 * one for security (we do not claim to have verified something we could not read).
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir } from "../memory/store.js";
import { writeFileAtomic } from "../tools/atomicWrite.js";
import type { TrustRecord } from "./trust.js";

const FILE = "mcp-trust.json";

export function trustPath(cwd: string): string {
  return join(projectDir(cwd), FILE);
}

/** Load the fingerprint record for a project. `{}` when absent or unreadable. */
export async function loadTrust(cwd: string): Promise<TrustRecord> {
  try {
    const raw = await fs.readFile(trustPath(cwd), "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    // Drop anything that is not a string→string pair rather than trusting the shape.
    const out: TrustRecord = {};
    for (const [name, hash] of Object.entries(data as Record<string, unknown>)) {
      if (typeof hash === "string" && hash) out[name] = hash;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the fingerprint record. Best-effort: a failed write must not break MCP. */
export async function saveTrust(cwd: string, record: TrustRecord): Promise<boolean> {
  try {
    await fs.mkdir(projectDir(cwd), { recursive: true });
    // Sorted keys so the file diffs cleanly in git and a review shows what moved.
    const sorted = Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
    // Atomic: a torn file reads as "no record", and then every tool, a changed one included, is trusted as new.
    await writeFileAtomic(trustPath(cwd), JSON.stringify(sorted, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}
