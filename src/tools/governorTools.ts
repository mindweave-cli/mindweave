/**
 * governorTools.ts — the model's hands on the governor: make a rule, forbid a path.
 *
 * These let natural language work: "make it a rule to use pnpm" → remember_rule;
 * "never touch src/legacy" → forbid_path. Each persists the change to the
 * project's state dir (so it survives restarts and applies in every future
 * session here) AND mirrors it into the live `ctx.governance` so it takes effect
 * this turn — a new rule is injected next prompt, a new forbidden path is enforced
 * by edit/write/run immediately. Deciding WHAT to make a rule/forbid is the
 * user's call relayed by the model; these tools only record it.
 */
import type { Tool, ToolResult } from "./types.js";
import { isMcpToolName } from "../mcp/catalog.js";
import {
  writeRule,
  appendForbidden,
  appendForbiddenCommand,
  appendForbiddenMcpTool,
  deriveRuleName,
  slugify,
  writeSkill,
  removeRule,
  removeSkill,
  removeForbiddenPath,
  removeForbiddenCommand,
  removeForbiddenMcpTool,
} from "../governor/write.js";
import { rescope } from "../governor/scope.js";
import { parseGlobs } from "../governor/rules.js";
import { failQuietly } from "./results.js";

/** The project root for state files: the fixed session root, carried on the
 *  governance config (cwd may have moved via `cd`; the root never does). */
function projectRoot(ctx: { cwd: string; governance?: { forbidden: { root: string } } }): string {
  return ctx.governance?.forbidden.root ?? ctx.cwd;
}

// ── the four actions, as plain functions ──────────────────────────────────────
// They were four TOOLS until an audit measured what that cost: four near-identical
// schemas, one domain, one approval flow, ~1000 advertised tokens on every uncached
// request, and four overlapping descriptions for the model to choose between. The
// logic below is unchanged; only the way it is offered to the model is.

type Ctx = Parameters<Tool["execute"]>[1];

async function doRememberRule(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const body = typeof args.value === "string" ? args.value.trim() : "";
  if (!body) return failQuietly("`value` is required — the rule text.");
  const name = (typeof args.name === "string" && args.name.trim()) || deriveRuleName(body);
  const globs = parseGlobs(typeof args.globs === "string" ? args.globs : undefined);

  const saved = await writeRule(projectRoot(ctx), name, body, "", globs);
  // Mirror into the live session so the rule is in the very next prompt.
  //
  // Deduplicate by SLUG, not by the display name. The rule FILE is `<slug>.md`, so
  // "Use pnpm" and "use pnpm!" are one rule on disk and were two in memory: the
  // session showed both, the next session showed one, and the user watched a rule
  // they had just set disappear on restart. Matching how the file is keyed is what
  // keeps the live list and the disk agreeing.
  if (ctx.governance) {
    const slug = slugify(saved.name);
    ctx.governance.rules = [...ctx.governance.rules.filter((r) => slugify(r.name) !== slug), saved];
    // A brand-new scoped rule never saw the paths this session already worked in, and
    // scoping is decided at touch time — so without this it would sit inert until the
    // model happened to touch a matching file again.
    if (ctx.ruleScope) rescope(ctx.ruleScope, ctx.governance.rules);
  }
  const scope = globs.length > 0 ? ` (scoped to ${globs.join(", ")})` : "";
  return {
    output: `Saved rule '${saved.name}'${scope}. It now applies to this project (this session and future ones).`,
    summary: `saved rule '${saved.name}'`,
  };
}

async function doForbidPath(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const pattern = typeof args.value === "string" ? args.value.trim() : "";
  if (!pattern) return failQuietly("`value` is required — the path glob to forbid.");

  const result = await appendForbidden(projectRoot(ctx), pattern);
  if (!result.pattern) return failQuietly("the pattern is empty after normalization.");

  // Mirror into the live forbidden config (new array → matcher recompiles).
  if (ctx.governance && result.added) {
    ctx.governance.forbidden = {
      ...ctx.governance.forbidden,
      patterns: [...ctx.governance.forbidden.patterns, result.pattern],
    };
  }
  return {
    output: result.added
      ? `Forbidden '${result.pattern}'. I won't modify it or run commands against it.`
      : `'${result.pattern}' was already forbidden.`,
    summary: result.added ? `forbade '${result.pattern}'` : `'${result.pattern}' already forbidden`,
  };
}

async function doForbidCommand(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const pattern = typeof args.value === "string" ? args.value.trim() : "";
  if (!pattern) return failQuietly("`value` is required — the command to forbid.");

  const result = await appendForbiddenCommand(projectRoot(ctx), pattern);
  if (!result.pattern) return failQuietly("the pattern is empty after normalization.");

  // Mirror into the live forbidden config (new array → enforced this turn on).
  if (ctx.governance && result.added) {
    ctx.governance.forbidden = {
      ...ctx.governance.forbidden,
      commands: [...(ctx.governance.forbidden.commands ?? []), result.pattern],
    };
  }
  return {
    output: result.added
      ? `Forbidden the command '${result.pattern}'. I won't run it (or anything containing it) unless you lift it.`
      : `'${result.pattern}' was already forbidden.`,
    summary: result.added ? `forbade command '${result.pattern}'` : `'${result.pattern}' already forbidden`,
  };
}

async function doForbidMcpTool(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const name = typeof args.value === "string" ? args.value.trim() : "";
  if (!name) return failQuietly("`value` is required — the full MCP tool name.");
  // Guarding the shape matters: a bare tool name would be written to disk, never
  // match anything, and look like the ban silently failed.
  if (!isMcpToolName(name)) {
    return failQuietly(`'${name}' is not an MCP tool name. Use the full name from your tool list, e.g. 'mcp__github__create_issue'.`);
  }

  const result = await appendForbiddenMcpTool(projectRoot(ctx), name);
  if (!result.pattern) return failQuietly("the name is empty after normalization.");

  // Mirror into the live config AND the live pool, so the ban takes effect on the
  // next step rather than the next session.
  if (ctx.governance && result.added) {
    ctx.governance.forbidden = {
      ...ctx.governance.forbidden,
      mcpTools: [...(ctx.governance.forbidden.mcpTools ?? []), result.pattern],
    };
    ctx.mcp?.setForbidden(ctx.governance.forbidden.mcpTools ?? []);
  }
  return {
    output: result.added
      ? `Forbidden the MCP tool '${result.pattern}'. It's no longer available to me unless you lift it.`
      : `'${result.pattern}' was already forbidden.`,
    summary: result.added ? `forbade '${result.pattern}'` : `'${result.pattern}' already forbidden`,
  };
}

// ── lifting what was recorded ────────────────────────────────────────────────
// Every standing decision could be MADE and none could be taken back, so "drop that
// rule" or "you can run that again" meant the user editing files under .mindweave/ by
// hand. Each of these reports a MISS as a miss: lifting something that was never
// recorded says so, rather than claiming a change that did not happen.

async function doForgetRule(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const name = typeof args.value === "string" ? args.value.trim() : "";
  if (!name) return failQuietly("`value` is required — the rule's name.");
  const gone = await removeRule(projectRoot(ctx), name);
  // The live session drops it too, so the very next turn is built without it.
  if (ctx.governance && gone) {
    const slug = slugify(name);
    ctx.governance.rules = ctx.governance.rules.filter((r) => slugify(r.name) !== slug);
    if (ctx.ruleScope) rescope(ctx.ruleScope, ctx.governance.rules);
  }
  return gone
    ? { output: `Dropped rule '${name}'. It no longer applies, from this turn on.`, summary: `dropped rule '${name}'` }
    : failQuietly(`No rule named '${name}'. The rules in force are in your context; use the name shown there.`);
}

async function doUnforbidPath(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const pattern = typeof args.value === "string" ? args.value.trim() : "";
  if (!pattern) return failQuietly("`value` is required — the forbidden path pattern to lift.");
  const normalized = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  const gone = await removeForbiddenPath(projectRoot(ctx), pattern);
  if (ctx.governance && gone) {
    ctx.governance.forbidden = {
      ...ctx.governance.forbidden,
      patterns: ctx.governance.forbidden.patterns.filter((p) => p !== normalized),
    };
  }
  return gone
    ? { output: `'${normalized}' is no longer protected — I can edit it again.`, summary: `unforbade '${normalized}'` }
    : failQuietly(`'${pattern}' is not in the forbidden list, so there was nothing to lift.`);
}

async function doUnforbidCommand(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const pattern = typeof args.value === "string" ? args.value.trim() : "";
  if (!pattern) return failQuietly("`value` is required — the forbidden command to lift.");
  const gone = await removeForbiddenCommand(projectRoot(ctx), pattern);
  if (ctx.governance && gone) {
    ctx.governance.forbidden = {
      ...ctx.governance.forbidden,
      commands: (ctx.governance.forbidden.commands ?? []).filter((c) => c !== pattern),
    };
  }
  return gone
    ? { output: `'${pattern}' is no longer forbidden — I can run it again.`, summary: `unforbade command '${pattern}'` }
    : failQuietly(`'${pattern}' is not in the forbidden commands, so there was nothing to lift.`);
}

async function doUnforbidMcpTool(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const name = typeof args.value === "string" ? args.value.trim() : "";
  if (!name) return failQuietly("`value` is required — the full MCP tool name to lift.");
  const gone = await removeForbiddenMcpTool(projectRoot(ctx), name);
  if (ctx.governance && gone) {
    const mcpTools = (ctx.governance.forbidden.mcpTools ?? []).filter((t) => t !== name);
    ctx.governance.forbidden = { ...ctx.governance.forbidden, mcpTools };
    ctx.mcp?.setForbidden(mcpTools);
  }
  return gone
    ? { output: `'${name}' is available to me again.`, summary: `unforbade '${name}'` }
    : failQuietly(`'${name}' is not in the forbidden MCP tools, so there was nothing to lift.`);
}

const ACTIONS = {
  remember_rule: doRememberRule,
  forbid_path: doForbidPath,
  forbid_command: doForbidCommand,
  forbid_mcp_tool: doForbidMcpTool,
  forget_rule: doForgetRule,
  unforbid_path: doUnforbidPath,
  unforbid_command: doUnforbidCommand,
  unforbid_mcp_tool: doUnforbidMcpTool,
} as const;

export type GovernorAction = keyof typeof ACTIONS;

export const governor: Tool = {
  name: "governor",
  deferred: true,
  readOnly: false,
  keywords: ["rule", "rules", "remember", "forget", "policy", "standing", "forbid", "unforbid", "ban", "unban", "allow", "never", "always"],
  // Each action keeps the ONE warning that changes what the model does, and loses the
  // rest. The dropped prose explained things the tool already reports in its own reply
  // (that a duplicate is harmless, that a refusal can be lifted), which is a worse
  // place to learn it than the reply itself and was being paid for every turn.
  description:
    "Record a standing decision for THIS project. Persists across sessions and takes " +
    "effect immediately. Pass `action` and `value`:\n" +
    "- remember_rule — a durable directive to follow here ('Use pnpm, never npm'). " +
    "Injected into your context EVERY turn from now on, so prefer few sharp rules; " +
    "pass `globs` to scope one to matching files instead. Write it as a standing " +
    "instruction, not a note about now. Reusing a `name` replaces that rule.\n" +
    "- forbid_path — a file/folder/glob that must never be MODIFIED ('src/legacy/**'). " +
    "It can still be read and searched; this protects against changes, not against " +
    "looking.\n" +
    "- forbid_command — a command that must never be RUN ('git push --force'). Matched " +
    "as a case-insensitive substring, so a short pattern catches far more than it " +
    "looks like: forbid the specific command the user meant, not a word from it.\n" +
    "- forbid_mcp_tool — one MCP tool, by its FULL 'mcp__server__tool' name; a bare " +
    "name is rejected rather than silently matching nothing.\n" +
    "Each of those can be TAKEN BACK, which is what the user means by 'forget that rule', " +
    "'you can edit that again', 'you can run that now', 'unban that tool': forget_rule takes " +
    "the rule's name, and unforbid_path / unforbid_command / unforbid_mcp_tool take the exact " +
    "entry being lifted. Lifting something that was never recorded says so rather than " +
    "pretending it was there.\n" +
    "Use it when the user states a durable preference, says not to touch or run something, " +
    "or takes one of those back — not for a one-off instruction about the task in hand.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["action", "value"],
    properties: {
      action: {
        type: "string",
        enum: [
          "remember_rule",
          "forbid_path",
          "forbid_command",
          "forbid_mcp_tool",
          "forget_rule",
          "unforbid_path",
          "unforbid_command",
          "unforbid_mcp_tool",
        ],
        description: "What to record.",
      },
      value: {
        type: "string",
        description:
          "The rule text, path glob, command fragment, or full MCP tool name — whichever the action takes.",
      },
      name: {
        type: "string",
        description: "remember_rule only: short name for the rule; derived from the text if omitted.",
      },
      globs: {
        type: "string",
        description:
          "remember_rule only: comma-separated path globs that scope the rule to matching files " +
          "(e.g. 'src/api/**'). Omit for an always-on rule.",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    const handler = ACTIONS[action as GovernorAction];
    // Naming the valid set beats a bare "invalid action": the model corrects in one
    // step instead of guessing at the spelling.
    if (!handler) {
      return failQuietly(`\`action\` must be one of: ${Object.keys(ACTIONS).join(", ")}.`);
    }
    return handler(args, ctx);
  },
};

export const skillTool: Tool = {
  name: "skill",
  deferred: true,
  readOnly: false,
  // Two things the model could not have known: the name is normalised (so the
  // invocation it announces may not be the name it passed), and creating over an
  // existing name destroys that skill.
  keywords: ["skill", "skills", "procedure", "workflow", "playbook", "create", "delete", "remove"],
  description:
    "Create or delete a reusable skill for THIS project: a named, step-by-step procedure " +
    "that " +
    "you or the user (via /name) can run later. Use it when the user says to save a " +
    "skill, or to capture a multi-step workflow clearly worth repeating. It persists " +
    "across sessions. Pass action: 'delete' with just a name to remove one — that is " +
    "what 'drop that skill' or 'we do not need that skill any more' means.\n" +
    "Unlike a rule, a skill is CHEAP to keep: only its name and description sit in " +
    "your context, and the steps are loaded only when it runs. So prefer a skill for " +
    "anything procedural, and a rule only for something that must colour every turn.\n" +
    "The name is normalised to lowercase-with-dashes, so 'Release Process' becomes " +
    "/release-process — the result tells you the real invocation. Creating one under a " +
    "name that normalises to an existing skill REPLACES it, with no warning, so check " +
    "available_skills first if you are unsure. Write `steps` as a clear markdown " +
    "checklist for someone starting cold, and use $ARGUMENTS or $1…$9 where the " +
    "procedure needs input.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      action: {
        type: "string",
        enum: ["create", "delete"],
        description: "Default 'create'. 'delete' removes the skill named below.",
      },
      name: {
        type: "string",
        description: "Short invocation name, e.g. 'release' (becomes /release).",
      },
      description: {
        type: "string",
        description: "One line on what the skill does — shown in the catalog and used to pick it.",
      },
      steps: {
        type: "string",
        description:
          "The skill body: the procedure as markdown. May use $ARGUMENTS or $1/$2 placeholders " +
          "for arguments passed at invocation.",
      },
      when_to_use: {
        type: "string",
        description: "Optional: when you should reach for this skill.",
      },
      argument_hint: {
        type: "string",
        description: "Optional usage hint for arguments, e.g. '<env>' for /release <env>.",
      },
      globs: {
        type: "string",
        description:
          "Optional comma-separated globs that scope the skill's catalog visibility to matching " +
          "files (it stays invokable by name regardless).",
      },
    },
  },

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const description = typeof args.description === "string" ? args.description.trim() : "";
    const body = typeof args.steps === "string" ? args.steps.trim() : "";
    if (!name) return failQuietly("`name` is required.");

    if (args.action === "delete") {
      const gone = await removeSkill(projectRoot(ctx), name);
      // Out of the live catalog too, so /name stops offering it immediately.
      if (ctx.governance && gone) {
        const slug = slugify(name);
        ctx.governance.skills = ctx.governance.skills.filter((s) => slugify(s.name) !== slug);
      }
      return gone
        ? { output: `Deleted skill '${slugify(name)}'.`, summary: `deleted skill '${slugify(name)}'` }
        : failQuietly(`No skill named '${name}'. Your available skills are listed in your context.`);
    }

    if (!body) return failQuietly("`steps` is required — the skill needs a body.");

    const saved = await writeSkill(projectRoot(ctx), {
      name,
      description,
      body,
      whenToUse: typeof args.when_to_use === "string" ? args.when_to_use.trim() : "",
      argumentHint: typeof args.argument_hint === "string" ? args.argument_hint.trim() : "",
      globs: parseGlobs(typeof args.globs === "string" ? args.globs : undefined),
    });
    // Mirror into the live catalog so it can be used immediately.
    if (ctx.governance) {
      ctx.governance.skills = [
        ...ctx.governance.skills.filter((s) => s.name !== saved.name),
        saved,
      ].sort((a, b) => a.name.localeCompare(b.name));
    }
    return {
      output: `Created skill '${saved.name}'. Run it with /${saved.name} or call use_skill.`,
      summary: `created skill '${saved.name}'`,
    };
  },
};

