/**
 * types.ts — the governor's data contracts.
 *
 * The "governor" is the per-project control layer: the user's standing **rules**
 * (always followed), reusable **skills** (procedures loaded on demand), and the
 * **forbidden** list (paths/actions the tools must never touch). All of it is
 * scoped to one project and stored under that project's state directory — the
 * same `~/.mindweave/projects/<project>/` folder sessions already use.
 *
 * Everything here is plain JSON-friendly data on purpose. The forbidden config
 * in particular rides on `ToolContext` (which deliberately holds only plain
 * data), and the path/command checks are pure functions over it — exactly like
 * the existing `guard.ts` deny-list, just user-defined instead of built-in.
 */

/** One standing rule. Its `body` is injected into the system prompt verbatim. */
export interface Rule {
  /** Short identifier (frontmatter `name`, falling back to the filename). */
  name: string;
  /** One-line summary (frontmatter `description`) — for listing/management. */
  description: string;
  /** The rule text the model must follow. */
  body: string;
  /**
   * Optional path globs (frontmatter `globs`) that SCOPE the rule: when present,
   * it's injected only on turns whose working set touches a matching file —
   * "fires when the work heads that way." Absent/empty ⇒ always-on (the default).
   */
  globs?: string[];
}

/**
 * A skill the model can run. Only this lightweight metadata sits in context at
 * all times (progressive disclosure); the full `SKILL.md` body is read from
 * `dir` only when the skill is actually invoked.
 */
export interface SkillMeta {
  /** Invocation name (the skill directory name) — used as `/name` and by use_skill. */
  name: string;
  /** What the skill does — shown in the catalog and used by the model to pick it. */
  description: string;
  /** When the model should reach for it (frontmatter `when_to_use`). "" if unset. */
  whenToUse: string;
  /** Absolute path to the skill's directory (holds SKILL.md + any bundled files). */
  dir: string;
  /**
   * Optional argument hint (frontmatter `argument-hint`) shown in the catalog,
   * e.g. "<env>" for `/deploy <env>`. Display only. "" if unset.
   */
  argumentHint?: string;
  /**
   * Optional path globs (frontmatter `globs`/`paths`) that SCOPE the skill's
   * visibility in the catalog: when present, it's listed only on turns whose
   * working set touches a matching file. Absent ⇒ always listed. Either way the
   * skill stays invokable by name (use_skill / `/name`).
   */
  globs?: string[];
}

/**
 * The forbidden configuration: plain data, carried on `ToolContext`. `patterns`
 * are gitignore-ish path globs relative to `root` (the project root). The pure
 * matchers in `forbidden.ts` compile these on demand and answer "may I touch
 * this path / run this command?" — no model judgment involved.
 */
export interface ForbiddenConfig {
  patterns: string[];
  /**
   * Forbidden COMMAND patterns: shell commands (or fragments) run_command must
   * never execute — e.g. `tauri dev`, `git push`, `npm run deploy`. Matched as a
   * normalized, case-insensitive substring of the command, so `tauri dev` blocks
   * `npm run tauri dev` too. This is the action-prohibition half of "forbidden"
   * (paths are the file half); both are enforced mechanically, not by prompt. The
   * model cannot bypass a match — only the user can lift it (the approval channel).
   * Optional so path-only configs stay valid; treated as [] when absent.
   */
  commands?: string[];
  /**
   * Forbidden MCP TOOL names (`mcp__<server>__<tool>`), the third prohibition half:
   * paths are files, commands are shell actions, these are external integrations. An
   * MCP tool is third-party code the user pointed at, so being able to say "never that
   * one" without dropping the whole server is the difference between using a server and
   * not. Enforced by exclusion from the catalog, so a forbidden tool is never
   * advertised, searched, activated or dispatched. Optional; treated as [] when absent.
   */
  mcpTools?: string[];
  root: string;
}

/** Everything the governor loads for a project, assembled once at session start. */
export interface Governance {
  rules: Rule[];
  skills: SkillMeta[];
  forbidden: ForbiddenConfig;
  /**
   * Kinds of action (tool names) Sentinel mode does not ask about, set by the user as a
   * standing decision, for this project or for every project. The saved sibling of
   * `ToolContext.guardAllowed`, which only lasts the session.
   */
  sentinelAllow?: string[];
  /**
   * One-shot, user-facing lines from a governance DECISION rather than a tool
   * result — today just "a forbidden pattern was lifted for this session."
   * Pushed by approval.ts, drained by the UI the same way MCP's manager drains
   * its own `notices` (see mcp/manager.ts's `takeNotices`); each is shown once.
   */
  notices?: string[];
  /**
   * Forbidden patterns the USER lifted for this session (approval.ts), which live only
   * in memory — the on-disk rule is deliberately left intact.
   *
   * Kept because governance is re-read when its files change: a reload rebuilds the
   * deny-list from disk, and without this list it would silently restore a pattern the
   * user had just allowed. Re-applied after every reload.
   */
  lifted?: string[];
  /**
   * The user's own auto-compaction bar, in tokens — replaces the model-derived default
   * from dynamo/contextWindow.ts when set. Project wins over the universal value, same
   * override rule as rules and skills. Undefined means "no override": the model default
   * applies, same as before this existed.
   */
  contextAutoCompactTokens?: number;
}
