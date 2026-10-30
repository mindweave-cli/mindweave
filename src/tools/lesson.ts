/**
 * lesson.ts — the agent keeping or dropping a lesson itself, while it works.
 *
 * Most lessons are written when the agent looks back after a turn (memory/lessonReflect.ts). This is for
 * the moment it knows already: the user said to forget one, it just saw one is wrong, or a thing it learned
 * should not wait. Nothing about it is shown to the user, and no approval is asked: a lesson changes nothing
 * in the project, ranks below everything the user wrote, and cannot loosen a permission.
 */
import type { Tool, ToolResult } from "./types.js";
import { LESSON_KINDS, isLessonKind, rankLessons, MAX_LESSON_CHARS } from "../memory/lessons.js";
import { deleteLessonOp, saveLessonOp } from "../memory/lessonOps.js";
import { failQuietly } from "./results.js";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function list(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return items.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

export const lessonTool: Tool = {
  name: "lesson",
  deferred: true,
  readOnly: true,
  description:
    "Keep, change or delete one of your lessons: how to behave when working in this project and with this user. " +
    "A fact that is simply true goes in save_memory, and how the project works goes in MINDWEAVE.md. " +
    "Use it when the user tells you to forget something you learned, when you see a lesson is wrong or no longer fits, or " +
    "when something you just learned should not wait. Lessons are also written for you in the background, so do not save " +
    "routinely. This is silent: never tell the user a lesson was saved or deleted unless they ask.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["save", "delete", "list"], description: "save (add, or change one by its id) | delete | list." },
      id: { type: "string", description: "The lesson's id, shown in brackets. Required to delete; on save it changes that lesson." },
      kind: { type: "string", enum: [...LESSON_KINDS], description: "environment | workflow | approach | understanding." },
      rule: { type: "string", description: `The lesson, plainly, at most ${MAX_LESSON_CHARS} characters.` },
      why: { type: "string", description: "What happened or what the user said." },
      from_user: { type: "boolean", description: "True when the user said this in so many words." },
      commands: { type: "array", items: { type: "string" }, description: 'The leading words of commands it is about, such as "git commit". It then comes up at that moment.' },
      files: { type: "array", items: { type: "string" }, description: "Globs from the project root of the files it is about." },
      everywhere: { type: "boolean", description: "True only when the user meant it for all their work, not this project." },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const state = ctx.lessons;
    if (!state) return failQuietly("Lessons are switched off.");
    if ((ctx.subagentDepth ?? 0) > 0) return failQuietly("Only the lead agent keeps lessons.");
    const action = str(args.action);
    if (action === "list") {
      const shown = rankLessons(state.lessons).map((l) => `- [${l.id}] (${l.kind}) ${l.rule}${l.why ? ` Why: ${l.why}` : ""}`);
      return { output: shown.join("\n") || "No lessons yet.", summary: "listed lessons", quiet: true };
    }
    if (action === "delete") {
      const id = str(args.id);
      if (!id) return failQuietly("`id` is required to delete a lesson.");
      if (!(await deleteLessonOp(state, id, str(args.why) || "deleted by the agent"))) return failQuietly(`There is no lesson '${id}'. Use action list to see them.`);
      state.wrote = true;
      return { output: `Deleted lesson '${id}'.`, summary: "deleted a lesson", quiet: true };
    }
    if (action !== "save") return failQuietly("`action` must be save, delete or list.");
    const rule = str(args.rule);
    if (!rule) return failQuietly("`rule` is required to save a lesson.");
    if (!isLessonKind(args.kind)) return failQuietly(`\`kind\` must be one of: ${LESSON_KINDS.join(", ")}.`);
    const id = str(args.id);
    const done = await saveLessonOp(state, {
      ...(id ? { id } : {}),
      kind: args.kind,
      rule,
      why: str(args.why),
      from: args.from_user === true ? "user" : "work",
      commands: list(args.commands),
      files: list(args.files),
      everywhere: args.everywhere === true,
    });
    if (!done.lesson) return failQuietly(`Not kept: ${done.refused}.`);
    state.wrote = true;
    return { output: `Kept lesson '${done.lesson.id}'.`, summary: "kept a lesson", quiet: true };
  },
};
