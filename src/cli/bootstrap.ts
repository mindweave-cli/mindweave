/**
 * bootstrap.ts — make `mindweave` runnable from any directory.
 *
 * The whole point of a global command is that you `cd` into ANY project, type
 * `mindweave`, and it works — including the API key. A random project won't carry
 * Mindweave's `.env`, so the key has to live somewhere global. We layer config the
 * way every CLI does, lowest priority first:
 *
 *   1. ~/.mindweave/.env   — the global store (write your key here once).
 *   2. <project>/.env  — per-project overrides (optional).
 *   3. real shell env  — always wins (export a provider's key for a one-off).
 *
 * We parse `.env` ourselves (a tiny, dependency-free reader) so we control that
 * precedence exactly: a value is only applied if the variable isn't already set,
 * and we load project before global — so shell > project > global falls out
 * naturally. On first run we also drop a commented template at ~/.mindweave/.env so
 * the user has an obvious place to paste their key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../memory/store.js";
import { allProviders } from "../drivers/registry.js";
import { keysFor, slotVar } from "./keyStore.js";
import { isKeyDisabled } from "./keyPrefs.js";

/**
 * The global Mindweave config directory (~/.mindweave).
 *
 * The SAME directory the state lives in, and now the same function that resolves it.
 * They were computed separately and only one honoured `MINDWEAVE_STATE_DIR`, so a test
 * run — or anyone relocating Mindweave's files — moved the sessions and left the config
 * behind in the real home. The suite creates this template, which meant a clean machine
 * got a config file written into `~/.mindweave` by `npm test`: exactly the pollution
 * scripts/testState.mjs exists to prevent, still open on the config side.
 */
export function globalConfigDir(): string {
  return stateRoot();
}

/** The global env file (~/.mindweave/.env) — where the API key lives. */
export function globalEnvPath(): string {
  return join(globalConfigDir(), ".env");
}

/**
 * Load configuration into process.env. Call once, before anything reads a key.
 * Order matters: project first, then global, each set-if-absent, so already-set
 * shell variables win and a project `.env` overrides the global one.
 */
export function loadConfig(cwd: string = process.cwd()): void {
  ensureGlobalTemplate();
  reloadConfig(cwd);
}

/**
 * Re-read the env files into process.env without recreating the template. Used to
 * pick up a key the user just pasted while Mindweave is already running — once a real
 * key appears we adopt it with no restart. (Empty values are ignored, so the
 * blank key lines in the fresh template never count as "set".)
 */
export function reloadConfig(cwd: string = process.cwd()): void {
  applyEnvFile(join(cwd, ".env"));
  applyEnvFile(globalEnvPath());
  activateStoredKeys();
}

/**
 * Point each provider at its first stored key, unless something already has.
 *
 * Storage is `VAR_1..VAR_9` and the LIVE key is the bare `VAR` that every driver reads —
 * two roles, deliberately two variables. Nothing on disk fills the live one, so without
 * this a key added through /key would be written, reloaded, and then invisible on the
 * next launch: the app would ask for a key it already had.
 *
 * Set-if-absent, so a shell export still wins and a key chosen for this session with
 * /key is not overwritten by a later reload.
 */
function activateStoredKeys(): void {
  for (const provider of allProviders()) {
    if (process.env[provider.apiKeyEnv]?.trim()) continue;
    // The first key the user has not switched off; a disabled key is kept, never sent.
    const first = keysFor(provider.apiKeyEnv).find((k) => !isKeyDisabled(k.value));
    if (first) process.env[provider.apiKeyEnv] = first.value;
  }
}

/**
 * True once the named provider's key is available from any source.
 *
 * The variable name is a parameter rather than a constant because which key is
 * needed depends on which model the user is about to run — each provider declares
 * its own in its manifest. This module stays a plain config utility and never
 * imports the driver registry.
 */
export function hasApiKey(envVar: string): boolean {
  return Boolean(process.env[envVar]);
}

/**
 * Persist a key the user typed in the terminal: write it into ~/.mindweave/.env (so
 * it's there next launch too) and apply it to this process right away (so the
 * chat can start immediately — no restart). Updates that provider's line in place,
 * preserving every other line, so adding a second provider's key never disturbs
 * the first one.
 */
/**
 * Write a variable into the global env file, or remove it when `value` is null.
 *
 * One place, because saving and removing have to agree about the file's shape — a
 * remover that only deleted from `process.env` would leave the key on disk and it would
 * come back on the next launch.
 */
function writeEnvVar(envVar: string, value: string | null): void {
  const NL = String.fromCharCode(10);
  const dir = globalConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = globalEnvPath();
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    /* no file yet */
  }
  // Find the variable's line the way applyEnvFile READS it: leading spaces or tabs, and
  // an optional `export ` prefix, are both accepted there. A writer that matched neither
  // would fail to find a line the reader had loaded, append a second one, and let the
  // stale line win on the next launch — a key updated in the app but not on disk. Only
  // spaces and tabs, never `\s`, so the match cannot run across a line break.
  const body = `(?:export[ \\t]+)?${envVar}=`;
  let next: string;
  if (value === null) {
    // Take the trailing newline with the line, then collapse any blank run left behind.
    const remove = new RegExp(`^[ \\t]*${body}.*(?:\\r?\\n|$)`, "m");
    next = existing.replace(remove, "").replace(new RegExp(`${NL}{3,}`, "g"), NL + NL);
  } else {
    const line = `${envVar}=${value}`;
    const replace = new RegExp(`^[ \\t]*${body}.*$`, "m");
    next = replace.test(existing)
      ? existing.replace(replace, line)
      : (existing ? existing.replace(/\s*$/, NL) : "") + line + NL;
  }
  writeFileSync(path, next, { mode: 0o600 });
}

/**
 * Move a bare `VAR=value` into `VAR_1`, once, so storage and the live key stop sharing a
 * variable. An existing config or a shell export arrives that way; everything written
 * after this point is numbered.
 */
function normalizeLegacy(apiKeyEnv: string): void {
  const bare = process.env[apiKeyEnv]?.trim();
  if (!bare) return;
  if (process.env[slotVar(apiKeyEnv, 1)]?.trim()) return;
  process.env[slotVar(apiKeyEnv, 1)] = bare;
  writeEnvVar(slotVar(apiKeyEnv, 1), bare);
  writeEnvVar(apiKeyEnv, null);
}

/** Store a key in a slot. Slot 1 also becomes the live key when nothing else is. */
export function saveApiKey(apiKeyEnv: string, key: string, slot = 1): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  normalizeLegacy(apiKeyEnv);
  const envVar = slotVar(apiKeyEnv, slot);
  // Replacing the key that is live must replace what the drivers send, too; otherwise an
  // edited key only took effect on the next launch.
  const wasLive = Boolean(process.env[envVar]?.trim()) && process.env[envVar]?.trim() === process.env[apiKeyEnv]?.trim();
  process.env[envVar] = trimmed;
  writeEnvVar(envVar, trimmed);
  if (!process.env[apiKeyEnv]?.trim() || slot === 1 || wasLive) process.env[apiKeyEnv] = trimmed;
}

/**
 * Make a stored key the default: move it to slot 1, where every launch starts, and make
 * it live now. The others keep their order behind it. Cleared and rewritten from 1, the
 * same way `removeApiKey` renumbers, so no value is overwritten before it has moved.
 */
export function makeDefaultApiKey(apiKeyEnv: string, slot: number): boolean {
  normalizeLegacy(apiKeyEnv);
  const before = keysFor(apiKeyEnv);
  const chosen = before.find((k) => k.slot === slot);
  if (!chosen) return false;
  const ordered = [chosen, ...before.filter((k) => k.slot !== slot)];
  for (const k of before) {
    delete process.env[k.envVar];
    writeEnvVar(k.envVar, null);
  }
  ordered.forEach((k, i) => {
    const envVar = slotVar(apiKeyEnv, i + 1);
    process.env[envVar] = k.value;
    writeEnvVar(envVar, k.value);
  });
  process.env[apiKeyEnv] = chosen.value;
  return true;
}

/** Point the drivers at a given key value, or at none. For callers that pick by value. */
export function setLiveApiKey(apiKeyEnv: string, value: string | null): void {
  if (value) process.env[apiKeyEnv] = value;
  else delete process.env[apiKeyEnv];
}

/**
 * Remove one stored key, closing the gap behind it.
 *
 * Slots are renumbered so there is never a hole: with `_2` gone, `_3` becomes `_2`. A
 * hole reads fine to a program and badly to a person opening the file. Cleared first and
 * rewritten from 1, because renumbering in place would overwrite a value before it had
 * been moved.
 */
export function removeApiKey(apiKeyEnv: string, slot: number): void {
  normalizeLegacy(apiKeyEnv);
  const before = keysFor(apiKeyEnv);
  const live = process.env[apiKeyEnv]?.trim();
  const remaining = before.filter((k) => k.slot !== slot);
  for (const k of before) {
    delete process.env[k.envVar];
    writeEnvVar(k.envVar, null);
  }
  remaining.forEach((k, i) => {
    const envVar = slotVar(apiKeyEnv, i + 1);
    process.env[envVar] = k.value;
    writeEnvVar(envVar, k.value);
  });
  // Removing the key that was in use must not leave the provider pointing at nothing.
  if (!remaining.some((k) => k.value === live)) {
    if (remaining[0]) process.env[apiKeyEnv] = remaining[0].value;
    else delete process.env[apiKeyEnv];
  }
}

/**
 * Make a stored key the one the drivers send, for this session.
 *
 * Assigned into the variable they already read, and the stored slots are left alone: a
 * key that is merely rate-limited today belongs back in its usual place tomorrow, and
 * choosing one should not reorder a file the user maintains.
 */
export function useApiKey(apiKeyEnv: string, slot: number): boolean {
  const found = keysFor(apiKeyEnv).find((k) => k.slot === slot);
  if (!found) return false;
  process.env[apiKeyEnv] = found.value;
  return true;
}


/**
 * What lands in ~/.mindweave/.env the first time Mindweave runs.
 *
 * Every provider, because this is the file a new user actually opens — it listed two of
 * thirteen, and someone who came for Gemini or Groq found no sign their provider existed.
 * Built from the registry rather than typed out, so a new driver cannot be forgotten
 * here (docsCurrent.test.ts holds the same line for .env.example and PROVIDERS.md).
 */
const GLOBAL_ENV_TEMPLATE = [
  "# Mindweave global config — applies in every project.",
  "# Paste a key below (no quotes needed). You only need the one for the provider you",
  "# actually use; fill in several and /provider moves between them.",
  "",
  // The name on its OWN line, never trailing the assignment. `KEY=   # DeepSeek` reads
  // fine and parses as a VALUE of "# DeepSeek", so every provider would have reported a
  // key it did not have: no first-run prompt, and every request rejected with no
  // explanation. Caught by reading the parsed result rather than the file.
  // A local runtime (Ollama) has no key line: it counts as set up while it runs, which the
  // file still says, so a reader learns it is there.
  ...allProviders().flatMap((p) =>
    p.local ? [`# ${p.label}: models on this machine, no key. Start it and pull a model; nothing to fill in.`] : [`# ${p.label}`, `${p.apiKeyEnv}=`],
  ),
  "",
  "# Optional:",
  "# MINDWEAVE_MODEL — which model to open with. Run /model in Mindweave for the list.",
  "# MINDWEAVE_MODEL=",
  "",
].join(String.fromCharCode(10));


/** Create ~/.mindweave/.env with a commented template the first time we run. */
function ensureGlobalTemplate(): void {
  try {
    const dir = globalConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = globalEnvPath();
    if (!existsSync(path)) {
      writeFileSync(
        path,
        GLOBAL_ENV_TEMPLATE,
        { mode: 0o600 },
      );
    }
  } catch {
    // Best-effort: if we can't write the template, config loading still works.
  }
}

/** Apply a single .env file (set-if-absent), tolerating a missing/garbled file. */
function applyEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no file here — fine
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7) : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!key || key in process.env) continue; // already set wins
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (!value) continue; // ignore empty assignments (e.g. the blank template line)
    process.env[key] = value;
  }
}
