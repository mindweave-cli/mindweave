/**
 * edit.ts — change an existing file, in one place or in several.
 *
 * ── WHY THIS IS ONE TOOL AND NOT TWO ────────────────────────────────────────────
 *
 * This was `edit_file` (one replacement) and `multi_edit` (several) for a long
 * time, and the split cost more than it bought. The two tools shared the same
 * guards, the same matcher and the same write path; the only real difference was
 * the SHAPE the model had to choose between, and it chose badly and inconsistently.
 * The changelog records the measurement: three different shapes across four runs on
 * identical input. Every one of those runs was a correct edit expressed a different
 * way, which means the choice was noise — and noise the model spends attention on.
 *
 * A single tool taking an `edits[]` array removes the decision entirely. One edit is
 * an array of one; there is no second tool to weigh, no rule to remember about when
 * to switch, and no way to pick wrong. It is also strictly cheaper: two near-
 * duplicate schemas cost more advertised tokens than one that covers both cases.
 *
 * ── DELIBERATELY ONE FILE PER CALL ──────────────────────────────────────────────
 *
 * An earlier version accepted edits across several files in one call. That was
 * reverted on purpose, and the reasoning still holds:
 *
 *  - BLAST RADIUS. Twelve edits across five files is one UI row, one merged diff, and
 *    one `/undo` unit. Per file, you get a row, a scoped diff and an undo point each,
 *    which is the difference between a change you can review and one you have to trust.
 *  - IT HID THE UNIT OF WORK. "Edit this file in three places" is a thing a person can
 *    check. "Edit the codebase" is not, and the tool should not encourage collapsing a
 *    whole task into one indivisible action.
 *
 * The cost is honest and worth stating: three files still mean three calls, so if the
 * second refuses, the first has already landed. What makes that acceptable is that the
 * refusals themselves became rare — matching tolerates indentation drift, and an
 * ambiguous match reports WHERE the candidates are instead of leaving the model to
 * guess (see editCore.ts). The fix for half-applied refactors is fewer failures, not
 * bigger transactions.
 *
 * ATOMIC WITHIN THE FILE: edits are applied to an in-memory copy, and if any of them
 * fails to match, nothing is written and the offending edit is named. A file is never
 * left half-changed. Reliability comes from the tool REFUSING bad edits rather than
 * from the model being careful: read-before-edit, must-exist, and unique-match make
 * the classic failure modes structurally impossible. The write itself goes through
 * `writeFileAtomic`, so a crash mid-write cannot leave a torn file either.
 */
import type { Tool, ToolResult } from "./types.js";
import { recordWrite, relativize } from "./paths.js";
import { applyEol } from "./eol.js";
import { FULL_DETAIL_MAX, multiEditDetail, lineCount, magnitude, rangeLabel, withScope } from "./detail.js";
import { applyEditSequence, type EditOp } from "./editCore.js";
import { numberedWindow, charToLine } from "./editWindow.js";
import { prepareEditTarget, unreadError, fail, failQuietly, errText } from "./editTarget.js";
import { writeFileAtomic } from "./atomicWrite.js";

export const edit: Tool = {
  name: "edit",
  readOnly: false,
  // Two things this description has to do at once: make the single-edit case feel as
  // light as it is (one entry, no ceremony), and make batching the OBVIOUS move for a
  // file needing several changes, since one call beats three round trips. The matcher's
  // leniency is stated because a model told it needs exact bytes re-reads whole files
  // to get them; what the matcher does NOT forgive is stated just as plainly, because a
  // matcher that sounds infinitely lenient invites the sloppy input that makes a
  // wrong-place edit possible. See editCore.ts.
  description:
    "Change an existing file by replacing strings in it. This is the DEFAULT way to modify " +
    "a file — prefer it over rewriting one with write_file. Read the file first. " +
    "Pass `edits`: one entry for a single change, or several entries to change one file in " +
    "several places in a single call (an import at the top, a call site in the middle, a " +
    "helper further down). Batching is strongly preferred over repeated calls to this tool " +
    "on the same file. Edits apply in order and each sees the result of the previous ones, " +
    "so you can add a symbol and then edit around it. " +
    "Each `old_string` must identify exactly ONE place, and is matched on content rather " +
    "than formatting: if an exact match is not found, each line is compared with leading " +
    "and trailing whitespace ignored, and line endings are normalized on both sides. So you " +
    "do not need to reproduce a file's exact indentation, and a CRLF file is not a problem. " +
    "What is never forgiven is a skipped, reordered, or extra line. " +
    "If an `old_string` matches SEVERAL places the file is left untouched and you get the " +
    "candidate locations back with surrounding context: pick one and include enough nearby " +
    "lines to make it unique, or set `replace_all` to change every occurrence. " +
    "ONE FILE PER CALL — make a separate call for each file you need to change. " +
    "All-or-nothing: if any edit doesn't match, the file is left completely untouched.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "edits"],
    properties: {
      path: {
        type: "string",
        description: "The one file every edit in this call applies to, absolute or relative to the working directory.",
      },
      edits: {
        type: "array",
        minItems: 1,
        description: "The replacements to apply to that file, in order. A single change is an array of one.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["old_string", "new_string"],
          properties: {
            old_string: {
              type: "string",
              description: "The text to replace. Include enough surrounding lines to make it unique.",
            },
            new_string: {
              type: "string",
              description: "The replacement text. Use an empty string to delete old_string.",
            },
            replace_all: {
              type: "boolean",
              description:
                "Replace every occurrence instead of requiring a unique match. Use it when the same change applies " +
                "to all of them — e.g. deleting a duplicated helper that appears twice in this file. Default false.",
            },
          },
        },
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) return failQuietly("`path` is required — it names the one file this call edits.");
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return failQuietly("`edits` is required and must be a non-empty array of {old_string, new_string} edits.");
    }

    // Validate and normalize each edit up front, so a bad shape is reported before we
    // touch the file.
    const ops: EditOp[] = [];
    for (let i = 0; i < args.edits.length; i++) {
      const e = args.edits[i] as Record<string, unknown>;
      if (!e || typeof e !== "object") return failQuietly(`edit #${i + 1} is not an object.`);
      // A per-edit path is refused rather than ignored. Silently dropping it would apply
      // the edit to the WRONG file — the top-level one — which is the worst outcome
      // available here, so say what to do instead.
      if (typeof e.path === "string" && e.path.trim() && e.path.trim() !== rawPath) {
        return failQuietly(
          `edit #${i + 1} names a different file (${e.path.trim()}). One edit call changes one file: ` +
            `make a separate call for each file you need to change.`,
        );
      }
      if (typeof e.old_string !== "string" || e.old_string === "") {
        return failQuietly(`edit #${i + 1}: \`old_string\` is required and must not be empty.`);
      }
      if (typeof e.new_string !== "string") {
        return failQuietly(`edit #${i + 1}: \`new_string\` is required (use an empty string to delete).`);
      }
      if (e.old_string === e.new_string) {
        return failQuietly(`edit #${i + 1}: \`old_string\` and \`new_string\` are identical — nothing to change.`);
      }
      ops.push({ oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all === true });
    }

    const preview = ops.map((o) => `- ${o.oldString}\n+ ${o.newString}`).join("\n\n");
    const target = await prepareEditTarget(ctx, rawPath, "editing", preview);
    if (!target.ok) return target.error;
    const { filePath, content, eol } = target;

    // Apply the whole sequence to an in-memory copy. Atomic: a failure names the
    // offending edit and writes nothing. A one-entry sequence is exactly a single
    // replacement, so the single-edit case shares this path rather than forking it.
    const seq = applyEditSequence(content, ops);
    // A file that was never read has to EARN the edit by matching exactly. It just
    // failed to, so this is the case the read-before-edit gate exists for — and the
    // read now happens because it is genuinely needed, not on the off chance.
    if (!seq.ok && target.unread) return unreadError(rawPath);
    if (!seq.ok) {
      // The reason may already end in a sentence (the ambiguity report does), so don't
      // staple a second full stop onto it.
      const reason = /[.!?]$/.test(seq.reason) ? seq.reason : `${seq.reason}.`;
      // Quiet: the model has the reason and the candidate locations and fixes its own
      // aim. Nothing reached disk, so there is nothing for the user to act on.
      const which = ops.length === 1 ? "the edit" : `edit #${seq.index + 1}`;
      return failQuietly(`${which} could not be applied to ${rawPath}: ${reason} No changes were written.`);
    }

    const updated = applyEol(seq.updated, eol);
    // Snapshot the pre-edit bytes for /undo before touching disk.
    ctx.checkpoints?.backup(filePath, content, updated);
    try {
      await writeFileAtomic(filePath, updated);
    } catch (error) {
      return fail(`could not write ${rawPath}: ${errText(error)}`);
    }

    const startLine = charToLine(seq.updated, seq.spanStart) + 1;
    const endLine = charToLine(seq.updated, seq.spanEnd) + 1;
    // Record the edited region as this file's focus, so a large file localizes to it
    // in the working set instead of being carried whole.
    await recordWrite(ctx, filePath, { start: startLine, end: endLine });

    const shown = relativize(ctx, filePath);
    const nEdits = ops.length;
    // One numbered window spanning from the first change to the last, so the model can
    // keep working from the result without re-reading the file.
    const window = numberedWindow(seq.updated, seq.spanStart, seq.spanEnd);
    let removed = 0;
    let added = 0;
    for (const op of ops) {
      removed += lineCount(op.oldString);
      added += lineCount(op.newString);
    }
    // Scope reads as the change actually was: "L120-124 · −2 +5" for one edit, and
    // "3 edits · L120-420 · −18 +40" when several were batched. Leading with an edit
    // count on a single edit would be noise.
    const magnitudes = `${rangeLabel(startLine, endLine)} · ${magnitude(removed, added)}`;
    const scope = nEdits === 1 ? magnitudes : `${nEdits} edits · ${magnitudes}`;
    const headline =
      nEdits === 1
        ? `Edited ${shown}.`
        : `Edited ${shown}: ${nEdits} edits, ${seq.total} replacement${seq.total === 1 ? "" : "s"} total.`;
    return {
      output:
        `${headline}\n` +
        `Changed region — line-numbered so you can make further edits without re-reading:\n${window}`,
      summary: `edited ${shown} · ${scope}`,
      detail: withScope(scope, multiEditDetail(ops)),
      detailFull: withScope(scope, multiEditDetail(ops, FULL_DETAIL_MAX)),
      detailKind: "diff" as const,
    };
  },
};
