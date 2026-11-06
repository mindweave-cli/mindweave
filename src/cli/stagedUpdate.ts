/**
 * stagedUpdate.ts — installing the next version while the current one keeps running.
 *
 * A newer release is installed into its own folder under `<state>/versions/` (see launcher.ts), checked
 * there, and only then switched in by writing `active` into `current.json`. The running copy is never
 * touched, so nothing is locked and nothing it loads late can change under it. The next start is the new
 * version because the launcher reads `current.json` first.
 *
 * The decisions are pure and tested. The installing itself takes its steps as arguments, so the tests run
 * the whole sequence on fake copies in a throwaway folder and no test touches npm or the network.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { childEnv } from "../tools/childEnv.js";
import {
  type ManagedState,
  isNewer,
  managedStateRoot,
  parseVersion,
  readState,
  versionEntry,
  versionsRoot,
  writeState,
} from "./launcher.js";
import { runNpm, type InstallResult } from "./updateRunner.js";

/** How long nothing has been typed and no turn has run before a download may start. */
export const IDLE_BEFORE_STAGING_MS = 2 * 60_000;

/** An install that has not finished by now is given up on. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** The new copy gets this long to print its version. */
const SMOKE_TIMEOUT_MS = 30_000;
/** A lock older than this belongs to an install that died. */
const STALE_LOCK_MS = 15 * 60_000;
/** A half-made folder older than this is left over from an install that died. */
const STALE_STAGING_MS = 60 * 60_000;

export interface StageInput {
  /** The newest release the registry reports, or null when none is newer than what runs. */
  latest: string | null;
  /** The version running now. */
  running: string;
  state: ManagedState;
  idleMs: number;
  busy: boolean;
  /** `global` or `managed` can be updated this way; a checkout, the app and a dependency cannot. */
  installKind: string;
  /** Versions already tried in this process, whatever came of it. */
  attempted: ReadonlySet<string>;
  /** MINDWEAVE_NO_MANAGED=1 or MINDWEAVE_NO_UPDATE_CHECK: the person turned this off. */
  disabled: boolean;
}

export type StageDecision = { stage: true; version: string } | { stage: false; why: string };

/** Is this a moment and a copy for which asking the registry is worth it (pure). */
export function mayCheck(i: Pick<StageInput, "disabled" | "installKind" | "busy" | "idleMs">): StageDecision | null {
  if (i.disabled) return { stage: false, why: "off" };
  if (i.installKind !== "global" && i.installKind !== "managed") return { stage: false, why: "not-updatable" };
  if (i.busy) return { stage: false, why: "busy" };
  if (i.idleMs < IDLE_BEFORE_STAGING_MS) return { stage: false, why: "not-idle" };
  return null;
}

/** Should a download start now, and of what (pure). */
export function stageDecision(i: StageInput): StageDecision {
  const no = mayCheck(i);
  if (no) return no;
  if (!i.latest || !isNewer(i.latest, i.running)) return { stage: false, why: "up-to-date" };
  if (i.state.active && !isNewer(i.latest, i.state.active)) return { stage: false, why: "already-staged" };
  if (i.state.bad?.includes(i.latest)) return { stage: false, why: "bad" };
  if (i.attempted.has(i.latest)) return { stage: false, why: "tried" };
  return { stage: true, version: i.latest };
}

/** A copy is staged and newer than the one running: the version to tell the person to restart into, or null. */
export function stagedAhead(state: ManagedState, running: string): string | null {
  const v = state.active;
  if (!v || state.bad?.includes(v)) return null;
  return isNewer(v, running) ? v : null;
}

/**
 * Which installed folders can go (pure). Kept: the active and previous copy and the one running now. Gone: every other
 * folder named like a version. A second window still running an older copy keeps working on Windows (its folder cannot
 * be removed while in use); elsewhere it would lose files it loads late, which is why only two older copies are kept.
 */
export function toPrune(present: string[], state: ManagedState, running: string | null): string[] {
  const keep = new Set([state.active, state.previous, running].filter((v): v is string => Boolean(v)));
  return present.filter((v) => parseVersion(v) !== null && !keep.has(v));
}

export type StageResult = { ok: true; version: string } | { ok: false; message: string };

/** What staging needs from the outside world. */
export interface StageDeps {
  root: string;
  /** Install `version` of the package with `dir` as its prefix. */
  install: (dir: string, version: string) => Promise<InstallResult>;
  /** Does the copy in `dir` start and report `version`? */
  smoke: (dir: string, version: string) => Promise<boolean>;
  now: () => number;
  /** The version running now, kept from pruning. */
  running: string | null;
}

/** Is the folder for `version` complete: its entry and main exist, and its package.json says so. */
export function stagedCopyIsComplete(version: string, root: string): boolean {
  try {
    const entry = versionEntry(version, root);
    if (!existsSync(entry) || !existsSync(join(entry, "..", "main.js"))) return false;
    const v = (JSON.parse(readFileSync(join(entry, "..", "..", "package.json"), "utf8")) as { version?: unknown }).version;
    return v === version;
  } catch {
    return false;
  }
}

/** One install at a time across every window: whoever makes the folder holds the lock. */
function takeLock(root: string, now: number): boolean {
  const lock = join(versionsRoot(root), ".lock");
  mkdirSync(versionsRoot(root), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return true;
    } catch {
      try {
        if (now - statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
        rmSync(lock, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

function dropLock(root: string): void {
  try {
    rmSync(join(versionsRoot(root), ".lock"), { recursive: true, force: true });
  } catch {
    // A lock that stays is stale after STALE_LOCK_MS.
  }
}

/** Rename, retrying: on Windows a scanner can hold a just-written folder for a moment. */
async function moveInto(from: string, to: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}

/** Remove half-made folders that an install which died left behind. */
export function sweepStaging(root: string, now: number): void {
  try {
    for (const name of readdirSync(versionsRoot(root))) {
      if (!/^\..+\.tmp-/.test(name)) continue;
      const p = join(versionsRoot(root), name);
      if (now - statSync(p).mtimeMs > STALE_STAGING_MS) rmSync(p, { recursive: true, force: true });
    }
  } catch {
    // Nothing there to sweep.
  }
}

/** Remove the copies nobody needs. A folder that cannot be removed (in use) stays for next time. */
export function pruneVersions(root: string, state: ManagedState, running: string | null): void {
  try {
    const present = readdirSync(versionsRoot(root));
    for (const v of toPrune(present, state, running)) {
      try {
        rmSync(join(versionsRoot(root), v), { recursive: true, force: true });
      } catch {
        // In use, most likely. The next staging tries again.
      }
    }
  } catch {
    // No versions folder yet.
  }
}

/**
 * Install `version` beside the running copy and make it the one the next start uses.
 *
 * Every failure leaves things as they were: the half-made folder is removed, `current.json` is not touched
 * until the copy has passed its own check, and the lock is released.
 */
export async function stageVersion(version: string, deps: StageDeps = realDeps()): Promise<StageResult> {
  if (parseVersion(version) === null || !/^[0-9A-Za-z.+-]+$/.test(version)) {
    return { ok: false, message: "not a version" };
  }
  const { root } = deps;
  if (!takeLock(root, deps.now())) return { ok: false, message: "another install is running" };
  const staging = join(versionsRoot(root), `.${version}.tmp-${process.pid}`);
  try {
    sweepStaging(root, deps.now());
    const final = join(versionsRoot(root), version);
    if (!stagedCopyIsComplete(version, root)) {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const installed = await deps.install(staging, version);
      if (!installed.ok) return { ok: false, message: installed.message || "the install failed" };
      const asked = join(staging, "node_modules", "mindweave");
      let said: unknown;
      try {
        said = (JSON.parse(readFileSync(join(asked, "package.json"), "utf8")) as { version?: unknown }).version;
      } catch {
        said = undefined;
      }
      if (said !== version || !existsSync(join(asked, "dist", "index.js"))) {
        return { ok: false, message: "the installed copy is not the version asked for" };
      }
      if (!(await deps.smoke(staging, version))) return { ok: false, message: "the installed copy did not start" };
      rmSync(final, { recursive: true, force: true });
      await moveInto(staging, final);
      if (!stagedCopyIsComplete(version, root)) {
        rmSync(final, { recursive: true, force: true });
        return { ok: false, message: "the installed copy was incomplete" };
      }
    }
    const state = readState(root);
    if (state.active && state.active !== version && !state.bad?.includes(state.active)) state.previous = state.active;
    state.active = version;
    delete state.starting;
    writeState(state, root);
    pruneVersions(root, state, deps.running);
    return { ok: true, version };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Swept later.
    }
    dropLock(root);
  }
}

/** The real steps: npm, and the new copy asked for its version. */
export function realDeps(running: string | null = null): StageDeps {
  return {
    root: managedStateRoot(),
    running,
    now: () => Date.now(),
    // Exactly the version asked for, never `latest`. Scripts are not run: this happens unattended, and the
    // packages need none (the copy is checked below before it is ever used).
    install: (dir, version) =>
      runNpm(
        "npm",
        ["install", "--prefix", dir, "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", "--loglevel=error", `mindweave@${version}`],
        INSTALL_TIMEOUT_MS,
        childEnv(),
      ),
    smoke: (dir, version) =>
      new Promise((resolve) => {
        const entry = join(dir, "node_modules", "mindweave", "dist", "index.js");
        let out = "";
        const child = spawn(process.execPath, [entry, "--version"], {
          env: { ...childEnv(), MINDWEAVE_NO_MANAGED: "1" },
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          child.kill();
          resolve(false);
        }, SMOKE_TIMEOUT_MS);
        child.stdout?.on("data", (c: Buffer) => {
          out += c.toString("utf8");
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0 && out.trim() === `mindweave ${version}`);
        });
      }),
  };
}
