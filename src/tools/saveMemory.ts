/**
 * saveMemory.ts — the model's hands on Mindweave's cross-session memory.
 *
 * When the model learns something durable worth keeping past this conversation —
 * project context to continue from next time, who the user is, how they want work
 * done, a pointer to an external system — it calls `save_memory`. Saving is silent
 * and automatic: memory is non-destructive, and the user asked NOT to be made to
 * choose yes/no for it. The model just records what's worth keeping and tells the
 * user briefly in chat; deciding WHAT to keep (and keeping universal/cross-project
 * facts rare) is the model's judgment, guided by the prompt.
 *
 * This is distinct from `remember_rule` (a standing project directive the tools
 * enforce) and from MINDWEAVE.md (the project's own knowledge file the model maintains
 * in the project root via the file tools).
 */
import type { Tool, ToolResult } from "./types.js";
import { isMemoryType, MEMORY_TYPES, saveMemory as persist } from "../memory/autoMemory.js";
import { failQuietly } from "./results.js";

/** The fixed session root state files are filed under (cwd may have moved via cd). */
function projectRoot(ctx: { cwd: string; governance?: { forbidden: { root: string } } }): string {
  return ctx.governance?.forbidden.root ?? ctx.cwd;
}

export const saveMemoryTool: Tool = {
  name: "save_memory",
  deferred: true,
  readOnly: false,
  description:
    "Save something TRUE that you want future conversations to have. How the user wants work done, and how to behave, " +
    "is a lesson (the lesson tool), not a memory; how the project works goes in MINDWEAVE.md. " +
    "Use type 'project' for context to continue this project from next time (a goal, " +
    "decision, or where things stand) that isn't in the code or MINDWEAVE.md. Use 'user'/" +
    "'feedback'/'reference' ONLY for genuinely UNIVERSAL, cross-project facts — who the " +
    "user is, or an external pointer — and only " +
    "when you judge it will matter beyond this one project; do not save universal facts " +
    "from routine project work. Do NOT use it for things derivable from the code, git " +
    "history, or MINDWEAVE.md, or for ephemeral task state. Saving is automatic and silent — " +
    "it does NOT prompt the user, so just save and mention it briefly in chat. Saving the " +
    "same name again updates that memory instead of duplicating it — names are matched " +
    "loosely (case and punctuation are ignored, and only the first 60 characters " +
    "count), so reuse the exact earlier name when you mean to revise one, and pick a " +
    "name that differs EARLY when you mean a new one. You are told if a save " +
    "overwrote a differently-named memory.\n" +
    "Write the body for a stranger, not for this conversation: it is read back with " +
    "none of the surrounding context, so name the files, commands and decisions in " +
    "full rather than referring to \"the fix\" or \"what we discussed\". Only the " +
    "index_line is loaded every session; the body is fetched on demand, so put the " +
    "detail in the body and keep the hook short.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "type", "body", "index_line"],
    properties: {
      name: {
        type: "string",
        description: "Short topic name for the memory, e.g. 'user-role' or 'release-process'.",
      },
      description: {
        type: "string",
        description:
          "One specific line describing the memory — used later to judge whether it is relevant.",
      },
      type: {
        type: "string",
        enum: [...MEMORY_TYPES],
        description: "user | feedback | project | reference.",
      },
      body: {
        type: "string",
        description:
          "The memory itself. For 'feedback' and 'project', lead with the fact/rule, then a " +
          "'Why:' line and a 'How to apply:' line. Convert relative dates to absolute.",
      },
      index_line: {
        type: "string",
        description: "A one-line hook for the MEMORY.md index (kept short, under ~120 characters).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = str(args.name);
    const description = str(args.description);
    const body = str(args.body);
    const indexLine = str(args.index_line);
    if (!name) return failQuietly("`name` is required.");
    if (!body) return failQuietly("`body` is required — the memory needs content.");
    if (!isMemoryType(args.type)) {
      return failQuietly(`\`type\` must be one of: ${MEMORY_TYPES.join(", ")}.`);
    }

    // Save directly — no confirmation. Memory is non-destructive and the user does
    // not want to be prompted; the model just keeps what's worth keeping and says so.
    const saved = await persist(projectRoot(ctx), {
      name,
      description,
      type: args.type,
      body,
      indexLine: indexLine || description,
    });
    // A name that slugs onto an existing memory's file REPLACES it. That is the one
    // way saving is destructive, so it is stated rather than reported as an update.
    if (saved.replaced) {
      return {
        output:
          `Saved memory '${saved.name}', but it OVERWROTE the existing memory ` +
          `'${saved.replaced}' — both names reduce to the same file (${saved.file}). ` +
          `If '${saved.replaced}' was still wanted, save it again under a name that ` +
          `differs within its first 60 characters, and tell the user it was lost.`,
        summary: `saved '${saved.name}', replaced '${saved.replaced}'`,
      };
    }
    return {
      output: saved.updated
        ? `Updated memory '${saved.name}'. It will be available in future sessions.`
        : `Saved memory '${saved.name}'. It will be available in future sessions.`,
      summary: saved.updated ? `updated memory '${saved.name}'` : `saved memory '${saved.name}'`,
    };
  },
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

