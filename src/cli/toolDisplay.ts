/**
 * toolDisplay.ts — map a Mindweave tool call to its display name + argument.
 *
 * A compact tool header: a bold verb-noun name and the one telling
 * argument in parens — `Update(home.html)`, `Search(refreshToken)`, `Run(npm
 * test)`. Pure, display-only (never sent to a model), and deterministic from the
 * tool name + parsed args.
 */
import { toPathList } from "../tools/pathList.js";
import { formatDuration } from "../tools/detail.js";
import { BAD, GOOD } from "./theme.js";

/** Raw tool name → the bold display name shown in the row. */
const DISPLAY_NAME: Record<string, string> = {
  read_file: "Read",
  read_symbol: "Read",
  edit: "Update",
  write_file: "Write",
  search: "Search",
  run_command: "Run",
  outline: "Map",
  definition: "Map",
  references: "Map",
  relevant: "Map",
  web_fetch: "Fetch",
  web_search: "WebSearch",
  screenshot: "WindowCapture",
  ui: "App",
  view_image: "Viewed",
  use_skill: "Skill",
  skill: "Skill",
  todo_write: "Todo",
  add_directory: "Add",
  link_workspace: "Link",
  remember_rule: "Rule",
  forbid_path: "Forbid",
  spawn_subagent: "Subagent",
  shells: "Shell",
  // Tools the redesign originally missed. Without an entry each fell through to the
  // capitalize-the-raw-name fallback and rendered as `Replace_symbol_body` —
  // snake_case in a UI that has none anywhere else. TOOL_DISPLAY_COVERAGE in
  // toolDisplay.test.ts now fails the build if a registered tool is missing here.
  replace_symbol_body: "Update",
  save_memory: "Remember",
  sessions: "Session",
  mindweave: "Mindweave",
  workspace: "Workspace",
  kill_shell: "Shell",
  mcp_server: "MCP",
  mcp_resource: "MCP",
  // "Tools", not "MCP". It searches BOTH pools — the deferred native tools and any MCP
  // catalog — and the row was reading "MCP(sessions)" for a search that loaded three of
  // Mindweave's own tools and never touched a server.
  find_tools: "Tools",
  governor: "Governor",
  exit_plan: "Plan",
  ask_user: "Ask",
  web: "Web",
};

/** What an unrecognized tool name renders as. A model can call a tool that does not
 *  exist (a hallucinated `index_results`, say). The row still has to appear — the call
 *  happened and it failed — but it renders under a plain English name with the raw
 *  name as its argument, rather than title-casing whatever the model invented. */
export const UNKNOWN_TOOL = "Unknown tool";

// Consecutive calls to these fold into ONE row (see WorkGroup) rather than
// stacking a line each — a burst of reads is "Read 9 files" with the files
// listed under it.
//
// Deliberately narrow. `search` is not here, and does not render at all — like the
// code-intel lookups (outline/definition/references/relevant), it is how the agent
// finds its way around rather than work done to the project, and the user asked for
// it to stay out of the stream. `todo_write` is silent for the same reason: its
// reader is the model, not the user. Mutating tools (edit/write/run) were never
// grouped and still keep their own row with the diff/output.
const GROUPABLE = new Set(["read_file", "read_symbol"]);

/**
 * The agent working in the shell: running a command, checking on one it left running, stopping
 * one. Consecutive calls fold into ONE commands row (see WorkGroup), however many there are
 * and even when there is only one. Most print nothing worth reading, and a long conversation
 * of them was a wall of rows; a click opens the list and a second click a command's output.
 */
const COMMANDS = new Set(["run_command", "shells", "kill_shell"]);

/** Whether a call is the agent working in the shell. */
export function isCommandTool(name: string): boolean {
  return COMMANDS.has(name);
}
// `diagnostics` was here, and grouping it was the wrong answer to the right problem.
// A burst of them after an edit did stack a wall of rows — but folding them into the
// group threw away the caret block each one carries (a group row shows a label, never
// a detail), so the one case worth seeing, an actual compiler error with its source
// line and squiggle, was the case that got hidden. It now stays ungrouped and reports
// nothing at all when it finds nothing (`quiet`), which removes the wall outright.

/**
 * Tools the conversation never draws where they happen: the agent finding its way around
 * (search and the code lookups), its own notes (the task list), loading a tool, and polling a
 * background command.
 */
const UNSHOWN = new Set(["search", "outline", "definition", "references", "relevant", "todo_write", "find_tools", "shells"]);
const READS = new Set(["read_file", "read_symbol"]);

/** A path as a key: one spelling per file, whatever slashes or case the call used. */
function pathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").toLowerCase();
}

/**
 * Whether the words a model wrote before these tool calls belong in the conversation (pure).
 *
 * Text is shown when it leads to something the user can see: an edit, a command, a first
 * read of a file. When everything it leads to is invisible (searches, lookups, re-reading a
 * file already read this turn), the text is narration about nothing on screen, and the
 * conversation leaves it out. The reply that ends a turn has no calls and is never judged here.
 *
 * `readBefore` holds the files already read this turn; the caller adds this step's reads
 * afterwards with {@link noteReads}.
 */
export function narrationShown(calls: { name: string; args: Record<string, unknown> }[], readBefore: ReadonlySet<string>): boolean {
  return calls.some((c) => {
    if (UNSHOWN.has(c.name)) return false;
    if (READS.has(c.name)) {
      const paths = toPathList(c.args);
      return paths.length === 0 || paths.some((p) => !readBefore.has(pathKey(p)));
    }
    return true;
  });
}

/** Record the files these calls read, for the next {@link narrationShown} in the same turn. */
export function noteReads(calls: { name: string; args: Record<string, unknown> }[], readBefore: Set<string>): void {
  for (const c of calls) if (READS.has(c.name)) for (const p of toPathList(c.args)) readBefore.add(pathKey(p));
}

/**
 * Tools whose calls never become a row at all: the agent finding its way around (search and the
 * code lookups), its own task list, and loading a tool. Their results are always quiet, so they
 * used to vanish without being seen only because a row was held back until its result came. Rows
 * now appear while a call works, so these are left out from the start instead of flashing up and
 * disappearing.
 */
const NEVER_SHOWN = new Set(["search", "outline", "definition", "references", "relevant", "todo_write", "find_tools"]);

/** Whether a tool's calls are never drawn in the conversation. */
export function neverShown(name: string): boolean {
  return NEVER_SHOWN.has(name);
}

/** Whether a tool call should fold into the discovery group rather than its own row. */
export function isGroupable(name: string): boolean {
  return GROUPABLE.has(name) || COMMANDS.has(name);
}

/**
 * The action a tool performs. It decides how a row reads (its verb and what its result
 * shows) and whether its dot turns green when it succeeds (see `dotColorFor`).
 */
export type ToolKind =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "run"
  | "check"
  | "agent"
  | "websearch"
  | "screenshot"
  | "mcp"
  | "checkpoint"
  | "governor"
  | "meta";

const TOOL_KIND: Record<string, ToolKind> = {
  read_file: "read",
  read_symbol: "read",
  search: "search",
  outline: "search",
  definition: "search",
  references: "search",
  relevant: "search",
  edit: "edit",
  replace_symbol_body: "edit",
  write_file: "write",
  run_command: "run",
  spawn_subagent: "agent",
  shells: "run",
  // web_fetch and web_search are both "reaching out to the web" — same family,
  // distinct from codebase "search". Was mislabeled "search" before.
  web_fetch: "websearch",
  web_search: "websearch",
  web: "websearch",
  screenshot: "screenshot",
  view_image: "screenshot",
  ui: "screenshot",
  kill_shell: "run",
  governor: "governor",
  // The MCP family: finding an external server's tools, reading its data, adding one.
  // Pink like the servers' own tools, since that is what they are all about.
  find_tools: "mcp",
  mcp_resource: "mcp",
  mcp_server: "mcp",
  // everything else (todo, skills, rules, workspace) → "meta"
};

/** The action category for a raw tool name — an MCP call (`mcp__server__tool`) is
 *  detected by prefix rather than a static map entry, since the tool name is
 *  generated per-server (see src/mcp/manager.ts). Defaults to bookkeeping "meta". */
export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  return TOOL_KIND[name] ?? "meta";
}

/** The dot colour for a failed tool / failed test. */
export const ERROR_COLOR = BAD;
/** The dot colour for work that went through. */
export const OK_COLOR = GOOD;

/** The kinds whose success is worth showing: something was changed, checked or run. */
const OK_KINDS: ReadonlySet<ToolKind> = new Set(["edit", "write", "check", "run"]);

/**
 * A row's dot colour. Three states and nothing else: red when it failed, green once an
 * edit / write / check / command has gone through, and the terminal's own colour (white)
 * for everything else. Undefined means "leave it uncoloured".
 */
export function dotColorFor(kind: ToolKind | undefined, status: "running" | "ok" | "error"): string | undefined {
  if (status === "error") return ERROR_COLOR;
  if (status === "ok" && kind !== undefined && OK_KINDS.has(kind)) return OK_COLOR;
  return undefined;
}

export interface ToolDisplay {
  name: string;
  arg?: string;
  /** Action category, for the row's dot colour. */
  kind: ToolKind;
  /** A dim qualifier after the name — currently a non-default command timeout, shown
   *  because it changes how long the row may sit there before it means anything. */
  meta?: string;
  /**
   * How many THINGS this one call covers, when that is not one.
   *
   * `read_file` takes a list of paths, so a single call can read several files. The
   * discovery group counted calls and called them files, which meant three files read in
   * one call announced themselves as "Reading 1 file" above a row that said "Read 3
   * files" — the header and its own content disagreeing, with the header wrong.
   */
  covers?: number;
}

/** Build the `Name(arg)` display parts for a tool call. */
export function toolDisplay(name: string, args: Record<string, unknown>): ToolDisplay {
  const kind = toolKind(name);

  // mcp__<server>__<tool> has no static DISPLAY_NAME entry (the name is generated
  // per-server, see src/mcp/manager.ts) — parse it back into "MCPServer(server)"
  // the way the tool header for everything else reads.
  if (name.startsWith("mcp__")) {
    const [, server] = name.split("__");
    return { name: "MCPServer", arg: server || undefined, kind };
  }

  // Every REGISTERED tool has an entry above (enforced by test), so reaching the
  // fallback means the model named a tool that does not exist.
  const known = DISPLAY_NAME[name];
  if (!known) return { name: UNKNOWN_TOOL, arg: name, kind: "meta" };
  const display = known;

  // `search` is quiet and never renders, but it still resolves a name/arg for the
  // sub-agent rail and for any future surface — and it takes either argument.
  if (name === "search") {
    return { name: display, arg: str(args.pattern) || str(args.files) || str(args.path) || undefined, kind };
  }
  if (name === "run_command") {
    // The command goes in the HEADER, like every other row's subject: `Run(npm test)`
    // beside `Write(app.ts)` and `Read(index.ts)`. It used to be a bare title —
    // "Executed shell command" — with the command on a `$` row below it, which read as
    // a sentence in a column of verb-noun names and took three rows to say what the
    // others say in one.
    //
    // Passed WHOLE, not clipped. The old 48-character clip here is what forced the
    // command onto its own row in the first place; ToolLine fits the header to the
    // real terminal width and only trims when it genuinely does not fit, and the `$`
    // row comes back for exactly that case.
    //
    // The timeout marker appears only when the model asked for one. A marker on every
    // command would say nothing; this exists to explain a row allowed to take longer.
    const t = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : undefined;
    return {
      name: display,
      arg: str(args.command) || undefined,
      kind,
      // Human duration, not raw seconds: `[timeout 10m]` and `[timeout 1m 20s]` read at a
      // glance where `[Timeout: 600s]` made the reader do the division.
      ...(t ? { meta: `[timeout ${formatDuration(t)}]` } : {}),
    };
  }
  // The combined `web` tool says which of the two it is doing by its arguments, and the row
  // names that: a page read shows its address, a search its query. Labelled generically it
  // read "Web" with nothing after it for every page it opened.
  if (name === "web") {
    return str(args.url)
      ? { name: DISPLAY_NAME.web_fetch!, arg: clip(str(args.url), 48) || undefined, kind }
      : { name: DISPLAY_NAME.web_search!, arg: clip(str(args.query), 48) || undefined, kind };
  }
  if (name === "web_fetch") return { name: display, arg: clip(str(args.url), 48) || undefined, kind };
  if (name === "web_search") return { name: display, arg: clip(str(args.query), 48) || undefined, kind };
  if (name === "screenshot") return { name: display, arg: str(args.window) || undefined, kind };
  // Named by what it does to the app: Look(localhost:5173), Click(#4), Type("halo"), Key(Enter).
  if (name === "ui") {
    const action = str(args.action);
    const target = typeof args.target === "number" || str(args.target) ? `#${String(args.target)}` : str(args.name) ? `"${clip(str(args.name), 32)}"` : "";
    if (Array.isArray(args.steps) && args.steps.length) {
      const n = args.steps.length;
      return { name: "Steps", arg: `${n} step${n === 1 ? "" : "s"}`, kind };
    }
    if (action === "click") return { name: "Click", arg: target || undefined, kind };
    if (action === "hover") return { name: "Hover", arg: target || undefined, kind };
    if (action === "type") return { name: "Type", arg: clip(str(args.text), 40) ? `"${clip(str(args.text), 40)}"` : undefined, kind };
    if (action === "key") return { name: "Key", arg: [str(args.key), target].filter(Boolean).join(" ") || undefined, kind };
    if (action === "scroll") return { name: "Scroll", arg: str(args.direction) || "down", kind };
    if (action === "back") return { name: "Back", kind };
    if (action === "wait") return { name: "Wait", arg: clip(str(args.text) || str(args.gone), 40) ? `"${clip(str(args.text) || str(args.gone), 40)}"` : undefined, kind };
    if (action === "resize") return { name: "Resize", arg: args.width && args.height ? `${String(args.width)}×${String(args.height)}` : "reset", kind };
    if (action === "inspect") return { name: "Inspect", arg: target || undefined, kind };
    if (action === "close") return { name: "Close", kind };
    const url = str(args.url).replace(/^https?:\/\//i, "").replace(/\/$/, "");
    const port = args.port !== undefined && args.port !== null && String(args.port) ? `port ${String(args.port)}` : "";
    return { name: "Look", arg: clip(url, 48) || [port, str(args.window)].filter(Boolean).join(" · ") || undefined, kind };
  }
  if (name === "spawn_subagent") return { name: display, arg: clip(str(args.task), 48) || undefined, kind };

  // `paths` is a LIST — read_file takes several files in one call, and the row has to
  // say WHICH. It used to say "3 files", which repeated the count the header above it
  // already gave and named none of them, so a burst of reads was three rows of arithmetic
  // and no information. The names are what anyone reading it wants, and they are already
  // here in the arguments.
  //
  // A multi-path read has no line range to show — ranges only apply to a single file, and
  // the tool ignores them for a list — so the names are the whole story.
  //
  // Read through the SAME reader the tool uses, not a second one written to match it.
  // The row is a statement about a call that has already been made, so any shape the
  // tool accepts has to be a shape this can name — and it was not. A call that passed
  // its four files under the older singular `path` was read in full and displayed as
  // "Reading 1 file" with no filenames at all, the header contradicting its own result.
  const many = toPathList(args);
  const path = many.length === 1 ? (many[0] ?? "") : "";
  const detail =
    many.length > 1
      ? many.map(base).join(", ")
      : path
        ? base(path)
        : str(args.symbol) || str(args.name) || str(args.query) || str(args.label);
  return {
    name: display,
    arg: detail || undefined,
    kind,
    // What the group header counts. One call, three files read.
    ...(many.length > 1 ? { covers: many.length } : {}),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A path's last segment, so rows stay short: `src/a/session.ts` → `session.ts`. */
function base(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}
