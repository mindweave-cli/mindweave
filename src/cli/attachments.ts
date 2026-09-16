/**
 * attachments.ts — share a file into a message, two ways:
 *
 *   1. `@path`        — type a mention (e.g. `look at @src/foo.ts`).
 *   2. drag & drop    — drag a file from the OS file manager onto the terminal (or
 *                       paste its path). Terminals turn a dropped file into its
 *                       path text — quoted when it has spaces, e.g.
 *                       `"D:\my project\foo.ts"` — which lands in the input buffer.
 *
 * Either way, Mindweave reads the file and hands its FULL contents to the model, while
 * the chat never shows the dump. The model receives an `<attached_file>` block; the
 * human sees a compact chip — a dropped path collapses to just the file name, and
 * one activity note records the line count, e.g. `attached foo.ts (+350 lines)`.
 * The split: the model sees the bytes, the human sees a chip.
 *
 * The split is enforced in two places:
 *   - on send, `resolveAttachments` returns the model text (clean line + file
 *     blocks), the display text (paths collapsed to file names), and the notes;
 *   - on resume, `stripAttachments` hides the file blocks so a reloaded transcript
 *     shows the chip, not the payload.
 *
 * Caps mirror read_file (256 KB / binary refusal): an attachment is a convenience,
 * not a way past the read tool's guards. Non-image binaries are skipped — the model
 * can't use them.
 *
 * IMAGES are the one attachment that doesn't become text. When the running model can
 * see (core asks the driver; it never asks which provider), the image is attached as
 * a reference and its bytes go on the wire at request time. When it can't — which is
 * the common case, since not every provider ships vision — the file is still named
 * for the model, and the note says plainly that this model can't see it. The same
 * message, sent on two different models, degrades rather than failing.
 */
import { promises as fs } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { describeImage, isImage, isRejection, type ImageRef } from "../memory/images.js";

// Same ceiling as read_file's whole-file read — keep one consistent "too big" line.
const MAX_BYTES = 256 * 1024;

// `@token` at a word boundary: `@` after start-or-whitespace, then a path-ish run.
const MENTION_RE = /(^|\s)@([^\s@]+)/g;
// A quoted path — how terminals deliver a dragged file whose path has spaces.
const QUOTED_RE = /'([^']+)'|"([^"]+)"/g;
// A bare absolute path dropped without quotes: Windows drive (`D:\…`), UNC
// (`\\host\…`), or POSIX (`/…`). Must start at a word boundary; stops at
// whitespace or a quote. Real-file gating (below) keeps stray matches harmless.
const BARE_ABS_RE = /(^|\s)((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"']+)/g;
// The same root shapes, anchored: "does this string start like an absolute path".
// Used to tell a dropped file from ordinary quoted prose without touching the disk.
const ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** One dropped path found in a chunk of typed/pasted text. */
export interface DroppedPath {
  start: number;
  end: number;
  /** The path itself, quotes stripped. */
  path: string;
}

/**
 * Find the absolute paths a terminal drops into the input when a file is dragged onto it,
 * quoted or bare. Syntactic only, and deliberately so: this runs on a keystroke, where
 * touching the disk is not an option, and requiring a drive letter, a UNC prefix or a
 * leading slash is enough to keep ordinary quoted prose ("hello world") out. Anything
 * that turns out not to be a file is still handled correctly later, because resolution
 * against the disk happens at send time exactly as it always did.
 */
export function findDroppedPaths(text: string): DroppedPath[] {
  const out: DroppedPath[] = [];
  for (const m of text.matchAll(QUOTED_RE)) {
    const path = (m[1] ?? m[2])!;
    if (ABSOLUTE_RE.test(path)) out.push({ start: m.index!, end: m.index! + m[0].length, path });
  }
  for (const m of text.matchAll(BARE_ABS_RE)) {
    const start = m.index! + m[1]!.length;
    const raw = trimEnds(m[2]!);
    // A SLASH COMMAND IS NOT A DROPPED FILE. `/mcp`, `/key`, `/model` all satisfy "starts
    // with a slash", which is the POSIX half of this pattern, so pasting a command turned
    // its first word into a file handle — and once that happened the line no longer began
    // with `/`, so it was sent to the model as a sentence instead of being run. The user
    // got a helpful reply about a command they had meant to execute.
    //
    // The distinguishing rule is the SECOND slash: a real dropped path is a path
    // (`/Users/me/notes.txt`), while a command is one word. Narrow on purpose — dropping
    // a single-segment directory as the very first thing on an otherwise empty line loses
    // its handle, and that is a rarer thing to do than pasting a command.
    if (start === 0 && raw.startsWith("/") && !raw.includes("/", 1)) continue;
    out.push({ start, end: start + m[2]!.length, path: raw });
  }
  return out.sort((x, y) => x.start - y.start);
}

interface Candidate {
  start: number; // index of the token in the source text
  end: number; // index just past the token
  raw: string; // the path text (quotes stripped, trailing punctuation trimmed)
  kind: "mention" | "path"; // mention stays visible; a path collapses to its name
}

export interface ResolvedAttachments {
  /** What the MODEL receives: the clean line plus a block per attached file. */
  modelText: string;
  /** What the CHAT shows: the typed line with dropped paths collapsed to file names. */
  displayText: string;
  /** Compact, human-facing notes (one per resolved/skipped file) — counts, no content. */
  notes: string[];
  /** Images to send with this message. Empty unless the running model can see them. */
  images: ImageRef[];
}

/**
 * Resolve every file reference in `text` (an `@mention`, a quoted path, or a bare
 * absolute path from a drag-and-drop) against `cwd`. A reference that points at a
 * readable text file is attached (full content) and noted with its line count;
 * anything that doesn't resolve to a file is left untouched (so a stray `@`, a
 * quoted phrase, or a `/` in prose never breaks a message). When nothing attaches,
 * `modelText`/`displayText` are the original text unchanged.
 */
export async function resolveAttachments(
  text: string,
  cwd: string,
  canSeeImages = false,
  labelFor?: (absPath: string) => string | undefined,
): Promise<ResolvedAttachments> {
  const candidates = findCandidates(text);
  const seen = new Set<string>();
  const blocks: string[] = [];
  const notes: string[] = [];
  const images: ImageRef[] = [];
  // Spans to collapse (dropped paths only), applied right-to-left. The chat and the model
  // get DIFFERENT labels for the same span: the chat shows the handle the user saw in the
  // input box, the model gets the file's name. Sending the model the handle gave it a word
  // (`mwimg5`) that names nothing on disk, and it went looking for `mwimg5.png`.
  const collapses: { start: number; end: number; label: string; modelLabel: string }[] = [];

  for (const c of candidates) {
    if (!c.raw) continue;
    const abs = isAbsolute(c.raw) ? resolve(c.raw) : resolve(cwd, c.raw);
    if (seen.has(abs)) continue;

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue; // not a path on disk — leave the text exactly as the user typed it
    }
    if (stat.isDirectory()) continue; // directories aren't attachable (yet)
    seen.add(abs);

    const shown = displayPath(cwd, abs);

    // Images take the vision path when the running model has eyes, and degrade to a
    // named-but-unseen note when it doesn't. Either way the file name reaches the
    // model, so it can ask about it rather than being unaware anything was shared.
    if (isImage(abs)) {
      if (c.kind === "path") collapses.push({ start: c.start, end: c.end, label: labelFor?.(abs) ?? basename(abs), modelLabel: basename(abs) });

      if (!canSeeImages) {
        notes.push(`attached image ${shown} (this model can't see images — describe it, or switch with /provider)`);
        blocks.push(
          `[The user shared an image file: ${shown}. The model you are running can't see images, so its ` +
            `contents aren't available to you — ask them to describe it if you need details.]`,
        );
        continue;
      }

      const verdict = await describeImage(abs, stat.size);
      if (isRejection(verdict)) {
        notes.push(`skipped ${shown} (${verdict.reason})`);
        blocks.push(`[The user tried to share ${shown}, but it couldn't be sent: ${verdict.reason}.]`);
        continue;
      }
      images.push(verdict);
      // Where the picture lives, so it can be opened again once its payload has been
      // cleared from context. The image block itself carries no name at all.
      blocks.push(imageSourceLine(shown));
      const size = verdict.width && verdict.height ? `${verdict.width}x${verdict.height}` : "attached";
      notes.push(`attached image ${shown} (${size})`);
      continue;
    }

    if (stat.size > MAX_BYTES) {
      notes.push(`skipped ${shown} (${formatBytes(stat.size)} — too large to attach; ask me to read a range)`);
      continue;
    }
    const buf = await fs.readFile(abs);
    if (looksBinary(buf)) {
      // Non-image binaries can't be used by a text model — say so plainly.
      notes.push(`skipped ${basename(abs)} (binary file — the model can't read it)`);
      continue;
    }

    const content = buf.toString("utf8");
    const lineCount = content.split("\n").length;
    blocks.push(`<attached_file path="${shown}">\n${content}\n</attached_file>`);
    notes.push(`attached ${shown} (+${lineCount} lines)`);
    // A dropped/quoted path is long and ugly in the chat — collapse it to the file
    // name. An `@mention` is already short, so leave it visible as typed.
    if (c.kind === "path") collapses.push({ start: c.start, end: c.end, label: labelFor?.(abs) ?? basename(abs), modelLabel: basename(abs) });
  }

  const displayText = applyCollapses(text, collapses);
  const typed = applyCollapses(text, collapses.map((c) => ({ ...c, label: c.modelLabel })));
  if (blocks.length === 0) return { modelText: typed, displayText, notes, images };
  return { modelText: `${typed}\n\n${blocks.join("\n\n")}`, displayText, notes, images };
}

/**
 * Hide attached-file payloads for display. Used when rebuilding the chat from a
 * stored transcript so a resumed session shows the typed line (paths already
 * collapsed), never the re-dumped file body.
 */
export function stripAttachments(content: string): string {
  return content
    .replace(/\n*<attached_file path="[^"]*">\n[\s\S]*?\n<\/attached_file>/g, "")
    .replace(IMAGE_SOURCE_RE, "")
    .trimEnd();
}

/** The line that tells the model where an attached image lives on disk. */
export function imageSourceLine(path: string): string {
  return `[Image source: ${path}]`;
}

const IMAGE_SOURCE_RE = /\n*\[Image source: [^\]\n]*\]/g;

/** Gather every file-reference token (mentions, quoted paths, bare absolute paths),
 *  sorted by position; quoted/bare ranges never overlap (a quote isn't a path char
 *  and bare paths require a leading word boundary). */
function findCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index! + m[1]!.length;
    out.push({ start, end: start + 1 + m[2]!.length, raw: trimEnds(m[2]!), kind: "mention" });
  }
  for (const m of text.matchAll(QUOTED_RE)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, raw: (m[1] ?? m[2])!, kind: "path" });
  }
  for (const m of text.matchAll(BARE_ABS_RE)) {
    const start = m.index! + m[1]!.length;
    out.push({ start, end: start + m[2]!.length, raw: trimEnds(m[2]!), kind: "path" });
  }

  return out.sort((a, b) => a.start - b.start);
}

/** Splice collapse-spans into shorter labels, right-to-left so earlier indices hold. */
function applyCollapses(text: string, spans: { start: number; end: number; label: string }[]): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.label + out.slice(s.end);
  }
  return out;
}

/** Trim sentence punctuation a path token shouldn't end with: `foo.ts,` → `foo.ts`. */
function trimEnds(s: string): string {
  return s.replace(/[.,;:!?)\]}'"]+$/, "");
}

/** Path relative to cwd when it sits beneath it (reads naturally), else absolute. */
function displayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..")) return abs;
  return rel.split("\\").join("/");
}

/** A NUL byte in the first chunk is a cheap, reliable "not text" signal. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
