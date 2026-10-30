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
  removeRuleFile,
  removeSkillDir,
  removeForbiddenPath,
  removeForbiddenCommand,
  removeForbiddenMcpTool,
} from "../governor/write.js";
import { rescope } from "../governor/scope.js";
import { parseGlobs } from "../governor/rules.js";
import { fail, failQuietly } from "./results.js";
import { resolveEntry } from "./resolveName.js";
import { loadRules } from "../governor/rules.js";
import { loadSkillCatalog } from "../governor/skills.js";
import { loadPermissionLists, type GovernanceScope } from "../governor/index.js";
import { projectDir, stateRoot } from "../memory/store.js";

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

/**
 * Ask the user before a change to what binds every later session: saving or dropping a
 * rule, creating or deleting a skill, or lifting a protection. Returns null when they
 * agreed, or the result to hand back instead.
 *
 * A rule is sent on every request as the user's own binding instruction, and a skill is
 * followed as written. Without this, ONE injected instruction (a web page, a README, a
 * tool result) could become a permanent rule every future session obeys as the user's,
 * or quietly lift a path the user had forbidden. The tool's text always said the user
 * decides; this is what makes that true. Adding a protection only restricts, so it does
 * not ask. With nobody to ask (a sub-agent), the change is refused.
 */
async function confirmStanding(ctx: Ctx, question: string, detail: string): Promise<ToolResult | null> {
  if (!ctx.requestApproval) {
    return failQuietly(
      "Not done: this changes what applies to every later session, which needs the user's agreement, " +
        "and there is no way to ask from here. Say what you would change in your result instead.",
    );
  }
  const choice = await ctx.requestApproval(question, ["Yes", "No"], detail, "Standing change");
  if (choice.startsWith("Yes")) return null;
  return { output: "The user declined; nothing was changed.", summary: "declined by the user" };
}

/** Most rules the agent may have proposed at once, and the longest one. */
export const MAX_AGENT_RULES = 20;
export const MAX_AGENT_RULE_CHARS = 1000;

async function doRememberRule(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const body = typeof args.value === "string" ? args.value.trim() : "";
  if (!body) return failQuietly("`value` is required — the rule text.");
  const name = (typeof args.name === "string" && args.name.trim()) || deriveRuleName(body);
  const globs = parseGlobs(typeof args.globs === "string" ? args.globs : undefined);
  const where = globs.length > 0 ? `files matching ${globs.join(", ")}` : "every request";
  // Agent-made rules are capped in size and number: each one is read back as the user's binding instruction in
  // every later session, so a runaway or injected stream of them must run out of room. A rule the user wrote by
  // hand has no origin line and is not counted. Re-stating an existing rule (same slug) is not a new one.
  if (body.length > MAX_AGENT_RULE_CHARS) {
    return failQuietly(
      `Not saved: a rule is at most ${MAX_AGENT_RULE_CHARS} characters (this one is ${body.length}). Say it shorter.`,
    );
  }
  const slugOfName = slugify(name);
  const agentRules = (ctx.governance?.rules ?? []).filter((r) => r.origin && slugify(r.name) !== slugOfName);
  if (agentRules.length >= MAX_AGENT_RULES) {
    return failQuietly(
      `Not saved: there are already ${MAX_AGENT_RULES} rules you proposed. Ask the user which to drop, ` +
        `or tell them to edit the rules folder themselves.`,
    );
  }
  const declined = await confirmStanding(
    ctx,
    `Save this as a standing rule for this project? It will apply to ${where}, in this session and future ones.`,
    `${name}\n\n${body}`,
  );
  if (declined) return declined;

  const origin = `agent, confirmed by the user ${new Date().toISOString().slice(0, 10)}`;
  const saved = await writeRule(projectRoot(ctx), name, body, "", globs, origin);
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

/** A line for a list of rules the model can pick from: the name, which scope it is in, and the start of its text. */
const ruleLine = (r: { name: string; body: string }, scope: GovernanceScope): string =>
  `  - ${r.name} (${scope === "global" ? "yours, for every project" : "this project"}): ${r.body.replace(/\s+/g, " ").slice(0, 90)}`;

/** Every rule on disk, the user's own for every project and this project's, each with where it lives. */
async function rulesOnDisk(ctx: Ctx) {
  const cwd = projectRoot(ctx);
  const [mine, here] = await Promise.all([loadRules(stateRoot()), loadRules(projectDir(cwd))]);
  return [...mine.map((rule) => ({ rule, scope: "global" as GovernanceScope })), ...here.map((rule) => ({ rule, scope: "project" as GovernanceScope }))];
}

async function doForgetRule(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  const asked = typeof args.value === "string" ? args.value.trim() : "";
  if (!asked) return failQuietly("`value` is required — the rule's name, or its text.");
  // Found by its name or by what it says, in this project's rules and in the user's own. The rules block shows a rule's TEXT, so
  // asking for an exact name the model was never given is what used to fail, three times in a row.
  const all = await rulesOnDisk(ctx);
  const found = resolveEntry(all, asked, (x) => [x.rule.name, x.rule.description, x.rule.body]);
  if (found.kind === "none") {
    return fail(
      all.length === 0
        ? "There are no standing rules to drop."
        : `No rule matches that. The rules that exist:\n${all.map((x) => ruleLine(x.rule, x.scope)).join("\n")}\nUse one of these names.`,
    );
  }
  if (found.kind === "many") {
    return fail(`That matches more than one rule; say which by its name:\n${found.items.map((x) => ruleLine(x.rule, x.scope)).join("\n")}`);
  }
  const { rule, scope } = found.item;
  const where = scope === "global" ? "one of your own, which applies in EVERY project" : "this project's";
  const declined = await confirmStanding(ctx, `Drop the standing rule '${rule.name}' (${where})?`, rule.body);
  if (declined) return declined;
  const gone = rule.file ? await removeRuleFile(projectRoot(ctx), scope, rule.file) : false;
  // The live session drops it too, so the very next turn is built without it.
  if (ctx.governance && gone) {
    ctx.governance.rules = ctx.governance.rules.filter((r) => r.name !== rule.name || r.body !== rule.body);
    if (ctx.ruleScope) rescope(ctx.ruleScope, ctx.governance.rules);
  }
  return gone
    ? {
        output: `Dropped rule '${rule.name}'${scope === "global" ? " (it applied in every project, and no longer does anywhere)" : ""}. It no longer applies, from this turn on.`,
        summary: `dropped rule '${rule.name}'`,
      }
    : fail(`The rule '${rule.name}' could not be removed (its file is gone or cannot be deleted).`);
}

/** What one lifting action works on: which list it is, how it is said, and how it is taken out of the live session. */
type Lift = {
  noun: string;
  list: (l: Awaited<ReturnType<typeof loadPermissionLists>>) => string[];
  remove: (cwd: string, entry: string, scope: GovernanceScope) => Promise<boolean>;
  question: (entry: string, scope: GovernanceScope) => string;
  forget: (ctx: Ctx, entry: string) => void;
  done: (entry: string) => ToolResult;
};

/**
 * Take one thing back from a deny-list (impure). The entry is found by what the person would call it, in this project's list and in
 * the user's own that applies everywhere, and removed from the list it is in: lifting something the user forbade for every project
 * used to report "not in the list" because only the project's was looked at.
 */
async function liftEntry(args: Record<string, unknown>, ctx: Ctx, how: Lift): Promise<ToolResult> {
  const asked = typeof args.value === "string" ? args.value.trim() : "";
  if (!asked) return failQuietly(`\`value\` is required — the ${how.noun} to lift.`);
  // Nobody to ask: refused before anything is looked up, so a message that is not the person's cannot lift a protection by itself.
  if (!ctx.requestApproval) return (await confirmStanding(ctx, "", asked))!;
  const cwd = projectRoot(ctx);
  const [here, mine] = await Promise.all([loadPermissionLists(cwd, "project"), loadPermissionLists(cwd, "global")]);
  const all = [
    ...how.list(mine).map((entry) => ({ entry, scope: "global" as GovernanceScope })),
    ...how.list(here).map((entry) => ({ entry, scope: "project" as GovernanceScope })),
  ];
  const listed = all.map((x) => `  - ${x.entry} (${x.scope === "global" ? "yours, for every project" : "this project"})`).join("\n");
  const found = resolveEntry(all, asked, (x) => [x.entry]);
  if (found.kind === "none") return fail(all.length === 0 ? `Nothing is recorded as a ${how.noun}, so there was nothing to lift.` : `No ${how.noun} matches that. The ones recorded:\n${listed}`);
  if (found.kind === "many") return fail(`That matches more than one ${how.noun}; give the exact one:\n${found.items.map((x) => `  - ${x.entry}`).join("\n")}`);
  const { entry, scope } = found.item;
  const declined = await confirmStanding(ctx, how.question(entry, scope), entry);
  if (declined) return declined;
  const gone = await how.remove(cwd, entry, scope);
  if (gone) how.forget(ctx, entry);
  return gone ? how.done(entry) : fail(`'${entry}' could not be removed from the list.`);
}

const scopeNote = (scope: GovernanceScope): string => (scope === "global" ? " (your own, for every project)" : "");

async function doUnforbidPath(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  return liftEntry(args, ctx, {
    noun: "protected path",
    list: (l) => l.paths,
    remove: removeForbiddenPath,
    question: (e, s) => `Lift the protection on '${e}'${scopeNote(s)}, so it can be edited again?`,
    forget: (c, e) => {
      if (c.governance) c.governance.forbidden = { ...c.governance.forbidden, patterns: c.governance.forbidden.patterns.filter((p) => p !== e) };
    },
    done: (e) => ({ output: `'${e}' is no longer protected — I can edit it again.`, summary: `unforbade '${e}'` }),
  });
}

async function doUnforbidCommand(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  return liftEntry(args, ctx, {
    noun: "forbidden command",
    list: (l) => l.commands,
    remove: removeForbiddenCommand,
    question: (e, s) => `Allow the forbidden command '${e}'${scopeNote(s)} to run again?`,
    forget: (c, e) => {
      if (c.governance) c.governance.forbidden = { ...c.governance.forbidden, commands: (c.governance.forbidden.commands ?? []).filter((x) => x !== e) };
    },
    done: (e) => ({ output: `'${e}' is no longer forbidden — I can run it again.`, summary: `unforbade command '${e}'` }),
  });
}

async function doUnforbidMcpTool(args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  return liftEntry(args, ctx, {
    noun: "forbidden MCP tool",
    list: (l) => l.mcpTools,
    remove: removeForbiddenMcpTool,
    question: (e, s) => `Make the forbidden MCP tool '${e}'${scopeNote(s)} available again?`,
    forget: (c, e) => {
      if (!c.governance) return;
      const mcpTools = (c.governance.forbidden.mcpTools ?? []).filter((x) => x !== e);
      c.governance.forbidden = { ...c.governance.forbidden, mcpTools };
      c.mcp?.setForbidden(mcpTools);
    },
    done: (e) => ({ output: `'${e}' is available to me again.`, summary: `unforbade '${e}'` }),
  });
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
    "the rule's name OR its text (you are shown the text: pass it as it reads, or a distinctive part of it), and " +
    "unforbid_path / unforbid_command / unforbid_mcp_tool take the entry being lifted, or a distinctive part of it. " +
    "They are found among this project's and the user's own that apply everywhere, the user is asked first and told " +
    "which it is, and if nothing matches the answer lists what exists, by name: use one of those. " +
    "Lifting something that was never recorded says so rather than pretending it was there.\n" +
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
      // By name or by what it says, among this project's skills and the user's own for every project.
      const cwd = projectRoot(ctx);
      const [mine, here] = await Promise.all([loadSkillCatalog(stateRoot()), loadSkillCatalog(projectDir(cwd))]);
      const all = [...mine.map((skill) => ({ skill, scope: "global" as GovernanceScope })), ...here.map((skill) => ({ skill, scope: "project" as GovernanceScope }))];
      const line = (x: { skill: { name: string; description: string }; scope: GovernanceScope }) =>
        `  - ${x.skill.name} (${x.scope === "global" ? "yours, for every project" : "this project"}): ${x.skill.description.slice(0, 80)}`;
      const found = resolveEntry(all, name, (x) => [x.skill.name, x.skill.description]);
      if (found.kind === "none") {
        return fail(all.length === 0 ? "There are no skills to delete." : `No skill matches that. The skills that exist:\n${all.map(line).join("\n")}\nUse one of these names.`);
      }
      if (found.kind === "many") return fail(`That matches more than one skill; say which by its name:\n${found.items.map(line).join("\n")}`);
      const { skill, scope } = found.item;
      const declinedDelete = await confirmStanding(
        ctx,
        `Delete the skill '${skill.name}' (${scope === "global" ? "one of your own, available in EVERY project" : "this project's"})?`,
        skill.name,
      );
      if (declinedDelete) return declinedDelete;
      const gone = await removeSkillDir(skill.dir);
      // Out of the live catalog too, so /name stops offering it immediately.
      if (ctx.governance && gone) ctx.governance.skills = ctx.governance.skills.filter((s) => s.name !== skill.name);
      return gone
        ? { output: `Deleted skill '${skill.name}'${scope === "global" ? " (it was available in every project, and no longer is anywhere)" : ""}.`, summary: `deleted skill '${skill.name}'` }
        : fail(`The skill '${skill.name}' could not be deleted (its folder is gone or cannot be removed).`);
    }

    if (!body) return failQuietly("`steps` is required — the skill needs a body.");
    const declined = await confirmStanding(
      ctx,
      `Save this as the skill '/${slugify(name)}' for this project? A skill is followed as written whenever it runs.`,
      description ? `${description}\n\n${body}` : body,
    );
    if (declined) return declined;

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

