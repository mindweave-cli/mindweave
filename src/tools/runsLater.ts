/**
 * runsLater.ts — ask before writing a file whose purpose is to run code later.
 *
 * Some files are programs in disguise: an editor task set to run when the folder opens,
 * a commit hook, a CI workflow, a shell's startup file, the project's own Mindweave
 * config (which names MCP servers to start). Writing one is harmless at the time and runs
 * later, on someone who is not watching: when the folder is opened, at the next commit,
 * on the next push, in the next terminal. A prompt-injected "set the project up" could
 * plant one and nothing asked.
 *
 * So a write or edit to one of these asks the user first, showing what is being written,
 * and a yes holds for that file for the rest of the session. It asks rather than refuses:
 * editing these is ordinary work, and a refusal would only teach people to go around it.
 * package.json is deliberately NOT here: its scripts are edited constantly, and a
 * question on every edit would be clicked through.
 *
 * Honest limit: run_command can write the same files. This covers the file tools.
 */
import type { ToolContext, ToolResult } from "./types.js";
import { fail } from "./results.js";
import { realPathOf } from "./guard.js";

const RUNS_LATER: { test: RegExp; what: string }[] = [
  { test: /(^|\/)\.vscode\//i, what: "editor configuration that can run tasks when the folder opens" },
  { test: /(^|\/)\.idea\//i, what: "editor configuration that can run tasks" },
  { test: /(^|\/)\.husky\//i, what: "a git hook that runs on commit" },
  { test: /(^|\/)\.githooks\//i, what: "a git hook that runs on commit" },
  { test: /(^|\/)\.github\/workflows\//i, what: "a CI workflow that runs on push" },
  { test: /(^|\/)\.gitlab-ci\.yml$/i, what: "a CI pipeline that runs on push" },
  { test: /(^|\/)\.mindweave\//i, what: "Mindweave's project configuration, which can name programs to start" },
  { test: /(^|\/)\.(gitconfig|gitmodules|ripgreprc)$/i, what: "configuration that can name programs to run" },
  {
    test: /(^|\/)\.(bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin|kshrc|cshrc|tcshrc|inputrc)$/i,
    what: "a shell startup file",
  },
  { test: /(^|\/)(Microsoft\.PowerShell_profile|Microsoft\.VSCode_profile|profile)\.ps1$/i, what: "a PowerShell startup file" },
  { test: /(^|\/)\.config\/fish\/config\.fish$/i, what: "a shell startup file" },
];

/** What kind of run-later file `absPath` is, or null (pure). */
export function runsLaterReason(absPath: string): string | null {
  const posix = absPath.split("\\").join("/");
  for (const { test, what } of RUNS_LATER) if (test.test(posix)) return what;
  return null;
}

/**
 * Ask before writing a run-later file. Returns a refusal to hand back, or null to go
 * ahead. `preview` is what will be written (shown to the user). Fails closed: with
 * nobody to ask, the write does not happen.
 */
export async function requestRunsLaterWrite(
  ctx: ToolContext,
  absPath: string,
  shown: string,
  preview: string,
): Promise<ToolResult | null> {
  const real = await realPathOf(absPath);
  const what = runsLaterReason(absPath) ?? runsLaterReason(real);
  if (!what) return null;
  if (ctx.runsLaterAllowed?.has(real)) return null;
  if (!ctx.requestApproval) {
    return fail(
      `Refusing to write ${shown}: it is ${what}, so it needs the user's agreement and there is no way to ask from here.`,
    );
  }
  const clipped = preview.length > 4000 ? `${preview.slice(0, 4000)}\n… (${preview.length - 4000} more characters)` : preview;
  const choice = await ctx.requestApproval(
    `Write ${shown}? It is ${what}.`,
    ["Yes, write it", "No"],
    clipped,
    "Permission Request",
  );
  if (!choice.startsWith("Yes")) {
    return fail(`Stopped: the user declined writing ${shown} (${what}). Leave it unchanged, and say what you wanted to set up.`);
  }
  ctx.runsLaterAllowed = new Set([...(ctx.runsLaterAllowed ?? []), real]);
  return null;
}
