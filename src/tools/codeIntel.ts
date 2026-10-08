/**
 * codeIntel.ts — the read-only tools that query the chassis (Mindweave's code map).
 *
 * These give the model IDE-grade navigation — outline, jump-to-definition,
 * find-references, and a relevance map — without reading or grepping blindly.
 * They query `ctx.chassis` (built by the alternator lane) and fall back to a
 * clear "use grep/read" message when it isn't available. Every result carries
 * the chassis's confidence: `name-level` answers tell the model to verify with
 * grep when exact identity matters (the assistant-not-authority rule).
 */
import { promises as fs } from "node:fs";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { relativize, resolvePath } from "./paths.js";
import { allChassis, chassisForPath, mergedDefinition, mergedReferences } from "./chassisMux.js";
import { walkFiles } from "./walk.js";
import { excludedFromSearch, guardedPathReason } from "./guard.js";
import { isSupported } from "../alternator/chassis/treesitter.js";
import { isMarkupSupported } from "../alternator/chassis/markup.js";
import type { Confidence, DirectorySummary, OutlineEntry } from "../alternator/chassis/types.js";
import { fail, failQuietly } from "./results.js";

const DIR_FILE_CAP = 40;
const REF_CAP = 100;

function indexingNote(ctx: ToolContext): string {
  return ctx.chassis?.status().ready ? "" : " (code map still indexing — may be incomplete)";
}

function caveat(confidence: Confidence): string {
  return confidence === "name-level"
    ? "\n(name-level match — verify with grep if exact identity matters)"
    : "";
}

const outlineDef: Tool = {
  name: "outline",
  readOnly: true,
  // Two things were missing, and the second one matters more than it looks. A directory
  // outline leads with a rollup (counts, the central symbols, which folders it depends
  // on) that the description never mentioned, so the model had no reason to point this
  // at a folder. And a directory outline stops after DIR_FILE_CAP files WITHOUT saying
  // so, which means a model that outlines a 200-file folder believes it has seen the
  // shape of all of it. Silent truncation is the worst kind: it looks like completeness.
  description:
    "Show the structural outline of a file: its symbols and signatures, never bodies. " +
    "Point it at a DIRECTORY and you get more than the files, you get a rollup first — " +
    "how many files and symbols it holds, which symbols are most central to it, and " +
    "which other folders it depends on. That is the fastest way to understand an " +
    "unfamiliar area, and it costs one call. " +
    `A directory outline covers at most ${DIR_FILE_CAP} files, so for anything larger ` +
    "treat it as a sample and narrow to a subfolder. Files with no symbols are left out. " +
    "Works on HTML and CSS too: it lists a page's sections and ids, and a stylesheet's " +
    "selectors, with line numbers, so you can navigate a big page instead of reading it " +
    "top to bottom.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "File or directory. Defaults to the working directory." },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (allChassis(ctx).length === 0) return degraded();
    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
    const abs = resolvePath(ctx, rawPath);
    const blocked = await guardedPathReason(abs);
    if (blocked) return fail(`Refusing to outline ${rawPath}: it is ${blocked}.`);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return fail(`path not found: ${rawPath}`);
    }

    const groups: { file: string; entries: readonly OutlineEntry[] }[] = [];
    let rollup = "";
    let dirTruncated: { shown: number; total: number } | null = null;
    if (stat.isFile()) {
      const entries = await (chassisForPath(ctx, abs)?.outline(abs) ?? Promise.resolve([]));
      groups.push({ file: abs, entries });
    } else {
      // A directory: lead with a folder rollup (counts, central symbols, deps).
      const summary = await chassisForPath(ctx, abs)?.directorySummary(abs);
      if (summary) rollup = renderDirSummary(ctx, summary);
      const { files } = await walkFiles(abs, 5000);
      // `excludedFromSearch` is what keeps secrets and other agents' data out of
      // grep and glob. outline walked the same tree without it, so the one
      // discovery tool that reads file CONTENTS to build its output was the one not
      // applying the exclusion. Same list, same walk, same rule.
      const eligible = files.filter(
        (f) => !excludedFromSearch(f.abs) && (isSupported(f.abs) || isMarkupSupported(f.abs)),
      );
      const supported = eligible.slice(0, DIR_FILE_CAP);
      // Say so when the cap bites. The description warns that a cap exists, but a
      // model reading one particular reply cannot tell whether THIS answer hit it,
      // and truncation that looks like completeness is how a partial survey gets
      // treated as the shape of the whole folder.
      if (eligible.length > supported.length) {
        dirTruncated = { shown: supported.length, total: eligible.length };
      }
      for (const f of supported) {
        const entries = (await chassisForPath(ctx, f.abs)?.outline(f.abs)) ?? [];
        if (entries.length) groups.push({ file: f.abs, entries });
      }
    }

    const outlineBody = groups
      .map((g) => {
        const header = relativize(ctx, g.file);
        return `${header}\n${renderOutlineEntries(g.entries).join("\n")}`;
      })
      .join("\n\n");
    const truncNote = dirTruncated
      ? `\n\n(outlined ${dirTruncated.shown} of ${dirTruncated.total} files — this is a ` +
        `sample, not the whole folder; narrow to a subfolder to see the rest)`
      : "";
    const body = [rollup, outlineBody].filter(Boolean).join("\n\n");

    if (!body) return { output: `No symbols found in ${rawPath}.${indexingNote(ctx)}`, summary: `outline ${rawPath} (empty)` };
    return {
      output: body + truncNote + indexingNote(ctx),
      summary: `outline ${rawPath} (${groups.length} file${groups.length === 1 ? "" : "s"})`,
    };
  },
};

const definitionDef: Tool = {
  name: "definition",
  readOnly: true,
  // "the exact file:line" was an overclaim: a name defined in two files returns BOTH,
  // which is the right behaviour and needs saying, because a model told it gets THE
  // location will take the first row. The genuinely useful part was also unstated:
  // the declaration line comes back with the location, so most lookups need no read
  // at all. Same two-level certainty as references, for the same reason.
  description:
    "Find where a symbol (function, class, type, and so on) is defined, by name. " +
    "Returns file:line PLUS the declaration itself, so for most lookups you never need " +
    "to open the file; use read_symbol when you want the body. " +
    "If the name is defined in more than one place you get EVERY definition rather than " +
    "a best guess, so an ambiguous name is visible instead of silently resolved. " +
    "Certainty comes in two levels and the output says which one you got: resolved when " +
    "a language server has analyzed the file, otherwise a NAME match, which can include " +
    "an unrelated symbol that happens to share the name. " +
    "Covers HTML and CSS as well: pass a CSS class or id (e.g. \"hero-stats\") to jump " +
    "to its style rule, or an element id to find that section. " +
    "An empty result means it is not in the code map, which may still be indexing, so " +
    "fall back to grep rather than concluding the symbol does not exist.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", description: "The symbol name to locate." } },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (allChassis(ctx).length === 0) return degraded();
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return failQuietly("`name` is required.");

    const { symbols, confidence } = await mergedDefinition(ctx, name);
    if (symbols.length === 0) {
      return { output: `No definition of '${name}' in the code map.${indexingNote(ctx)} Try grep.`, summary: `definition ${name} — none` };
    }
    const body = symbols
      .map((s) => `${relativize(ctx, s.file)}:${s.line}  ${s.kind} ${s.signature ?? s.name}`)
      .join("\n");
    return { output: body + caveat(confidence) + indexingNote(ctx), summary: `definition ${name} (${symbols.length})` };
  },
};

const referencesDef: Tool = {
  name: "references",
  readOnly: true,
  // The old description read as if this were full semantic resolution. It is not, and
  // the difference decides whether the model can trust the list: refs are keyed by NAME
  // in the graph, and only files a language server has analyzed come back `resolved`.
  // The tool already prints that caveat at runtime; a model that has not been told the
  // distinction up front reads a name-level list as certainty and refactors on it.
  description:
    "Find where a symbol is used, by name. Reads PARSED code rather than raw text, so a " +
    "mention inside a comment or a string is never a match. Returns file:line locations " +
    `(up to ${REF_CAP}), not the code itself. ` +
    "There are TWO levels of certainty here and the output tells you which one you got. " +
    "When a language server has analyzed the files involved, the answer is resolved. " +
    "Otherwise it is a NAME match, and a different symbol that happens to share the name " +
    "in an unrelated file WILL appear in the list. When it says name-level and exact " +
    "identity matters, confirm with grep or by opening the candidates before you act. " +
    "For a CSS class or id this returns every HTML element and every script " +
    "(getElementById/querySelector/classList) that uses it, which is the cross-language " +
    "blast radius before you change a style. " +
    "An empty result means nothing in the code map references it; the map may still be " +
    "indexing, so fall back to grep rather than concluding the symbol is unused.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", description: "The symbol name to find references to." } },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (allChassis(ctx).length === 0) return degraded();
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return failQuietly("`name` is required.");

    const { refs, confidence } = await mergedReferences(ctx, name);
    if (refs.length === 0) {
      return { output: `No references to '${name}' in the code map.${indexingNote(ctx)} Try grep.`, summary: `references ${name} — none` };
    }
    const shown = refs.slice(0, REF_CAP).map((r) => `${relativize(ctx, r.file)}:${r.line}`);
    if (refs.length > REF_CAP) shown.push(`… (${refs.length - REF_CAP} more)`);
    return { output: shown.join("\n") + caveat(confidence) + indexingNote(ctx), summary: `references ${name} (${refs.length})` };
  },
};


/** Render a directory rollup: counts, its most central symbols, and folder deps. */
function renderDirSummary(ctx: ToolContext, s: DirectorySummary): string {
  const where = relativize(ctx, s.dir);
  const lines = [`${where}/ — ${s.files} file${s.files === 1 ? "" : "s"}, ${s.symbols} symbol${s.symbols === 1 ? "" : "s"}`];
  if (s.topSymbols.length) {
    lines.push(`  central: ${s.topSymbols.slice(0, 8).map((sym) => `${sym.name} (${sym.kind})`).join(", ")}`);
  }
  if (s.dependsOn.length) {
    lines.push(`  depends on: ${s.dependsOn.map((d) => `${relativize(ctx, d)}/`).join(", ")}`);
  }
  return lines.join("\n");
}

/** Render a nested outline: indent by depth, show each symbol's doc when present. */
export function renderOutlineEntries(entries: readonly OutlineEntry[], depth = 0): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const indent = "  ".repeat(depth);
    const doc = e.doc ? `  — ${e.doc}` : "";
    out.push(`  ${String(e.line).padStart(4)}  ${indent}${e.kind} ${e.name}${doc}`);
    if (e.children?.length) out.push(...renderOutlineEntries(e.children, depth + 1));
  }
  return out;
}

function degraded(): ToolResult {
  return {
    output: "The code map isn't available here — use grep, glob, and read_file instead.",
    summary: "code map unavailable",
  };
}


/**
 * These four never render a row.
 *
 * Outlining a file, resolving a definition, finding call sites, ranking what's
 * relevant — that is the agent reading its way around the code, not work done
 * TO the project. A row per lookup filled the transcript with the agent's own
 * navigation while saying nothing the user could act on; the answers show up in
 * what it goes on to say and do. The model still receives every result in full.
 *
 * Applied as a wrapper rather than a `quiet: true` on each return, because these
 * four tools have eleven return sites between them and the next one added would
 * silently start rendering again.
 */
function navigational(tool: Tool): Tool {
  return {
    ...tool,
    /**
     * Deferred, all four of them. They answer structural questions — where is this
     * defined, what calls it, what is related — which is a phase of a task rather than a
     * step in the edit loop, and four schemas is 1,257 tokens in front of the model on
     * every single request.
     *
     * Marked here rather than on each definition because it is one decision about one
     * family; splitting it four ways is four places for it to drift.
     */
    deferred: true,
    async execute(args, ctx) {
      return { ...(await tool.execute(args, ctx)), quiet: true };
    },
  };
}

export const outlineTool = navigational(outlineDef);
export const definitionTool = navigational(definitionDef);
export const referencesTool = navigational(referencesDef);
