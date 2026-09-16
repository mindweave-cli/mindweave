/**
 * readFile.ts — Mindweave's first tool: read a text file.
 *
 * The smallest useful, fully read-only capability — it proves the whole
 * tool loop end-to-end without any risk of changing the user's files.
 *
 * Design borrows the proven essentials from mature agents (line-numbered
 * output, optional offset/limit range, a size cap that nudges toward ranged
 * reads, binary refusal, a friendly not-found). It deliberately does NOT carry
 * "read surgically / how to investigate" guidance — that is the model's
 * judgment, not the tool's job.
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { foreignAgentReason, protectedPathReason } from "./guard.js";
import { requestAgentDataAccess } from "./approval.js";
import { relativize, resolvePath, nextTouch, touch, markScope } from "./paths.js";
import { addFocus, coversSpan } from "./focus.js";
import { chassisForPath } from "./chassisMux.js";
import { renderOutlineEntries } from "./codeIntel.js";
import { estimateTokens } from "../memory/compaction.js";
import { failQuietly } from "./results.js";
// Shared with the row that displays the call, so what is read and what is named can
// never disagree about which files a call asked for. See pathList.ts.
import { toPathList } from "./pathList.js";

// Caps protect the model's context window, not the disk. They are deliberately
// MODEL-AGNOSTIC fixed defaults, not derived from any one model's context window —
// so they stay correct as other models are added.
//   - MAX_BYTES: refuse a whole-file read of a file this large; use a range.
//   - MAX_LINES: a default read returns at most this many lines (the model pages
//     with offset for more). This is the big BYOK-cost lever — a 5000-line file
//     costs one bounded read, not 5000 lines every time.
//   - MAX_OUTPUT_CHARS: final safety truncation (e.g. minified long lines).
const MAX_BYTES = 256 * 1024;
const MAX_LINES = envInt("MINDWEAVE_READ_MAX_LINES", 2000);
const MAX_OUTPUT_CHARS = 120_000;

/**
 * Most files one call may read.
 *
 * The point of the list is to collapse round trips, not to let a single call pull an
 * unbounded amount of the repository into context. Ten covers every batch a real task
 * asks for; past that the model should be searching, not reading.
 */
const MAX_FILES = 10;

/**
 * Token budget for a WHOLE-file read, past which the file's structure is returned
 * instead of its contents.
 *
 * The habit this exists to break: answering "where is this handled?" by reading a
 * 1,700-line file. That costs its full length on the request that fetches it AND on
 * every request afterwards for the rest of the turn, so one careless read is re-billed
 * five or ten times. The usual answer is a hard token cap that refuses the read; this
 * one does better, because the code map already knows the file's shape.
 *
 * ~8,000 tokens is roughly 700 lines of code. Below that a whole read is a reasonable
 * way to understand a file. Above it, the model almost never wants all of it — it wants
 * one function — and an outline plus a ranged follow-up costs a fraction of the same
 * answer. A range is NEVER budgeted: asking for specific lines is already the careful
 * behaviour, and second-guessing it would just cost a round trip.
 */
const WHOLE_READ_TOKEN_BUDGET = envInt("MINDWEAVE_WHOLE_READ_TOKENS", 8_000);

// Returned instead of re-sending identical content when a file is unchanged
// since the model last read it — pure token savings on a re-read.
const FILE_UNCHANGED =
  "This file is unchanged since you last read it in this conversation — the " +
  "earlier read is still current, use that instead of re-reading.";

export const readFile: Tool = {
  name: "read_file",
  readOnly: true,
  // The description states the tool's CONTRACT, not just its happy path, because two
  // of its outcomes are easy to misread as failures and one of its roles is invisible
  // from here. Every claim below is checked against the behaviour in `execute`; if that
  // changes, this changes with it.
  description:
    `Read text files and return their contents with line numbers. ` +
    `\`paths\` TAKES A LIST: pass every file you want in ONE call rather than calling ` +
    `this once per file. Each extra call is a full model round-trip that re-sends the ` +
    `whole conversation, so four separate reads cost several times what one read of ` +
    `four files costs, and take four times as long. Up to ${MAX_FILES} at a time. ` +
    `When you already know which part of a file you need, READ ONLY THAT PART: pass ` +
    `\`offset\` (and optionally \`limit\`). A range applies to a SINGLE file: pass one path ` +
    `when you use one, or the range is ignored and the files come back whole. ` +
    `Reading a file whole costs its full length on this ` +
    `request and on every later one this turn, so a needless whole read is paid for many ` +
    `times over. ` +
    `A whole read past ~${Math.round(WHOLE_READ_TOKEN_BUDGET / 1000)}k tokens returns the ` +
    `file's STRUCTURE — its symbols with line numbers — instead of its contents, so you ` +
    `can follow up with the exact range, or with read_symbol for one symbol by name. ` +
    `That is an answer, not a failure. ` +
    `Otherwise reads up to ${MAX_LINES} lines per file from the start. A file larger than ` +
    `${Math.round(MAX_BYTES / 1024)} KB must be read with \`limit\` set rather than whole. ` +
    `Very long output is truncated at the end, and says so. ` +
    `One unreadable path does not fail the others: it is reported in place and the rest ` +
    `still come back. ` +
    `Reading is also what unlocks editing: edit, replace_symbol_body ` +
    `and overwriting an existing file with write_file all require that file to have ` +
    `been read this session (read_symbol counts too). ` +
    `ONE REPLY MEANS YOU ALREADY HAVE THE FILE and should not read it again: it says the ` +
    `file is unchanged since your earlier read in this conversation, so that earlier read ` +
    `is still current. It is a successful read, and it satisfies the edit requirement above. ` +
    `When you only want one function, class or type, prefer read_symbol, which returns ` +
    `just that symbol instead of pulling in a large file to look at a small part of it.`,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["paths"],
    properties: {
      paths: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FILES,
        items: { type: "string" },
        description:
          "The files to read, absolute or relative to the working directory. Pass every " +
          "file you need at once — one call with four paths costs a quarter of what four " +
          "calls cost.",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "1-based line number to start at. Ignored unless `paths` holds exactly one file.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "Number of lines to read from `offset`. Ignored unless `paths` holds exactly one file.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const paths = toPathList(args);
    if (paths.length === 0) return failQuietly("`paths` is required — pass at least one file.");
    if (paths.length > MAX_FILES) {
      return failQuietly(`Too many files (${paths.length}). Read at most ${MAX_FILES} in one call.`);
    }
    let offset = toPositiveInt(args.offset);
    let limit = toPositiveInt(args.limit);
    // A range names lines in ONE file. Applying it across a list would silently return a
    // different slice of each, which reads as an answer and is not one — so the range is
    // DROPPED here rather than honoured.
    //
    // It is dropped, though, and not treated as a failed call. Rejecting the whole call
    // costs a round trip to recover, which is the exact cost this tool exists to avoid —
    // the same reason one unreadable path below does not fail the others. In practice it
    // cost more than the round trip: told only to pass a single path, a model retried
    // with the first path and silently abandoned the rest of its list.
    //
    // Whole reads are already bounded by WHOLE_READ_TOKEN_BUDGET, so dropping a range
    // cannot turn a cheap ranged read into an unbounded one.
    const rangeDropped = (offset !== undefined || limit !== undefined) && paths.length > 1;
    if (rangeDropped) {
      offset = undefined;
      limit = undefined;
    }

    const parts: string[] = [];
    const summaries: string[] = [];
    const fullPaths: string[] = [];
    let failures = 0;
    for (const rawPath of paths) {
      const one = await readOne(rawPath, ctx, offset, limit);
      // A bad path is reported IN PLACE rather than failing the call. Losing three good
      // reads because the fourth was misspelled would cost another whole round trip to
      // recover, which is the exact cost this tool exists to avoid.
      if (one.error) failures++;
      parts.push(paths.length > 1 ? `===== ${one.label} =====\n${one.body}` : one.body);
      summaries.push(one.summary);
      if (one.fullPath) fullPaths.push(one.fullPath);
    }

    if (paths.length === 1) {
      return {
        output: parts.join("\n"),
        summary: summaries[0] ?? "",
        ...(failures > 0 ? { isError: true as const } : {}),
        ...(fullPaths.length > 0 ? { fullContentOf: fullPaths } : {}),
      };
    }
    // Prepended as another part rather than raised as an error, so the model learns the
    // rule and still gets every file it asked for.
    if (rangeDropped) {
      parts.unshift(
        "Note: `offset`/`limit` name lines in a single file, so the range was ignored and " +
          `all ${paths.length} files were read whole. To read a range, call again with one path.`,
      );
    }
    return {
      output: parts.join("\n\n"),
      summary: `read ${paths.length} files${failures > 0 ? ` (${failures} failed)` : ""}`,
      ...(fullPaths.length > 0 ? { fullContentOf: fullPaths } : {}),
    };
  },
};

/** What one file's read produced: its rendered body plus what the caller must record. */
interface OneRead {
  /** How this file is named in a multi-file listing. */
  label: string;
  /** Line-numbered content, or the error text. */
  body: string;
  /** The row shown to the user for this file. */
  summary: string;
  /** Set only when the file's WHOLE content went out (see wholeFileSent). */
  fullPath?: string;
  error?: true;
}

/**
 * Read one file. Every rule here — the caps, the dedup, the presence flag — is per file
 * and unchanged by batching; only the number of files a single call handles is new.
 */
async function readOne(
  rawPath: string,
  ctx: ToolContext,
  offset: number | undefined,
  limit: number | undefined,
): Promise<OneRead> {
  const bad = (message: string): OneRead => ({
    label: rawPath,
    body: `Error: ${message}`,
    summary: message,
    error: true,
  });
  const trimmed = rawPath.trim();
  if (!trimmed) return bad("empty path.");

  const filePath = resolvePath(ctx, trimmed);
  const blocked = protectedPathReason(filePath);
  if (blocked) return bad(`Refusing to read ${trimmed}: it is ${blocked}.`);
  const otherTool = foreignAgentReason(filePath);
  if (otherTool) {
    const denied = await requestAgentDataAccess(ctx, otherTool, `Reading ${trimmed}`);
    if (denied) return bad(denied.summary ?? "access refused");
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return bad(`File not found: ${trimmed}`);
  }
  if (stat.isDirectory()) return bad(`${trimmed} is a directory, not a file.`);

  const full = offset === undefined && limit === undefined;
  const prior = ctx.reads.get(filePath);
  const unchanged = prior !== undefined && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size;

  // Read-dedup: if the model already read this whole file, it hasn't changed since
  // (same mtime + size), and that earlier read is STILL IN the transcript, don't
  // re-send the content. The presence half is derived per turn rather than read off
  // the ledger: microcompaction can clear the earlier result's body at any time, and
  // a stored "you have it" bit would then be a lie the model obeys. No presence set
  // (a subagent, a test) means no dedup — a wasted read, never a phantom one.
  if (full && prior?.full && unchanged && ctx.transcriptFull?.has(filePath)) {
    touch(ctx, filePath);
    const shown = relativize(ctx, filePath);
    return { label: shown, body: FILE_UNCHANGED, summary: `read ${shown} (unchanged)` };
  }

  if (limit === undefined && stat.size > MAX_BYTES) {
    return bad(
      `File is large (${formatBytes(stat.size)}). Read a range with \`offset\` and \`limit\` instead of the whole file.`,
    );
  }

  const buf = await fs.readFile(filePath);
  if (looksBinary(buf)) return bad(`${trimmed} looks like a binary file; cannot read as text.`);

  // A WHOLE read of a big file: answer with the file's shape instead of its contents.
  //
  // This is the one place the code map pays for itself. The alternative on offer
  // elsewhere is an error telling the model to "use offset and limit" — which it cannot
  // act on, because it does not know which lines it wants yet. That is the whole reason
  // the whole-file read happens. An outline answers the question the read was really
  // asking ("where in here is the thing I need?") and makes the follow-up a precise
  // range instead of another guess.
  //
  // Ranges are exempt by construction: this branch only runs when `full` is true.
  if (full) {
    const estimate = estimateTokens(buf.toString("utf8"));
    if (estimate > WHOLE_READ_TOKEN_BUDGET) {
      const shown = relativize(ctx, filePath);
      const lineTotal = fileLines(buf).length;
      const head =
        `${shown} is ${lineTotal} lines (~${Math.round(estimate / 100) / 10}k tokens), too large to read whole — ` +
        `reading it would re-send all of that on every later request this turn.`;
      const entries = (await chassisForPath(ctx, filePath)?.outline(filePath)) ?? [];
      if (entries.length > 0) {
        return {
          label: shown,
          body:
            `${head}\n\nIts structure, with line numbers:\n\n` +
            renderOutlineEntries(entries).join("\n") +
            `\n\nRead the part you need with \`offset\`/\`limit\`, or read_symbol for one symbol by name.`,
          summary: `outlined ${shown} (${lineTotal} lines — too large to read whole)`,
        };
      }
      // No outline for this file type. Say the size and how to proceed, which is all a
      // language the code map cannot parse allows us to say honestly.
      return bad(
        `${head} Read a range with \`offset\` and \`limit\`, or search it for the part you need.`,
      );
    }
  }

  const allLines = fileLines(buf);
  const totalLines = allLines.length;
  const empty = totalLines === 0;
  const start = offset ?? 1;
  if (!empty && start > totalLines) {
    return bad(`offset ${start} is past the end of the file (${totalLines} lines).`);
  }

  // A read with no explicit limit still stops after MAX_LINES — the default
  // read is bounded, and the model pages with offset for the rest.
  const effectiveLimit = limit ?? MAX_LINES;
  const end = Math.min(totalLines, start - 1 + effectiveLimit);
  const slice = allLines.slice(start - 1, end);

  // Line numbers, right-aligned to the widest number in the slice.
  const width = String(end).length;
  // Said outright, because a numbered read of nothing looked exactly like a file holding
  // one blank line, and the model cannot tell "empty" from "blank" by inference.
  let body = empty
    ? "(this file is empty — 0 lines)"
    : slice.map((line, i) => `${String(start + i).padStart(width)}\t${line}`).join("\n");

  // Tell the model when the default cap hid the rest of the file.
  if (limit === undefined && end < totalLines) {
    body += `\n… (showing lines ${start}-${end} of ${totalLines}; pass offset to read further)`;
  }
  const charTruncated = body.length > MAX_OUTPUT_CHARS;
  if (charTruncated) {
    body = body.slice(0, MAX_OUTPUT_CHARS) + "\n… (truncated — read a smaller range with offset/limit)";
  }

  // "Whole file" means the whole file ACTUALLY WENT OUT, not merely that the caller
  // asked for no range. A 2500-line file read with no offset stops at the MAX_LINES
  // cap, and recording that as full let a later re-read be answered "unchanged since
  // you last read" for 500 lines the model was never shown. Same for the character
  // cap. The flag is the dedup's whole basis, so it has to mean what it says.
  const wholeFileSent = (full || empty) && end >= totalLines && !charTruncated;

  // Record the read so edit / write_file know this file has been seen, so a
  // later identical read can be deduped, and so it enters the working set (recency +
  // the focused range for a partial read, used to localize a large file).
  markScope(ctx, filePath);
  ctx.reads.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    full: wholeFileSent,
    touchedAt: nextTouch(),
    focus: !wholeFileSent ? addFocus(prior?.focus, { start, end }) : prior?.focus,
  });

  const shown = relativize(ctx, filePath);
  const ranged = offset !== undefined || limit !== undefined;
  return {
    label: shown,
    body,
    summary: empty ? `read ${shown} (empty)` : ranged ? `read ${shown} lines ${start}-${end}` : `read ${shown} (${slice.length} lines)`,
    // Presence, recorded as a FACT at the moment it is true, keyed by the absolute path
    // this call actually resolved to. Re-deriving it later by re-resolving these
    // arguments would be a guess: `cd` moves the working directory mid-session, so the
    // same recorded "a.ts" can resolve to a different file than it did when read.
    ...(wholeFileSent ? { fullPath: filePath } : {}),
  };
}



/**
 * A file's lines, as a person would count them.
 *
 * Split on CRLF or LF so a Windows file doesn't show a trailing \r on every line — the
 * model can't see it, would omit it from an edit's old_string, and the edit would then
 * fail to match. A final newline ENDS the last line rather than opening another: counting
 * the empty piece after it gave nearly every source file a phantom blank last line, one
 * line too many in every count, and an offset one past the end that slipped the guard.
 * An empty file has no lines at all.
 */
export function fileLines(buf: Buffer): string[] {
  if (buf.length === 0) return [];
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A positive integer from an env var, or `fallback`. Lets caps be tuned without
 *  baking any one model's limits into the code. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toPositiveInt(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** A NUL byte in the first chunk is a reliable, cheap "this isn't text" signal. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
