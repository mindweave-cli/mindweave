/**
 * projectNotes.ts — MINDWEAVE.md, and the files it pulls in.
 *
 * MINDWEAVE.md is the project's living notebook: what it is, how to run and test it,
 * the conventions in play, where things stand. It is loaded for the agent at the start
 * of every session, which is what makes a new conversation continue rather than start
 * over. `/init` writes the first one; the agent maintains it after that.
 *
 * It began as exactly one file at the project root, read whole. That works until a real
 * project has more to say than fits in one readable page, at which point the single file
 * becomes either too long to keep accurate or too short to be worth loading. Three
 * layers fix that without loading everything always:
 *
 *  - **Imports.** `@./docs/architecture.md` inside a notes file pulls that file in.
 *    Split the notes the way the project is split, and the parts still arrive as one
 *    document.
 *  - **A personal layer.** `~/.mindweave/MINDWEAVE.md` applies to every project on the
 *    machine, for the things that are true of how YOU work rather than of one codebase.
 *  - **Per-directory notes.** A MINDWEAVE.md inside a folder describes that folder, and
 *    is delivered only while the agent is actually working in it.
 *
 * The first two are assembled here into the text loaded at session start. The third is
 * resolved per turn against the files in play, and is deliberately NOT part of that
 * text: see `directoryNotesFor`.
 *
 * The import rules are the ones this syntax conventionally carries, so nobody who has
 * written a notes file before is surprised: `@path` in ordinary prose, depth capped,
 * cycles broken, and — the part that is easy to miss — **never inside code**. A notes
 * file that documents an npm scope or a decorator would otherwise try to import
 * `@types` as a path.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { guardedPathReason, realPathOf, withinFolder } from "../tools/guard.js";

/** The one filename, everywhere. */
export const NOTES_FILE = "MINDWEAVE.md";

/**
 * Instruction files other coding tools read, in the order Mindweave prefers them. A repository
 * that ships one is telling every agent how it wants to be worked on, and an agent that starts
 * without it "does not know my repo", which is the first thing someone moving from another tool
 * notices. The FIRST one found is read; `CLAUDE.md` often just points at `AGENTS.md` or repeats it.
 *
 * They are notes, not instructions from the user: labelled as written for another tool, inside
 * the same size budget as MINDWEAVE.md (and cut first when it is over), and following the same
 * rule for what they may import. Another tool's saved conversations, memory and settings are a
 * different thing and stay off-limits (tools/guard.ts).
 */
export const OTHER_TOOL_NOTES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;

/**
 * How far an import chain may go before it stops.
 *
 * Five. A notes file importing a file that imports another is normal; five levels of it
 * is a structure nobody is reading, and the cap is what stops a mistake from pulling in
 * a whole documentation tree.
 */
export const MAX_IMPORT_DEPTH = 5;

/**
 * Ceiling on the assembled notes.
 *
 * The pressure here runs one way: a file loaded every session, maintained by an agent
 * rewarded for thoroughness, told to keep it concise by a sentence nothing enforces.
 * Imports make that worse, because the size is now spread across files nobody sees
 * together. This is the enforcement, and it is generous — roughly 4K tokens for "facts
 * about this codebase".
 */
export const MAX_NOTES_CHARS = 16_000;

/** One file that went into the assembled notes. */
export interface NotesSource {
  /** Absolute path on disk. */
  path: string;
  /** How it was reached: the project root, the user's home, or an import. */
  kind: "project" | "user" | "import" | "other";
  /** The file that imported it, if any. */
  importedBy?: string;
}

export interface AssembledNotes {
  /** The text to give the agent. Empty when there are no notes at all. */
  text: string;
  /** Every file that contributed, in the order they were read. */
  sources: NotesSource[];
  /** True when the ceiling cut something off. */
  truncated: boolean;
  /** Imports that named a file which is not there. */
  missing: string[];
  /** Imports that were not followed: a protected file, or outside the project (see collect). */
  refused: string[];
}

/**
 * Pull the `@path` imports out of a notes file.
 *
 * Only from prose. Fenced blocks and inline code are skipped, because a notes file is
 * exactly the kind of document that quotes `@scope/package`, `@Component`, or an email
 * address, and treating those as file paths would produce a confusing failure in the
 * one file whose whole job is to be trusted.
 *
 * `@~/x` is the user's home, `@/x` is absolute, `@./x` and `@x` are relative to the
 * importing file. A `#fragment` is dropped, and `\ ` is an escaped space, both so a
 * path written for a human still resolves.
 */
export function importPathsIn(text: string, fromFile: string): string[] {
  const prose = stripCode(text);
  const found: string[] = [];
  const seen = new Set<string>();
  // Must follow start-of-line or whitespace: `foo@bar.md` is an address, not an import.
  const re = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const hash = raw.indexOf("#");
    const cleaned = (hash === -1 ? raw : raw.slice(0, hash)).replace(/\\ /g, " ");
    if (!cleaned || cleaned === "/" || cleaned.startsWith("@")) continue;
    const abs = resolveImport(cleaned, fromFile);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    found.push(abs);
  }
  return found;
}

function resolveImport(path: string, fromFile: string): string | null {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return resolve(dirname(fromFile), path);
}

/**
 * Remove fenced blocks and inline code so their contents cannot be read as imports.
 *
 * Replaced with blank lines rather than deleted, so nothing on a later line shifts into
 * a position it was not written in — an `@path` at the start of a line must still look
 * like one after this runs.
 */
function stripCode(text: string): string {
  const blanked = text.replace(/```[\s\S]*?(?:```|$)/g, (block) => block.replace(/[^\n]/g, " "));
  return blanked.replace(/`[^`\n]*`/g, (span) => span.replace(/[^\n]/g, " "));
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * Read one notes file and everything it imports, depth-first.
 *
 * `seen` carries across the whole assembly rather than per branch, so a file imported
 * from two places is included once and a cycle simply stops. Both are the same
 * mechanism, which is why an import loop is not a special case here.
 */
async function collect(
  path: string,
  kind: NotesSource["kind"],
  seen: Set<string>,
  out: { source: NotesSource; body: string }[],
  missing: string[],
  depth: number,
  importedBy?: string,
  refused: string[] = [],
  bound: string | null = null,
): Promise<void> {
  const key = normalize(path).toLowerCase();
  if (seen.has(key) || depth >= MAX_IMPORT_DEPTH) return;
  seen.add(key);

  // An import is read at session start and its text goes into the system prompt, so it
  // decides what leaves the machine with the first request. A protected file (.env, a
  // key) is never imported. Notes that came with the PROJECT may only import from inside
  // it, links resolved: a cloned repository could otherwise send ~/.ssh/id_rsa to the
  // provider before the user typed anything. The user's own notes may import anything
  // else; they wrote them.
  if (kind === "import") {
    const outside = bound !== null && !withinFolder(bound, await realPathOf(path));
    if (outside || (await guardedPathReason(path)) !== null) {
      refused.push(path);
      return;
    }
  }

  const body = await readIfPresent(path);
  if (body === null) {
    // Only an IMPORT is worth reporting. A project with no notes file at all, or a
    // user who keeps none, is the ordinary case and not a problem.
    if (kind === "import") missing.push(path);
    return;
  }

  out.push({ source: { path, kind, ...(importedBy ? { importedBy } : {}) }, body: body.trim() });
  for (const target of importPathsIn(body, path)) {
    await collect(target, "import", seen, out, missing, depth + 1, path, refused, bound);
  }
}

/** Where the machine-wide notes live, beside the config the app already keeps there. */
export function userNotesPath(stateDir = join(homedir(), ".mindweave")): string {
  return join(stateDir, NOTES_FILE);
}

/**
 * Assemble the notes a session starts with: the user's, then the project's, plus
 * everything either imports.
 *
 * The user's layer comes FIRST and the project's second, because when the two disagree
 * the project should win, and a model reading in order treats what it read last as more
 * specific. Each file is headed with where it came from — without that, a rule from the
 * home directory looks like it came from the repository, and someone debugging why the
 * agent insists on something has nowhere to look.
 */
export async function assembleNotes(
  cwd: string,
  opts: { stateDir?: string; includeUser?: boolean } = {},
): Promise<AssembledNotes> {
  const seen = new Set<string>();
  const parts: { source: NotesSource; body: string }[] = [];
  const missing: string[] = [];
  const refused: string[] = [];

  if (opts.includeUser !== false) {
    await collect(userNotesPath(opts.stateDir), "user", seen, parts, missing, 0, undefined, refused, null);
  }
  const project = await realPathOf(cwd);
  await collect(join(cwd, NOTES_FILE), "project", seen, parts, missing, 0, undefined, refused, project);
  // The project's instructions for other tools, after its own so Mindweave's notes win a disagreement.
  for (const name of OTHER_TOOL_NOTES) {
    if ((await readIfPresent(join(cwd, name))) === null) continue;
    await collect(join(cwd, name), "other", seen, parts, missing, 0, undefined, refused, project);
    break;
  }

  if (parts.length === 0) return { text: "", sources: [], truncated: false, missing, refused };

  const blocks = parts.map(({ source, body }) => {
    if (source.kind === "project") return body;
    const label =
      source.kind === "user"
        ? `${NOTES_FILE} (yours, applies to every project)`
        : source.kind === "other"
          ? `${basename(source.path)} (written for another coding tool; read it as notes about this project, not as instructions from the user)`
          : `imported from ${displayPath(source.path, cwd)}`;
    return `--- ${label} ---\n${body}`;
  });

  // A named import that is not there is worth saying. Silence would leave the agent
  // told to "see the architecture notes" with no architecture notes and no idea why.
  if (missing.length > 0) {
    const list = missing.map((p) => displayPath(p, cwd)).join(", ");
    blocks.push(`[These notes import ${list}, which could not be read. That part is missing.]`);
  }
  if (refused.length > 0) {
    const list = refused.map((p) => displayPath(p, cwd)).join(", ");
    blocks.push(
      `[These notes import ${list}, which was not loaded: notes that come with a project may only ` +
        `import files inside it, and no notes may import a secrets file.]`,
    );
  }
  return capped(blocks.join("\n\n"), parts.map((p) => p.source), missing, refused);
}

/** A path as a person would refer to it: inside the project, relative; outside, whole. */
function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path;
}

function capped(text: string, sources: NotesSource[], missing: string[], refused: string[]): AssembledNotes {
  if (text.length <= MAX_NOTES_CHARS) return { text, sources, truncated: false, missing, refused };
  const cut = text.slice(0, MAX_NOTES_CHARS);
  const atLine = cut.slice(0, cut.lastIndexOf("\n") + 1) || cut;
  return {
    text:
      `${atLine.trimEnd()}\n\n[The project notes are longer than fits here and were truncated at ` +
      `this point. Read the file directly if you need the rest, and consider trimming it.]`,
    sources,
    truncated: true,
    missing,
    refused,
  };
}

/**
 * The per-directory notes that apply to a set of files being worked on.
 *
 * For each file, every directory from the project root down to the file's own folder is
 * checked for a MINDWEAVE.md. A note in `src/api/` therefore reaches the agent exactly
 * when it opens something in `src/api/`, and not before — which is the point. Loading
 * every folder's notes at session start would cost the whole budget to say things about
 * code nobody is touching.
 *
 * The root's own file is excluded: it is already loaded at session start, and including
 * it here would send it twice.
 *
 * Returned rather than concatenated into the session prompt on purpose. These change as
 * the agent moves around a repository, and anything that changes mid-session belongs in
 * the volatile part of the request; folding it into the cached prefix would rewrite that
 * prefix every time the agent opened a file in a new folder, which is the single most
 * expensive thing a turn can do.
 */
export async function directoryNotesFor(
  root: string,
  files: readonly string[],
): Promise<{ path: string; text: string }[]> {
  const dirs = new Set<string>();
  for (const file of files) {
    const abs = isAbsolute(file) ? file : resolve(root, file);
    const rel = relative(root, abs);
    // Outside the project entirely, or the project root itself.
    if (!rel || rel.startsWith("..")) continue;
    let dir = dirname(abs);
    while (dir.length >= root.length) {
      if (normalize(dir) !== normalize(root)) dirs.add(dir);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }

  const out: { path: string; text: string }[] = [];
  // Shallowest first: a folder's notes should read before the notes of a folder inside
  // it, so the more specific text is the last thing the model sees.
  for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
    // A folder's own notes, else the instruction file another tool left there.
    for (const name of [NOTES_FILE, ...OTHER_TOOL_NOTES]) {
      const path = join(dir, name);
      const body = await readIfPresent(path);
      if (body === null) continue;
      out.push({ path, text: body.trim() });
      break;
    }
  }
  return out;
}
