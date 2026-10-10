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
import { FULL_DETAIL_MAX, multiEditDetail, oneLineSteps, sessionDetailFull, shellOutput, uiOpenedText, withScope, writeDetail } from "./detail.js";
import { pageLine } from "./ui.js";

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
    const body = multiEditDetail(ops, FULL_DETAIL_MAX);
    full = scope ? withScope(scope, body) : body;
  } else if (tool === "run_command") {
    // Output that context clearing has already replaced is not the output: rebuilding from it
    // would show the model's note as if the command had printed it.
    if (entry.content.includes("[old tool result cleared")) return undefined;
    const { head, tail } = shellFrame(entry.detail);
    const out = shellOutput(entry.content, FULL_DETAIL_MAX);
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
  if (isError || reports) return { detail: whole };
  const steps = before.startsWith("Ran ") ? oneLineSteps(before) : before ? [before.split("\n").map((l) => l.trim()).filter(Boolean).join("\u21b5")] : [];
  const kept = sessionDetailFull("", whole);
  if (!kept) return undefined;
  return { detail: [...steps, pageLine(counts, off, total)].join("\n"), detailFull: kept };
}
