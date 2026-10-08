/**
 * editRipple.ts — check what an edit BROKE, without waiting to be asked.
 *
 * The `diagnostics` tool exists and its description tells the model to call it after
 * editing. That is prose asking a model to remember, and the standing lesson in this
 * project is that a rule which keeps being ignored live should be moved to where it
 * executes instead of being rewritten. This is that move: after a step that edited
 * files, the check runs on its own and the result is handed to the model as a note.
 *
 * It also closes the hole the tool structurally cannot close, and says so in its own
 * description: diagnostics are PER FILE, so the one failure that matters most after an
 * edit — a renamed symbol, a changed signature, an altered exported type — never shows
 * up, because the broken file is the CALLER. So the target set is the edited files PLUS
 * their reverse dependents, from the import edges the code graph already holds.
 *
 * Two things it must never do, because both would be worse than not existing:
 *  - Report a clean result as proof. No language server, a slow server and an
 *    unreadable path all look identical to "no diagnostics", so silence is silence.
 *    Nothing is injected when nothing is found.
 *  - Cost more than it saves. It is capped, it only runs after a step that actually
 *    edited something, and it never blocks the turn on a slow server.
 */
import type { ToolContext } from "./types.js";
import type { CodeDiagnostic } from "../alternator/chassis/types.js";
import { chassisForPath } from "./chassisMux.js";
import { relativize } from "./paths.js";

/** Edited files checked per step. An edit touching more files than this is a sweeping
 *  refactor, where a per-file check is the wrong instrument anyway. */
export const MAX_EDITED = 8;
/** Reverse dependents pulled in on top. The point is to catch the broken caller, not to
 *  type-check the repo: a widely-imported file has hundreds and checking them all would
 *  cost more than the edit did. */
export const MAX_DEPENDENTS = 12;
/** Diagnostics quoted into the note. Past this the model needs to look, not read. */
export const MAX_REPORTED = 20;

/** Tools whose call means "a file's contents changed on disk". */
const EDITING_TOOLS = new Set(["edit", "multi_edit", "write_file", "create_file", "apply_patch"]);

/**
 * The absolute paths an executed round actually edited.
 *
 * Driven off the CALL rather than the result body, because that is the thing that is
 * true regardless of how a tool phrases success. A failed call is skipped: it changed
 * nothing, and checking it would report pre-existing errors as if the edit caused them.
 */
export function editedPaths(
  results: readonly { name: string; args?: Record<string, unknown>; isError?: boolean }[],
  resolve: (p: string) => string | undefined,
): string[] {
  const out = new Set<string>();
  for (const r of results) {
    if (r.isError || !EDITING_TOOLS.has(r.name)) continue;
    const raw = r.args?.path ?? r.args?.file_path;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const abs = resolve(raw.trim());
    if (abs) out.add(abs);
  }
  return [...out].slice(0, MAX_EDITED);
}

/**
 * Edited files plus their reverse dependents, deduped, edited-first.
 *
 * Edited-first is deliberate: if the cap bites, the files the model just touched are
 * the ones it must not lose. Dependents are the bonus that catches the broken caller.
 */
export async function rippleTargets(ctx: ToolContext, edited: readonly string[]): Promise<string[]> {
  const seen = new Set<string>(edited);
  const extra: string[] = [];
  for (const abs of edited) {
    const chassis = chassisForPath(ctx, abs);
    if (!chassis) continue;
    let deps: readonly string[] = [];
    try {
      deps = await chassis.dependents(abs);
    } catch {
      // The graph is an assistant, never a gate: if it cannot answer, the edited files
      // are still checked. A ripple failure must not cost the model its diagnostics.
      continue;
    }
    for (const d of deps) {
      if (seen.has(d) || extra.length >= MAX_DEPENDENTS) continue;
      seen.add(d);
      extra.push(d);
    }
  }
  return [...edited, ...extra];
}

/**
 * Render the note the model receives, or "" when there is nothing worth saying.
 *
 * Errors first, then warnings — a turn that produced one type error and nine lint
 * warnings should not bury the type error. `edited` is named separately so the model
 * can tell "you broke this file you just wrote" from "you broke a caller over there",
 * which are different problems with different fixes.
 */
export function formatRippleNote(
  diags: readonly CodeDiagnostic[],
  editedSet: ReadonlySet<string>,
  label: (abs: string) => string,
): string {
  // Compared case- and slash-insensitively on Windows: diagnostics arrive with forward
  // slashes and the edited paths with backslashes, so a plain comparison marked every
  // diagnostic, the edited file's included, as a caller's.
  const key = (p: string) => {
    const s = p.split("\\").join("/");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const edited = new Set([...editedSet].map(key));
  const isEdited = (d: CodeDiagnostic) => edited.has(key(d.file));
  // What is worth interrupting the model with: anything in a file it just edited, but only
  // ERRORS in a caller (a warning over there is not something this edit caused), and never
  // a server failing to load its own schema. In real sessions the only notes this check
  // ever produced were such warnings from the JSON server about files the model had not
  // touched, which sent it off to fix what was not broken.
  const relevant = diags.filter(
    (d) => !/\bschema\b.*\b(unable|could not|failed|ENOENT|not found)|\b(unable|could not|failed) to load schema/i.test(d.message) && (isEdited(d) || d.severity === "error"),
  );
  if (relevant.length === 0) return "";
  const rank = (d: CodeDiagnostic) => (d.severity === "error" ? 0 : 1);
  const sorted = [...relevant].sort((a, b) => rank(a) - rank(b));
  const shown = sorted.slice(0, MAX_REPORTED);

  const lines = shown.map((d) => {
    const where = isEdited(d) ? "" : " (caller)";
    return `- ${label(d.file)}:${d.line}${where} ${d.severity}: ${d.message}`;
  });
  const hidden = sorted.length - shown.length;
  const more = hidden > 0 ? `\n(${hidden} more not shown)` : "";
  const errors = sorted.filter((d) => d.severity === "error").length;

  return (
    `[Automatic check after your edit — these are the language server's diagnostics for the ` +
    `files you just changed and the files that import them. ${errors} error` +
    `${errors === 1 ? "" : "s"} across ${new Set(shown.map((d) => d.file)).size} file` +
    `${new Set(shown.map((d) => d.file)).size === 1 ? "" : "s"}. Fix what you caused; a ` +
    `diagnostic in a file marked (caller) means your change broke code elsewhere. If one ` +
    `was already there before your edit, say so rather than silently fixing unrelated ` +
    `code.]\n${lines.join("\n")}${more}`
  );
}

/**
 * The whole pass: what did this round edit, what does that reach, and is anything broken.
 *
 * Returns "" whenever there is nothing to say — no edits, no chassis, no diagnostics.
 * Never throws: this runs inside the turn loop and a failure here must cost the user
 * nothing more than the check itself.
 */
export async function rippleCheck(
  ctx: ToolContext,
  results: readonly { name: string; args?: Record<string, unknown>; isError?: boolean }[],
  resolve: (p: string) => string | undefined,
): Promise<string> {
  try {
    const edited = editedPaths(results, resolve);
    if (edited.length === 0) return "";
    const targets = await rippleTargets(ctx, edited);
    const all: CodeDiagnostic[] = [];
    await Promise.all(
      targets.map(async (abs) => {
        const chassis = chassisForPath(ctx, abs);
        if (!chassis) return;
        try {
          all.push(...(await chassis.diagnostics(abs)));
        } catch {
          // One unreachable server must not lose the diagnostics from the others.
        }
      }),
    );
    return formatRippleNote(all, new Set(edited), (abs) => relativize(ctx, abs));
  } catch {
    return "";
  }
}
