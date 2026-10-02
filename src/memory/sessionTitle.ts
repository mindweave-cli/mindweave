/**
 * sessionTitle.ts — a session's name, from the notes it already keeps.
 *
 * The session notes (sessionMemory.ts) open with a "Session Title" section the model
 * fills in as part of the update it already makes. Lists named a session by its first
 * message instead ("hi hi"), which says nothing about the work. Reading the title back
 * out costs nothing: no call of its own, just the notes that are already on disk.
 */

/** The title the notes give the session, or undefined while they give none. */
export function sessionTitle(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  const lines = notes.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#\s+Session Title\s*$/i.test(l.trim()));
  if (at < 0) return undefined;
  for (const raw of lines.slice(at + 1)) {
    const line = raw.trim();
    if (line.startsWith("#")) return undefined; // the next section: no title written yet
    // Blank lines, and the template's own instruction under the heading. Only that one
    // line: a model may write the title itself in the same italics.
    if (!line || /^_A short and distinctive .*title for the session/i.test(line)) continue;
    return shortTitle(line.replace(/^[*_`"]+|[*_`"]+$/g, ""));
  }
  return undefined;
}

const TITLE_MAX = 48;

/**
 * A title short enough to name a session in a list. Notes written before the template
 * asked for a few words ran long ("Menteus monorepo: building events package (EventBus
 * + EventStream) atop designed skeleton"): the bracketed detail goes, a leading
 * "project: " goes when what follows says enough (the project is already on screen),
 * and what is still too long is cut at a word.
 */
function shortTitle(raw: string): string | undefined {
  let t = raw.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const colon = t.indexOf(": ");
  if (colon > 0 && colon < 40 && t.slice(colon + 2).split(" ").length >= 2) t = t.slice(colon + 2);
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX - 1);
    const space = cut.lastIndexOf(" ");
    t = `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
  }
  return t || undefined;
}
