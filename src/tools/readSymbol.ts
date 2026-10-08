/**
 * readSymbol.ts — read one symbol's definition, not the whole file.
 *
 * The token-saving companion to read_file: when the model only needs to see one
 * function/class/method, this returns exactly that symbol's lines (located via the
 * code map's LSP `documentSymbol` range, or a tree-sitter span as a fallback)
 * instead of pulling a 2000-line file to look at 20 lines. read_file and its
 * whole-file read are unchanged — this is the surgical alternative, and WHEN to
 * reach for it stays the model's judgment.
 *
 * It also records the file as read, so a follow-up edit / replace_symbol_body
 * clears the read-before-edit gate without a redundant whole-file read.
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { relativize, resolvePath, nextTouch, markScope } from "./paths.js";
import { addFocus } from "./focus.js";
import { allChassis, symbolSpans } from "./chassisMux.js";
import { sliceBody } from "./spanCore.js";
import { fail, failQuietly } from "./results.js";
import { guardedPathReason } from "./guard.js";

// Even a single symbol can be huge (a 900-line class). Cap what we return so one
// read_symbol can't flood the context; the model can read_file a range for more.
const MAX_SYMBOL_LINES = 400;

export const readSymbolTool: Tool = {
  name: "read_symbol",
  readOnly: true,
  // The description told the model to pass `path` for an ambiguous name without saying
  // what happens if it does not: the tool LISTS the candidates rather than guessing, so
  // the first call is always safe and is itself the way to disambiguate. It also never
  // mentioned that this read satisfies the read-before-edit gate, which is the whole
  // reason it can replace a full read_file before an edit rather than merely precede one.
  description:
    "Read the full definition of a symbol (function, class, method, type, and so on) by " +
    "name: just its lines, not the whole file. Prefer this over read_file whenever you " +
    "only need one symbol, since it avoids pulling a large file in to look at a small " +
    "part of it. " +
    "THIS COUNTS AS READING THE FILE, so you can edit that symbol straight afterwards " +
    "without a separate read_file first. " +
    "If the name is defined in several files it does NOT guess: you get the candidates " +
    "with their locations, and you pick one with `path`. So calling it without `path` " +
    "first is safe, and is usually how you find out there was an ambiguity at all. " +
    `Long symbols stop after ${MAX_SYMBOL_LINES} lines and tell you where to continue ` +
    "with read_file. Without a language server the match is name-level, and it says so " +
    "when that is the case.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", description: "The symbol name to read." },
      path: {
        type: "string",
        description: "File the symbol is in (optional; disambiguates a name defined in several files).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return failQuietly("`name` is required.");
    if (allChassis(ctx).length === 0) {
      return {
        output: "The code map isn't available here — use outline, grep, and read_file instead.",
        summary: "code map unavailable",
      };
    }

    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const wantAbs = rawPath ? resolvePath(ctx, rawPath) : undefined;
    const spans = await symbolSpans(ctx, name, wantAbs ? { path: wantAbs } : {});

    if (spans.length === 0) {
      return {
        output:
          `Couldn't locate a symbol named '${name}'${rawPath ? ` in ${rawPath}` : ""}. ` +
          "Use outline to list a file's symbols, or grep for the name.",
        summary: `read_symbol ${name} — not found`,
      };
    }

    // Defined in several files → list them and ask for a path (don't guess).
    const files = new Set(spans.map((s) => s.file));
    if (files.size > 1) {
      const list = spans
        .map((s) => `${relativize(ctx, s.file)}:${s.start}-${s.end}  ${s.kind} ${s.name}`)
        .join("\n");
      return {
        output: `'${name}' is defined in several files — pass \`path\` to pick one:\n${list}`,
        summary: `read_symbol ${name} (${files.size} files)`,
      };
    }

    const span = spans[0]!;
    const abs = resolvePath(ctx, span.file);
    const blocked = await guardedPathReason(abs);
    if (blocked) return fail(`Refusing to read ${relativize(ctx, span.file)}: it is ${blocked}.`);
    let content: string;
    let stat;
    try {
      stat = await fs.stat(abs);
      content = await fs.readFile(abs, "utf8");
    } catch {
      return fail(`could not read ${relativize(ctx, span.file)}.`);
    }

    const capped = Math.min(span.end, span.start + MAX_SYMBOL_LINES - 1);
    const body = sliceBody(content, span.start, capped);
    const truncated =
      capped < span.end ? `\n… (symbol continues to line ${span.end}; read_file a range for the rest)` : "";
    const caveat =
      span.confidence === "name-level"
        ? "\n(name-level match — verify with grep if exact identity matters)"
        : "";
    const shown = relativize(ctx, span.file);

    // Record the read (ranged) so a follow-up edit clears the read-before-edit gate,
    // with recency + the symbol's span as focus (for working-set localization).
    const prior = ctx.reads.get(abs);
    const unchanged = prior?.mtimeMs === stat.mtimeMs && prior?.size === stat.size;
    markScope(ctx, abs);
    ctx.reads.set(abs, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      full: false,
      touchedAt: nextTouch(),
      focus: addFocus(prior?.focus, { start: span.start, end: span.end }),
    });

    return {
      output: `${span.kind} ${span.name} — ${shown}:${span.start}-${span.end}\n${body}${truncated}${caveat}`,
      summary: `read ${span.name} (${shown}:${span.start}-${span.end})`,
    };
  },
};

