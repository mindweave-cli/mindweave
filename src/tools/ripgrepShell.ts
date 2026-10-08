/**
 * ripgrepShell.ts — the bundled rg, for commands the agent runs, with the same exclusions
 * the search tool applies.
 *
 * Mindweave ships ripgrep for its search tool, but a command the model ran could not use
 * it: unless the user had installed rg themselves, `rg` was not found. And where it was
 * found, it searched .env files and key folders that the search tool leaves out. So a
 * command gets the bundled rg's folder at the front of PATH, and RIPGREP_CONFIG_PATH
 * pointing at a policy file that excludes the same names (secrets, other agents' data).
 * A user's own rg config is kept: its lines come first and the exclusions are added.
 *
 * Honest limit: rg obeys a config only when asked to; `--no-config` or `-uu` skips it.
 * That is a command reading files by choice, which the command guard judges, not this.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, delimiter } from "node:path";
import { ripgrepPath } from "./ripgrep.js";
import { SEARCH_EXCLUDE_GLOBS } from "./guard.js";
import { stateRoot } from "../memory/store.js";

let written: string | null = null;

/** Where the generated policy file lives, written once per process. */
function policyFile(): string | null {
  if (written && existsSync(written)) return written;
  try {
    const dir = join(stateRoot(), "ripgrep");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "ripgreprc");
    const own = process.env.RIPGREP_CONFIG_PATH;
    let base = "";
    if (own && own !== file && existsSync(own)) base = readFileSync(own, "utf8").trimEnd() + "\n";
    const rules = SEARCH_EXCLUDE_GLOBS.map((g) => `--glob=!${g}`).join("\n");
    writeFileSync(file, `${base}# Added by Mindweave: the files its search tool leaves out.\n${rules}\n`);
    written = file;
    return file;
  } catch {
    return null;
  }
}

/** The environment additions for a command: PATH with the bundled rg, and the policy file. */
export function ripgrepShellEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const rg = ripgrepPath();
  if (isAbsolute(rg) && existsSync(rg)) {
    // Windows spells it "Path"; reuse whatever name is there so there is only one.
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    out[key] = `${dirname(rg)}${delimiter}${process.env[key] ?? ""}`;
  }
  const policy = policyFile();
  if (policy) out["RIPGREP_CONFIG_PATH"] = policy;
  return out;
}
