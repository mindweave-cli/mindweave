/**
 * whatsNew.ts — the short "what changed" list shown once after Mindweave starts on a new version.
 *
 * The words come from CHANGELOG.md, which is not in the npm package. So `scripts/makeWhatsNew.mjs` cuts the
 * section for the version being packed into `dist/whatsnew.json` (run by `prepack`), and the copy that
 * arrives reads that file from its own folder. A version with no section ships no file and shows nothing.
 *
 * Shown once: the last version this machine showed is kept in `<state>/seen-version.json`. A first-ever
 * start only records the version, since someone who just installed has nothing to compare with.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNewer, managedStateRoot } from "./launcher.js";

export interface WhatsNew {
  version: string;
  /** The release headline, e.g. "the agent tells you what it built". */
  title: string;
  groups: { heading: string; items: string[] }[];
}

const MAX_GROUPS = 3;
const MAX_ITEMS_PER_GROUP = 3;
const MAX_ITEM_CHARS = 90;

/** One bullet as a short line: its bold lead when it has one, else its first sentence. */
export function shortItem(bullet: string): string {
  const text = bullet.replace(/^[-*]\s+/, "").trim();
  const bold = /^\*\*(.+?)\*\*/.exec(text);
  let s = bold ? bold[1]! : text.split(/(?<=[.!?])\s/)[0]!;
  s = s.replace(/`/g, "").replace(/\*\*/g, "").replace(/[.:]\s*$/, "").trim();
  return s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS - 1).trimEnd() + "…" : s;
}

/**
 * The section of a changelog for `version` as a short list (pure), or null when there is none.
 * A heading counts when it starts `## v<version>` (a release) — an `Unreleased` section is not a release.
 */
export function parseWhatsNew(changelog: string, version: string): WhatsNew | null {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+v${version.replace(/\./g, "\\.")}(\\s|:|$)`).test(l));
  if (start < 0) return null;
  const heading = lines[start]!;
  const title = (/^##\s+\S+(?:\s+\([^)]*\))?\s*:\s*(.+)$/.exec(heading)?.[1] ?? "").trim();
  const groups: WhatsNew["groups"] = [];
  let current: WhatsNew["groups"][number] | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s/.test(line)) break;
    const h = /^###\s+(.+)$/.exec(line);
    if (h) {
      current = { heading: h[1]!.trim(), items: [] };
      groups.push(current);
      continue;
    }
    if (current && /^[-*]\s+/.test(line)) {
      const item = shortItem(line);
      if (item) current.items.push(item);
    }
  }
  const kept = groups.filter((g) => g.items.length > 0).slice(0, MAX_GROUPS);
  for (const g of kept) g.items = g.items.slice(0, MAX_ITEMS_PER_GROUP);
  if (kept.length === 0) return null;
  return { version, title, groups: kept };
}

/** The list as the lines shown in the chat (pure). */
export function formatWhatsNew(n: WhatsNew): string {
  const out = [n.title ? `What's new in v${n.version}: ${n.title}` : `What's new in v${n.version}`];
  for (const g of n.groups) {
    out.push("", g.heading);
    for (const item of g.items) out.push(`  · ${item}`);
  }
  return out.join("\n");
}

/** The notes that shipped inside this copy, if any. */
export function readShippedNotes(packageRoot: string): WhatsNew | null {
  try {
    const raw = JSON.parse(readFileSync(join(packageRoot, "dist", "whatsnew.json"), "utf8")) as Partial<WhatsNew>;
    if (typeof raw.version !== "string" || !Array.isArray(raw.groups)) return null;
    const groups = raw.groups
      .filter((g) => g && typeof g.heading === "string" && Array.isArray(g.items))
      .map((g) => ({ heading: g.heading, items: g.items.filter((x): x is string => typeof x === "string") }));
    return { version: raw.version, title: typeof raw.title === "string" ? raw.title : "", groups };
  } catch {
    return null;
  }
}

function seenPath(root: string): string {
  return join(root, "seen-version.json");
}

/**
 * Record that `current` is now the version in use, and say what to show for it: the list when this start is on a
 * newer version than the last one seen, null on the first start ever and on every start after. Never throws.
 */
export function takeWhatsNew(current: string, packageRoot: string, root = managedStateRoot()): { updated: boolean; notes: WhatsNew | null } {
  let seen: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(seenPath(root), "utf8")) as { version?: unknown };
    if (typeof raw.version === "string") seen = raw.version;
  } catch {
    seen = null;
  }
  if (seen === current) return { updated: false, notes: null };
  try {
    mkdirSync(root, { recursive: true });
    const tmp = `${seenPath(root)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: current }));
    renameSync(tmp, seenPath(root));
  } catch {
    // Not recorded: it will be shown again next start, which is better than never.
  }
  if (seen === null || !isNewer(current, seen)) return { updated: false, notes: null };
  const shipped = readShippedNotes(packageRoot);
  return { updated: true, notes: shipped && shipped.version === current ? shipped : null };
}

/** Is there a notes file next to this copy (for the packaging check). */
export function hasShippedNotes(packageRoot: string): boolean {
  return existsSync(join(packageRoot, "dist", "whatsnew.json"));
}
