/**
 * rebuildDetail.ts — the uncut block of a tool row, put back together for a session that
 * was saved before the uncut text was kept (pure).
 *
 * A session file has always held what a row needs to be DRAWN (`detail`, cut short) and
 * what the model needs (`content`), and it holds the call's own arguments. Those three
 * are enough to rebuild the rest for the calls that matter most:
 *
 * - a written file: the call carries the whole file
 * - an edit: the call carries every old and new string
 * - a command: the model's copy of the output is the output
 *
 * It is a reconstruction, and says so by being limited to those three. A search, a read
 * or any other tool has no uncut block worth opening and gets none. The command's copy is
 * what the model was shown, which can already have had its middle cut, and that cut is
 * kept as it was rather than papered over.
 */
import { FULL_DETAIL_MAX, SEARCH_PREVIEW_SOURCES, capLines, multiEditDetail, oneLineSteps, sessionDetailFull, shellOutput, uiOpenedText, withScope, writeDetail } from "./detail.js";
import { pageLine } from "./ui.js";
import { readFileSync } from "node:fs";

/** The rows of `detail` that come before the body: the scope line of a diff. */
function leadingScope(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const first = detail.split("\n")[0]!;
  return /^[+-] /.test(first) || first.startsWith("$ ") ? undefined : first;
}

/** The `$ command` line and the closing verdict of a shell block, which the output does not hold. */
function shellFrame(detail: string | undefined): { head?: string; tail?: string } {
  if (!detail) return {};
  const lines = detail.split("\n");
  const head = lines[0]?.startsWith("$ ") ? lines[0] : undefined;
  const last = lines[lines.length - 1];
  const tail = last && /^[✓✗✖]/.test(last) ? last : undefined;
  return { head, tail };
}

/**
 * What a saved search printed, for the row's click (pure). A chat saved before searches had a
 * row kept only what the model was given, and that is exactly what the search printed. Undefined
 * once context clearing has replaced it with a note, which is not what the search printed.
 */
export function searchDetailFromContent(content: string): string | undefined {
  if (!content.trim() || content.includes("[old tool result cleared") || content.startsWith("Error:")) return undefined;
  return capLines(content.split("\n"), FULL_DETAIL_MAX);
}

/**
 * The block as the live row would have held it, bounded the way a saved session bounds it,
 * or undefined when this call has nothing more to open.
 */
export function rebuildFull(
  tool: string | undefined,
  args: Record<string, unknown> | undefined,
  entry: { detail?: string; content: string },
): string | undefined {
  if (!tool || !entry.detail) return undefined;
  let full: string | undefined;

  if (tool === "write_file" && typeof args?.content === "string") {
    const scope = leadingScope(entry.detail);
    const body = writeDetail(args.content, FULL_DETAIL_MAX);
    full = scope ? withScope(scope, body) : body;
  } else if (tool === "edit" && Array.isArray(args?.edits)) {
    const ops = (args.edits as Record<string, unknown>[])
      .filter((e) => e && typeof e.old_string === "string" && typeof e.new_string === "string")
      .map((e) => ({ oldString: e.old_string as string, newString: e.new_string as string }));
    if (ops.length === 0) return undefined;
    const scope = leadingScope(entry.detail);
    // The call holds the old and new text, not the file, so all it can show is every old line removed and every new line
    // added. That is the real change only when nothing in the replaced text stayed the same. An edit that re-sent a whole
    // block with two lines added was shown as -5 +9 above a row that said -0 +2, and a stored row that already showed the
    // whole real diff was made to "open" onto this one. The row's own count says which it is.
    const said = scope ? /[−-](\d+) \+(\d+)\s*$/.exec(scope) : null;
    const rows = (s: string): number => s.replace(/\n$/, "").split("\n").length;
    if (!said || Number(said[1]) !== ops.reduce((n, o) => n + rows(o.oldString), 0) || Number(said[2]) !== ops.reduce((n, o) => n + rows(o.newString), 0)) return undefined;
    const body = multiEditDetail(ops, FULL_DETAIL_MAX);
    full = scope ? withScope(scope, body) : body;
  } else if (tool === "run_command") {
    // Output that context clearing has already replaced is not the output: rebuilding from it
    // would show the model's note as if the command had printed it.
    // The copy clearing saved before it emptied the result IS the output, and is used in its place.
    const cleared = entry.content.includes("[old tool result cleared");
    const source = cleared ? savedCopyText(entry.content) : entry.content;
    if (source === undefined) return undefined;
    const { head, tail } = shellFrame(entry.detail);
    const out = shellOutput(source, FULL_DETAIL_MAX);
    full = [head, out || undefined, tail].filter((l): l is string => !!l).join("\n");
  }

  return sessionDetailFull(entry.detail, full);
}

/**
 * A written file's block taken from the file as it is now, for a saved session whose call no
 * longer holds what it wrote (pure). Clearing old context empties a write call's text, and an
 * older session never kept the uncut block, so the only copy left is the file itself.
 *
 * Used only when the file still has the line count the row said it wrote ("whole file · 846
 * lines"): a file that has since changed size would show something that was not written, and
 * a row that cannot be opened is better than one that opens onto the wrong text.
 */
export function writtenFromDisk(detail: string | undefined, onDisk: string): string | undefined {
  const scope = leadingScope(detail);
  const said = scope?.match(/^(?:whole|new) file · ([\d,]+) lines?$/);
  if (!said) return undefined;
  const lines = onDisk === "" ? 0 : onDisk.split("\n").length;
  if (lines !== Number(said[1]!.replace(/,/g, ""))) return undefined;
  return sessionDetailFull(detail, withScope(scope!, writeDetail(onDisk, FULL_DETAIL_MAX)));
}

/** A control line as the model's list prints it: `[7] button "1. Chapter 1" (disabled)`. */
const CONTROL_LINE = /^\s*\[\d+\] (.+)$/;

/**
 * A UI test's row as it was saved BEFORE it became a two-part row: the steps, then every
 * control on the page, as one block of text (pure).
 *
 * Returns what the row shows now and, when there is something behind it, what opens. A run
 * that went well becomes the steps and one line about the page, with the titled whole behind
 * a click. A run that failed, or that had the page's own reports after the control list, is
 * shown whole, but in the same titled form instead of the flat block. Undefined when this is
 * not a control list at all (a list that says no control could be read), so the row is left
 * exactly as it was.
 *
 * The kind of each control is the words before its name or its flags, which is how the list
 * has always printed them.
 */
export function compactUiDetail(detail: string | undefined, isError: boolean | undefined): { detail: string; detailFull?: string } | undefined {
  if (!detail) return undefined;
  const lines = detail.split("\n");
  const first = lines.findIndex((l) => CONTROL_LINE.test(l) || /^In ".*":$/.test(l));
  if (first < 0) return undefined;
  const counts = new Map<string, number>();
  const listed: string[] = [];
  const after: string[] = [];
  let off = 0;
  let total = 0;
  let inList = true;
  for (const line of lines.slice(first)) {
    if (!inList) {
      after.push(line);
      continue;
    }
    if (line.trim() === "" || /^\s*In ".*":$/.test(line) || /^\s*\u2026 and \d+ more not listed/.test(line)) {
      if (line.trim() !== "") listed.push(line.trim());
      continue;
    }
    const m = CONTROL_LINE.exec(line);
    if (!m) {
      inList = false;
      after.push(line);
      continue;
    }
    listed.push(line.trim());
    const kind = /^(.*?)(?: "| \(| =|$)/.exec(m[1]!)![1]!.trim();
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (/\(([^)]*,\s*)?out of view(,[^)]*)?\)/.test(m[1]!)) off++;
    total++;
  }
  if (total === 0) return undefined;
  const before = lines.slice(0, first).join("\n").trim();
  const reports = after.join("\n").trim();
  const whole = uiOpenedText({ did: before, list: listed.join("\n"), total, off, reports });
  const steps = before.startsWith("Ran ") ? oneLineSteps(before) : before ? [before.split("\n").map((l) => l.trim()).filter(Boolean).join("\u21b5")] : [];
  const said = isError || reports ? reports.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const kept = sessionDetailFull("", whole);
  if (!kept) return undefined;
  return { detail: [...steps, ...said, pageLine(counts, off, total)].join("\n"), detailFull: kept };
}

/**
 * A web search's row as it was saved BEFORE it became a short row that opens on a click (pure).
 *
 * The saved block is `Engine: X`, `Query time: Y`, `Found N sources`, then up to eight numbered
 * titles and a `(+M more)` line. It comes back as the row a new search draws: one summary line
 * and the first few titles, with every title that was kept behind a click. The titles past the
 * eighth were never saved, and the opened list says so instead of implying it shows them all.
 *
 * Undefined when this is not that block (a search that failed, or a row already in the new
 * form), so such a row is left exactly as it was.
 */
export function compactSearchDetail(detail: string | undefined): { detail: string; detailFull?: string } | undefined {
  if (!detail) return undefined;
  const lines = detail.split("\n");
  const grab = (re: RegExp): RegExpExecArray | undefined => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m;
    }
    return undefined;
  };
  const found = grab(/^Found (\d+) sources?$/);
  if (!found) return undefined;
  const total = Number(found[1]);
  const titles: string[] = [];
  for (const l of lines) {
    const m = /^\d+\. (.*)$/.exec(l);
    if (m) titles.push(m[1]!);
  }
  const summary = [grab(/^Engine: (.+)$/)?.[1], grab(/^Query time: (.+)$/)?.[1], `${total} source${total === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");
  const row = (t: string, i: number) => `${i + 1}. ${t}`;
  const shown = [summary, ...titles.slice(0, SEARCH_PREVIEW_SOURCES).map(row)];
  const lost = total - titles.length;
  // Numbers padded to one width so the titles start in the same column past nine.
  const digits = String(titles.length).length;
  const whole = [
    summary,
    ...titles.map((t, i) => `${String(i + 1).padStart(digits)}. ${t}`),
    ...(lost > 0 ? [`(${lost} more ${lost === 1 ? "source was" : "sources were"} not kept in this chat)`] : []),
  ];
  return { detail: shown.join("\n"), ...(whole.length > shown.length ? { detailFull: whole.join("\n") } : {}) };
}

/** Where a cleared result was saved, from the stub it left (pure): `[saved at <file> · 57 lines …]`. */
export function savedCopyPath(content: string): string | undefined {
  return /\[saved at (.+?) · \d+ lines/.exec(content)?.[1];
}

/** What a cleared result saved, whole, or undefined when there is no copy (or it is gone). */
export function savedCopyText(content: string): string | undefined {
  const saved = savedCopyPath(content);
  if (!saved) return undefined;
  try {
    const text = readFileSync(saved, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The same, bounded the way a row's block is. */
export function recoverSavedText(content: string): string | undefined {
  const text = savedCopyText(content);
  return text === undefined ? undefined : capLines(text.replace(/\n$/, "").split("\n"), FULL_DETAIL_MAX);
}

/**
 * The text of a read, put back for the screen when clearing old context took it out of the conversation.
 *
 * Clearing is for what the MODEL carries; what the person sees is never lost to it. Tried in order: the copy clearing
 * saved before it emptied the result (exactly what was read), then the file as it is now, for a chat cleared before
 * copies were saved. That last one says it is the file as it is now, because it may have changed since.
 * Undefined only when the file is gone as well.
 */
export function recoverReadText(
  content: string,
  call: { args?: Record<string, unknown> } | undefined,
  cwd: string,
  read: (path: string) => string | undefined,
  resolvePath: (cwd: string, p: string) => string,
): string | undefined {
  const saved = savedCopyPath(content);
  if (saved) {
    const text = read(saved);
    if (text !== undefined && text.trim()) return capLines(text.replace(/\n$/, "").split("\n"), FULL_DETAIL_MAX);
  }
  const args = call?.args ?? {};
  const paths: string[] = [];
  const one = (p: unknown): void => {
    if (typeof p === "string") paths.push(p);
    else if (p && typeof p === "object" && typeof (p as { path?: unknown }).path === "string") paths.push((p as { path: string }).path);
  };
  one(args.path);
  if (Array.isArray(args.paths)) for (const p of args.paths) one(p);
  if (paths.length === 0) return undefined;
  const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset : 1;
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : undefined;
  const parts: string[] = [];
  for (const p of paths) {
    const raw = read(resolvePath(cwd, p));
    if (raw === undefined) continue;
    const lines = raw.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const end = Math.min(lines.length, limit === undefined ? lines.length : offset - 1 + limit);
    const width = String(end).length;
    const body = lines.slice(offset - 1, end).map((l, i) => `${String(offset + i).padStart(width)}\t${l}`).join("\n");
    parts.push(paths.length > 1 ? `${p}\n${body}` : body);
  }
  if (parts.length === 0) return undefined;
  const note = /CHANGED since/.test(content) ? "(the file has changed since it was read; this is the file as it is now)" : "(this is the file as it is now; it may have changed since it was read)";
  return capLines([note, ...parts.join("\n\n").split("\n")], FULL_DETAIL_MAX);
}
