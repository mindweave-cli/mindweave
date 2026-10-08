/**
 * childEnv.ts — the environment a program Mindweave starts should see.
 *
 * Mindweave loads its settings files (~/.mindweave/.env and a project's .env) into its
 * own environment, because that is where every driver reads its API key. A child
 * process inherits that environment, so every command the agent ran, every MCP server
 * and every language server could read every provider key: `env` in a debugging step
 * put them in the transcript, and any build script or injected instruction could send
 * them anywhere. The user's own shell never exposed them; Mindweave did.
 *
 * So a child gets the environment the user's shell gave Mindweave, not the one
 * Mindweave built on top of it:
 *
 *   - a variable that was not there when Mindweave started is left out (everything
 *     loaded from the settings files, the stored-key slots, internal flags);
 *   - a provider key the user exported in their shell is passed with the value they
 *     exported, even when Mindweave is using a different key of theirs for itself;
 *   - anything else that was there passes through as it is now.
 *
 * The snapshot is taken when this module is first loaded, which is before the
 * settings files are read (cli/bootstrap.ts imports it for that reason).
 */

const IS_WINDOWS = process.platform === "win32";

/** Windows variable names are case-insensitive; compare them that way. */
const norm = (name: string) => (IS_WINDOWS ? name.toUpperCase() : name);

/** The environment Mindweave started with, by normalised name. */
const shell = new Map<string, string>(
  Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[norm(k), v] as [string, string]])),
);

/** A provider key variable, or one of the numbered slots keys are stored in. */
const PROVIDER_KEY = /_API_KEY(_\d+)?$/i;

/**
 * The environment for a child process: the user's shell environment as it is now,
 * without anything Mindweave added, plus `extra` (which the caller decides and wins).
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const original = shell.get(norm(name));
    if (original === undefined) continue;
    out[name] = PROVIDER_KEY.test(name) ? original : value;
  }
  return { ...out, ...extra };
}

/** True when `name` was set by Mindweave rather than inherited from the shell (for tests and diagnostics). */
export function addedByMindweave(name: string): boolean {
  return process.env[name] !== undefined && !shell.has(norm(name));
}
