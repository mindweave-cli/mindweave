/**
 * launcher.ts — choosing which installed copy of Mindweave actually runs.
 *
 * The npm install is the LAUNCHER: it stays where `npm i -g` put it and changes rarely. Real versions
 * the background updater fetched live beside the state files, each in a folder of its own:
 *
 *   <state>/versions/<version>/node_modules/mindweave/dist/index.js
 *   <state>/current.json                  which one is active, which was before it, which failed
 *
 * A version is installed into its own folder while the running one is never touched, so there is no
 * file to lock and no half-replaced package. The switch happens at the next start: index.ts asks
 * `handOff()` first, and when a newer complete copy exists it runs that copy's index.js in this process.
 *
 * THIS FILE IS ON THE PATH OF EVERY LAUNCH. It uses only Node's own modules, and every failure to read
 * or decide ends in "run this copy", which is exactly what happened before it existed.
 *
 * ## A start that never finished
 *
 * The version that was handed to writes `starting` before it runs and the app clears it once it reaches
 * the ready screen (`confirmManagedStart`). A `starting` still there after STALE_START_MS means that copy
 * never came up, so it is recorded as bad and the previous one (or this copy) is used instead. Time is
 * the only evidence there is, as in restart.ts, and the margin keeps a second window opened seconds after
 * the first from counting the first one's start as a failure.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A start that has not confirmed after this long did not come up. */
export const STALE_START_MS = 60_000;

/** What `current.json` holds. Every field is optional: a missing or damaged file means "nothing staged". */
export interface ManagedState {
  /** The version to run, when it is newer than the launcher. */
  active?: string;
  /** The one before it, tried when `active` turns out bad. */
  previous?: string;
  /** Versions that failed to start; never chosen again. */
  bad?: string[];
  /** Set when a version was handed to and cleared once it is ready. */
  starting?: { version: string; at: number };
  /** The launcher's own package folder, so `/update` can still update it. */
  launcherRoot?: string;
}

/** `<state>`: the same place memory/store.ts uses, repeated here so this file loads nothing else. */
export function managedStateRoot(): string {
  const override = process.env.MINDWEAVE_STATE_DIR?.trim();
  return override ? override : join(homedir(), ".mindweave");
}

export function versionsRoot(root = managedStateRoot()): string {
  return join(root, "versions");
}

export function statePath(root = managedStateRoot()): string {
  return join(root, "current.json");
}

/** The index.js of one installed version. */
export function versionEntry(version: string, root = managedStateRoot()): string {
  return join(versionsRoot(root), version, "node_modules", "mindweave", "dist", "index.js");
}

/** Numbers of `x.y.z` (a `-beta` or `+build` tail is ignored), or null when it is not a version. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is `a` a newer release than `b`? Anything that is not a version is never newer. */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  }
  return false;
}

/** A name that can only be a version folder, never a path. */
function plainVersion(v: unknown): v is string {
  return typeof v === "string" && parseVersion(v) !== null && /^[0-9A-Za-z.+-]+$/.test(v);
}

/** Read `current.json`; anything wrong with it reads as an empty state. */
export function readState(root = managedStateRoot()): ManagedState {
  try {
    const raw = JSON.parse(readFileSync(statePath(root), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return {};
    const state: ManagedState = {};
    if (plainVersion(raw.active)) state.active = raw.active;
    if (plainVersion(raw.previous)) state.previous = raw.previous;
    if (Array.isArray(raw.bad)) state.bad = raw.bad.filter(plainVersion);
    const s = raw.starting as { version?: unknown; at?: unknown } | undefined;
    if (s && plainVersion(s.version) && typeof s.at === "number" && Number.isFinite(s.at)) {
      state.starting = { version: s.version, at: s.at };
    }
    if (typeof raw.launcherRoot === "string" && raw.launcherRoot) state.launcherRoot = raw.launcherRoot;
    return state;
  } catch {
    return {};
  }
}

/** Write it whole or not at all, so a crash cannot leave half a file that reads as a different state. */
export function writeState(state: ManagedState, root = managedStateRoot()): void {
  mkdirSync(root, { recursive: true });
  const tmp = `${statePath(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath(root));
}

/** What the launcher decided. */
export type LaunchChoice = { kind: "own" } | { kind: "managed"; version: string };

/**
 * Decide which copy runs (pure). Returns the choice and the state to save.
 *
 * `usable` answers whether a version's files are complete on disk. A start that went stale is recorded as
 * bad first, so the same broken copy is never tried twice.
 */
export function chooseLaunch(
  state: ManagedState,
  ownVersion: string,
  now: number,
  usable: (version: string) => boolean,
): { choice: LaunchChoice; state: ManagedState } {
  const next: ManagedState = { ...state, bad: [...(state.bad ?? [])] };

  const failed = next.starting;
  if (failed && now - failed.at > STALE_START_MS) {
    if (!next.bad!.includes(failed.version)) next.bad!.push(failed.version);
    delete next.starting;
    if (next.active === failed.version) {
      next.active = next.previous;
      delete next.previous;
    } else if (next.previous === failed.version) {
      delete next.previous;
    }
  }

  const bad = new Set(next.bad);
  for (const version of [next.active, next.previous]) {
    if (!version || bad.has(version)) continue;
    if (!isNewer(version, ownVersion)) continue;
    if (!usable(version)) continue;
    next.starting = { version, at: now };
    return { choice: { kind: "managed", version }, state: next };
  }
  delete next.starting;
  return { choice: { kind: "own" }, state: next };
}

/** This copy's own package folder (the parent of `dist`). */
function ownPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The version this copy is, read from its own package.json; empty when unreadable. */
function ownVersionOf(packageRoot: string): string {
  try {
    const v = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

const foldsCase = process.platform === "win32" || process.platform === "darwin";
const fold = (p: string): string => (foldsCase ? p.toLowerCase() : p);

/** The version folder this copy runs from, or null when it is the launcher itself (pure on its inputs). */
export function runningManagedVersion(packageRoot: string, root = managedStateRoot()): string | null {
  const base = fold(resolve(versionsRoot(root))) + sep;
  const here = fold(resolve(packageRoot)) + sep;
  if (!here.startsWith(base)) return null;
  const first = resolve(packageRoot).slice(base.length).split(/[\\/]/)[0];
  return first && plainVersion(first) ? first : null;
}

/** Are a version's files all there, and do they say they are that version? */
function versionIsUsable(version: string, root: string): boolean {
  try {
    const entry = versionEntry(version, root);
    if (!existsSync(entry)) return false;
    const pkg = join(dirname(entry), "..", "package.json");
    const v = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version;
    return v === version && existsSync(join(dirname(entry), "main.js"));
  } catch {
    return false;
  }
}

const HANDED = "__mindweaveHandedOff";

/** Errors that mean the other copy never began to run, so running this one instead is safe. */
function neverStarted(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
    code === "ERR_INVALID_PACKAGE_CONFIG" ||
    code === "ERR_UNKNOWN_FILE_EXTENSION"
  );
}

/**
 * Run a newer installed copy when there is one. Resolves true when it ran (the caller must then do nothing
 * more), false when this copy should run.
 *
 * Skipped when this copy already lives in a version folder, and once per process: a launcher that handed
 * over must never be handed back to.
 */
export async function handOff(): Promise<boolean> {
  const g = globalThis as Record<string, unknown>;
  if (g[HANDED]) return false;
  if (process.env.MINDWEAVE_NO_MANAGED === "1") return false;

  const root = managedStateRoot();
  const here = ownPackageRoot();
  let version: string;
  try {
    if (runningManagedVersion(here, root) !== null) return false;
    if (!existsSync(statePath(root))) return false;
    const own = ownVersionOf(here);
    if (!own) return false;
    const decided = chooseLaunch(readState(root), own, Date.now(), (v) => versionIsUsable(v, root));
    decided.state.launcherRoot = here;
    // Saved even when this copy runs: a stale start has been recorded as bad.
    writeState(decided.state, root);
    if (decided.choice.kind === "own") return false;
    version = decided.choice.version;
  } catch {
    return false;
  }

  g[HANDED] = true;
  try {
    await import(pathToFileURL(versionEntry(version, root)).href);
    return true;
  } catch (err) {
    markBad(version, root);
    if (neverStarted(err)) {
      g[HANDED] = false;
      return false;
    }
    throw err;
  }
}

/** Record a version as failed and fall back to the previous one. Never throws. */
export function markBad(version: string, root = managedStateRoot()): void {
  try {
    const state = readState(root);
    const bad = new Set(state.bad ?? []);
    bad.add(version);
    state.bad = [...bad];
    if (state.starting?.version === version) delete state.starting;
    if (state.active === version) {
      state.active = state.previous;
      delete state.previous;
    } else if (state.previous === version) {
      delete state.previous;
    }
    writeState(state, root);
  } catch {
    // Nothing more can be done about a state file that cannot be written.
  }
}

/** The running app calls this once it is ready: a handed-over copy that got this far did come up. */
export function confirmManagedStart(root = managedStateRoot()): void {
  try {
    const version = runningManagedVersion(ownPackageRoot(), root);
    if (version) clearStarting(version, root);
  } catch {
    // A marker that stays is read as a failed start next time, which is the safe direction.
  }
}

/** Clear the start marker of `version`, when it is the one recorded. Never throws. */
export function clearStarting(version: string, root = managedStateRoot()): void {
  try {
    const state = readState(root);
    if (state.starting?.version !== version) return;
    delete state.starting;
    writeState(state, root);
  } catch {
    // See confirmManagedStart.
  }
}
