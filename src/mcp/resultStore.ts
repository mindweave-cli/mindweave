/**
 * resultStore.ts — what to do with an MCP result that is too big, or is not text.
 *
 * A `tools/call` result goes straight into the model's context, and its size is chosen
 * by a third party. Before this file existed there was no ceiling at all: a server that
 * answered a query with two megabytes of JSON put two megabytes of JSON in the prompt,
 * and a server that returned an image put a base64 blob there instead — bytes the model
 * cannot see and pays for anyway. One such call could exhaust a turn.
 *
 * So oversized and binary payloads go to a file and the model gets a POINTER: a head
 * excerpt (for text), the path, the size, and what to do next. That is strictly more
 * useful than a truncation, because nothing is actually lost — the model can read the
 * part it needs with the tools it already has, or run a command over the file, instead
 * of being handed a fragment and no way to reach the rest.
 *
 * Files land in the project's state dir alongside `mcp-trust.json`, not in the project
 * itself: this is scratch output from an external server, and dropping it into someone's
 * working tree would show up in their `git status`.
 *
 * The decisions are pure and tested; only `spill` and `sweepOldResults` touch disk.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir } from "../memory/store.js";

/**
 * Longest result text we will put in the prompt, in characters.
 *
 * ~7K tokens at the 3.5-chars/token proxy used everywhere else in this codebase. Chosen
 * to be generous for a legitimately large answer (a long file listing, a verbose API
 * response) while still being a small fraction of any model's window, since the result
 * arrives mid-turn on top of everything else already in context.
 */
export const MAX_RESULT_CHARS = 24_000;

/** How much of an oversized result to show inline before the pointer. */
export const RESULT_HEAD_CHARS = 2_000;

/** Delete spilled results older than this. They are scratch, not history. */
export const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Where a project's spilled MCP results live. */
export function resultsDir(cwd: string): string {
  return join(projectDir(cwd), "mcp-results");
}

/**
 * File extension for a mime type (pure).
 *
 * The point is that the file opens with native tooling when someone double-clicks it —
 * a `.png` rather than a `.bin`. Unknown types fall back to the subtype when it looks
 * like an extension, because `application/x-parquet` is more useful as `.parquet` than
 * as `.bin`.
 */
export function extensionForMime(mime: string): string {
  const type = (mime || "").split(";")[0]!.trim().toLowerCase();
  const known: Record<string, string> = {
    "text/plain": "txt",
    "text/markdown": "md",
    "text/html": "html",
    "text/csv": "csv",
    "text/xml": "xml",
    "application/json": "json",
    "application/xml": "xml",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/octet-stream": "bin",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "text/tab-separated-values": "tsv",
    "text/yaml": "yaml",
    "application/yaml": "yaml",
    "application/x-yaml": "yaml",
    "application/toml": "toml",
    "application/x-ndjson": "ndjson",
    "application/x-parquet": "parquet",
    "application/vnd.apache.parquet": "parquet",
    "application/gzip": "gz",
    "application/x-tar": "tar",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "audio/flac": "flac",
  };
  // Only types on this list keep an extension of their own. The type is the server's to
  // choose, so deriving the extension from it let any MCP server save a .bat, .ps1, .hta,
  // .lnk or .js in a known folder and have its path handed to the model, and a path in a
  // reply is something the user can click open.
  return known[type] ?? "bin";
}

/** A filesystem-safe fragment of a server or tool name (pure). */
export function safeSlug(value: string): string {
  return (value || "x").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "x";
}

/**
 * Build the filename for one spilled result (pure).
 *
 * Named after what produced it, so a directory of these is readable rather than a pile
 * of hashes. The stamp keeps two calls to the same tool from overwriting each other.
 */
export function spillFileName(server: string, tool: string, mime: string, stamp: number, nonce: string): string {
  return `${safeSlug(server)}-${safeSlug(tool)}-${stamp}-${nonce}.${extensionForMime(mime)}`;
}

/** Human byte count for the pointer line (pure). */
export function humanSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/**
 * Is this text too big to hand to the model whole (pure)?
 *
 * Its own function so the threshold is testable and so callers cannot each invent their
 * own idea of "too big".
 */
export function isOversized(text: string, max = MAX_RESULT_CHARS): boolean {
  return text.length > max;
}

/**
 * What the model sees in place of an oversized result (pure).
 *
 * Deliberately a beginning plus instructions, not a middle-out truncation: the head of a
 * result is nearly always the part that says what it is, and the model needs to know
 * both that there is more and exactly how to get it. Saying "truncated" without a path
 * is how a model ends up guessing at content it could have read.
 */
export function oversizedPointer(text: string, path: string, head = RESULT_HEAD_CHARS): string {
  return (
    `${text.slice(0, head)}\n\n` +
    `[Result truncated here — it was ${humanSize(Buffer.byteLength(text, "utf8"))} ` +
    `(${text.length} characters) and the whole of it is saved at:\n${path}\n` +
    `Nothing was lost: read that file (or grep it) for the parts you need.]`
  );
}

/** What the model sees in place of a binary block (pure). */
export function binaryPointer(mime: string, bytes: number, path: string): string {
  return (
    `[${mime || "binary"} content, ${humanSize(bytes)}, saved to:\n${path}\n` +
    `It is binary, so do not try to read it as text — pass the path to a tool that ` +
    `handles that format, or give it to the user.]`
  );
}

/**
 * Write one payload to the results dir and return its path.
 *
 * Best-effort: a failed write returns null and the caller falls back to describing the
 * content rather than storing it. A server's oversized answer must not be able to fail
 * a turn through our own disk handling.
 */
export async function spill(
  cwd: string,
  server: string,
  tool: string,
  mime: string,
  body: string | Buffer,
): Promise<string | null> {
  try {
    const dir = resultsDir(cwd);
    await fs.mkdir(dir, { recursive: true });
    const nonce = Math.random().toString(36).slice(2, 8);
    const path = join(dir, spillFileName(server, tool, mime, Date.now(), nonce));
    await fs.writeFile(path, body);
    return path;
  } catch {
    return null;
  }
}

/**
 * Delete spilled results past their TTL.
 *
 * Called once per session rather than on a timer: this directory only grows when a
 * server returns something large, so sweeping on the way in is enough, and it keeps the
 * whole mechanism free of background work.
 */
export async function sweepOldResults(cwd: string, ttlMs = RESULT_TTL_MS, now = Date.now()): Promise<number> {
  try {
    const dir = resultsDir(cwd);
    const names = await fs.readdir(dir);
    let removed = 0;
    for (const name of names) {
      const path = join(dir, name);
      try {
        const stat = await fs.stat(path);
        if (now - stat.mtimeMs > ttlMs) {
          await fs.rm(path, { force: true });
          removed++;
        }
      } catch {
        // Raced with something else, or not ours to delete. Skip it.
      }
    }
    return removed;
  } catch {
    return 0; // no directory yet, which is the normal case
  }
}
