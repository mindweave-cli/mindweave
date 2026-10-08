/**
 * hooks.ts — the user's own commands, run at five moments of a turn.
 *
 * A hook is a command the USER wrote. It gets one JSON object on stdin describing the moment,
 * and answers with its exit code:
 *
 *   0       fine. What it printed on stdout is, for SessionStart and UserPromptSubmit, added to
 *           the conversation as context; for the others it is ignored unless it is JSON.
 *   2       stop this, and tell the MODEL why (stderr): a PreToolUse hook refuses the call, a
 *           PostToolUse hook adds a note to the result, a Stop hook says "do not finish yet",
 *           a UserPromptSubmit hook refuses the message.
 *   other   something is wrong with the hook itself: stderr is shown to the person, nothing is
 *           stopped, the turn goes on.
 *
 * It may also print JSON: `{"decision":"block","reason":"…"}` blocks like exit 2, and
 * `{"additionalContext":"…"}` adds context.
 *
 * Where they live is the safety decision. They are read from the user's state folder, one file
 * for every project (`~/.mindweave/hooks.json`) and one per project (the project's folder under
 * it), never from the repository. A hook is code that runs with the person's privileges, so a
 * file that arrives with a cloned repository must not be able to add one, and the model, which
 * cannot write the state folder (tools/guard.ts), cannot either.
 *
 * A hook never wedges a turn: each has a time limit (60 s unless it says otherwise), is killed
 * with everything it started when it runs over, and one that crashes or cannot start is
 * reported and skipped. They run with the same scrubbed environment as any command.
 *
 * Config:
 *   { "hooks": { "PreToolUse": [ { "matcher": "run_command|edit", "command": "node check.js", "timeoutMs": 30000 } ],
 *                "Stop": [ { "command": "npm test --silent" } ] } }
 * `matcher` is a tool name, several joined by |, or * (the default) for any; it only applies to
 * the two tool events.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { projectDir, stateRoot } from "../memory/store.js";
import { childEnv } from "../tools/childEnv.js";
import { killTree, spawnManaged } from "../tools/killTree.js";

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart";
const EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart"];

export interface HookSpec {
  command: string;
  matcher?: string;
  timeoutMs?: number;
}

export type HookConfig = Partial<Record<HookEvent, HookSpec[]>>;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 64_000;

/** Parse a hooks.json body (pure). Anything malformed is dropped, never thrown on. */
export function parseHooks(raw: string): HookConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  const hooks = (data as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return {};
  const out: HookConfig = {};
  for (const event of EVENTS) {
    const list = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(list)) continue;
    const specs = list.flatMap((h): HookSpec[] => {
      if (!h || typeof h !== "object") return [];
      const { command, matcher, timeoutMs } = h as Record<string, unknown>;
      if (typeof command !== "string" || !command.trim()) return [];
      return [
        {
          command,
          ...(typeof matcher === "string" && matcher.trim() ? { matcher: matcher.trim() } : {}),
          ...(typeof timeoutMs === "number" && timeoutMs > 0 ? { timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS) } : {}),
        },
      ];
    });
    if (specs.length > 0) out[event] = specs;
  }
  return out;
}

/** Does a hook's matcher cover this tool (pure)? */
export function matchesTool(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === "*") return true;
  return matcher.split("|").some((m) => m.trim().toLowerCase() === tool.toLowerCase());
}

/** The hooks that apply: the user's for every project, then this project's. */
/** One configured hook, for a settings screen. */
export interface HookRow {
  event: HookEvent;
  matcher: string;
  command: string;
  scope: "global" | "project";
}

/** Where each hooks.json lives (it may not exist yet), and what is in them, for a settings screen. */
export async function hooksOverview(cwd: string): Promise<{ files: { global: string; project: string }; rows: HookRow[] }> {
  const files = { global: join(stateRoot(), "hooks.json"), project: join(projectDir(cwd), "hooks.json") };
  const rows: HookRow[] = [];
  for (const scope of ["global", "project"] as const) {
    let config: HookConfig = {};
    try {
      config = parseHooks(await fs.readFile(files[scope], "utf8"));
    } catch {
      /* none yet */
    }
    for (const event of EVENTS) {
      for (const h of config[event] ?? []) rows.push({ event, matcher: h.matcher ?? "*", command: h.command, scope });
    }
  }
  return { files, rows };
}

export async function loadHooks(cwd: string): Promise<HookConfig> {
  const read = async (dir: string) => {
    try {
      return parseHooks(await fs.readFile(join(dir, "hooks.json"), "utf8"));
    } catch {
      return {};
    }
  };
  const [global, project] = await Promise.all([read(stateRoot()), read(projectDir(cwd))]);
  const merged: HookConfig = {};
  for (const event of EVENTS) {
    const list = [...(global[event] ?? []), ...(project[event] ?? [])];
    if (list.length > 0) merged[event] = list;
  }
  return merged;
}

/** What one hook run came to. */
export interface HookOutcome {
  /** The hook asked to stop the thing: exit 2, or `decision: "block"`. */
  block: boolean;
  /** Why, for the model (stderr, or the JSON reason). */
  reason: string;
  /** Text to add to the conversation. */
  context: string;
  /** A problem with the hook itself, for the person: it could not start, timed out, or exited oddly. */
  problem: string | null;
}

/** Turn what a finished hook said into an outcome (pure). */
export function interpretHook(exitCode: number | null, stdout: string, stderr: string, timedOut: boolean): HookOutcome {
  if (timedOut) return { block: false, reason: "", context: "", problem: "timed out and was stopped" };
  let json: { decision?: unknown; reason?: unknown; additionalContext?: unknown } | null = null;
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }
  const jsonBlock = json?.decision === "block" || json?.decision === "deny";
  const jsonReason = typeof json?.reason === "string" ? json.reason : "";
  const jsonContext = typeof json?.additionalContext === "string" ? json.additionalContext : "";
  if (exitCode === 2 || jsonBlock) {
    return { block: true, reason: (jsonReason || stderr.trim() || "blocked by a hook").trim(), context: jsonContext, problem: null };
  }
  if (exitCode !== 0) {
    return { block: false, reason: "", context: "", problem: `exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}` };
  }
  return { block: false, reason: "", context: jsonContext || (json ? "" : trimmed), problem: null };
}

/** Run one hook command with `input` on stdin. Never throws and never outlives its time limit. */
export async function runHook(spec: HookSpec, input: Record<string, unknown>, cwd: string, event: HookEvent): Promise<HookOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (outcome: HookOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child;
    try {
      child = spawnManaged(spec.command, [], {
        cwd,
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv({ MINDWEAVE_HOOK_EVENT: event, MINDWEAVE_PROJECT_DIR: cwd }),
      });
    } catch (error) {
      return resolve({ block: false, reason: "", context: "", problem: `could not start: ${error instanceof Error ? error.message : String(error)}` });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      finish(interpretHook(null, stdout, stderr, true));
    }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += c.toString("utf8");
    });
    child.on("error", (e) => finish({ block: false, reason: "", context: "", problem: `could not start: ${e.message}` }));
    child.on("close", (code) => finish(interpretHook(code, stdout, stderr, timedOut)));
    // A hook that does not read its input must not hang the write.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ hook_event_name: event, cwd, ...input }));
  });
}

/** The outcome of every hook for an event, in order, stopping at the first that blocks. */
export async function runHooks(
  config: HookConfig,
  event: HookEvent,
  input: Record<string, unknown> & { tool_name?: string },
  cwd: string,
  report: (line: string) => void = () => {},
): Promise<{ block: boolean; reason: string; context: string }> {
  let context = "";
  for (const spec of config[event] ?? []) {
    if ((event === "PreToolUse" || event === "PostToolUse") && !matchesTool(spec.matcher, input.tool_name ?? "")) continue;
    const outcome = await runHook(spec, input, cwd, event);
    if (outcome.problem) report(`hook \`${spec.command.slice(0, 60)}\` ${outcome.problem}`);
    if (outcome.context) context += (context ? "\n" : "") + outcome.context;
    if (outcome.block) return { block: true, reason: outcome.reason, context };
  }
  return { block: false, reason: "", context };
}
