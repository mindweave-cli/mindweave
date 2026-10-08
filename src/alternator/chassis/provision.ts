/**
 * provision.ts — auto-install language servers, Mason-style.
 *
 * When a project uses a language whose server isn't bundled or on PATH, Mindweave
 * fetches it itself into `~/.mindweave/servers/<key>/` and caches it, so precision
 * "just appears" without the user installing anything. Sources mirror how servers
 * are actually distributed:
 *
 *   - npm    — `npm install` into the cache (this is the clean, broad source).
 *   - github — download the OS/arch release asset and extract it (binaries like
 *              rust-analyzer / clangd). [implemented in the next phase]
 *
 * Safety: only the curated, version-pinned registry in servers.ts is ever
 * installed — never an arbitrary package. Best-effort: a failed/blocked install
 * just leaves that language on the tree-sitter tier. Disable with
 * MINDWEAVE_NO_AUTO_INSTALL. In-flight installs are deduped so a language is fetched
 * once per session.
 */
import { killTree, spawnManaged } from "../../tools/killTree.js";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import { stateRoot } from "../../memory/store.js";
import { writeFileAtomic } from "../../tools/atomicWrite.js";

export interface NpmInstall {
  source: "npm";
  /** Package to install, e.g. "bash-language-server". */
  package: string;
  /** Pinned version. */
  version: string;
  /** The bin shim name the package exposes (in node_modules/.bin). */
  binName: string;
}
export interface GithubTarget {
  /** Release asset filename ("{version}" substituted). */
  asset: string;
  /**
   * SHA-256 of that asset, as published for the release. A download that does not match
   * is refused: the tag is only a name, and a replaced asset or a taken-over repository
   * would otherwise be installed and later run as the language server.
   */
  sha256: string;
  /** Executable path inside the cache dir after extraction ("{version}" substituted). */
  bin: string;
}
export interface GithubInstall {
  source: "github";
  repo: string; // "owner/name"
  version: string; // release tag
  /** platformKey() → which asset to download and where its binary ends up. */
  targets: Record<string, GithubTarget>;
}
export type InstallSpec = NpmInstall | GithubInstall;

const IS_WIN = process.platform === "win32";

export function autoInstallEnabled(): boolean {
  return !process.env.MINDWEAVE_NO_AUTO_INSTALL;
}

// ── consent ─────────────────────────────────────────────────────────────────
// A language server is third-party code that runs on this machine and reads the
// project. It used to be downloaded and started the first time a project had a file in
// its language, with nothing asked. Now the user decides once per server: an undecided
// server is not installed, the request waits for a question at the start of the next
// turn (see tools/serverConsent.ts), and tree-sitter answers in the meantime.

export type InstallDecision = "yes" | "never";

function decisionsPath(): string {
  return join(stateRoot(), "servers", "decisions.json");
}

function readDecisions(): Record<string, InstallDecision> {
  try {
    const v = JSON.parse(readFileSync(decisionsPath(), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, InstallDecision>) : {};
  } catch {
    return {};
  }
}

/** What the user decided about installing server `key`, if anything. */
export function installDecision(key: string): InstallDecision | undefined {
  const d = readDecisions()[key];
  return d === "yes" || d === "never" ? d : undefined;
}

/** Record the user's answer for server `key`, for good. */
export async function recordInstallDecision(key: string, decision: InstallDecision): Promise<void> {
  const all = { ...readDecisions(), [key]: decision };
  await fs.mkdir(join(stateRoot(), "servers"), { recursive: true });
  await writeFileAtomic(decisionsPath(), JSON.stringify(all, null, 2));
}

/** Servers wanted this session that the user has not decided about yet. */
const undecided = new Map<string, InstallSpec>();

/** Take the servers waiting for a question (each is asked about once). */
export function takeUndecidedInstalls(): { key: string; spec: InstallSpec }[] {
  const out = [...undecided].map(([key, spec]) => ({ key, spec }));
  undecided.clear();
  return out;
}

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function installDir(key: string): string {
  return join(homedir(), ".mindweave", "servers", key);
}

/** The launch command for an already-installed server, or null if not installed. */
export function resolveInstalled(key: string, spec: InstallSpec): string | null {
  const dir = installDir(key);
  if (spec.source === "npm") {
    const bin = join(dir, "node_modules", ".bin", spec.binName + (IS_WIN ? ".cmd" : ""));
    return existsSync(bin) ? bin : null;
  }
  const target = spec.targets[platformKey()];
  if (!target) return null;
  const bin = join(dir, target.bin.replaceAll("{version}", spec.version));
  return existsSync(bin) ? bin : null;
}

const inflight = new Map<string, Promise<string | null>>();

/**
 * Return the install command path, installing the server first if needed.
 * Deduped per key; best-effort (returns null on any failure or when disabled).
 */
export function ensureInstalled(
  key: string,
  spec: InstallSpec,
  log?: (msg: string) => void,
): Promise<string | null> {
  const already = resolveInstalled(key, spec);
  if (already) return Promise.resolve(already);
  if (!autoInstallEnabled()) return Promise.resolve(null);
  const decision = installDecision(key);
  if (decision === "never") return Promise.resolve(null);
  if (decision !== "yes") {
    undecided.set(key, spec);
    return Promise.resolve(null);
  }

  let p = inflight.get(key);
  if (!p) {
    p = doInstall(key, spec, log).catch(() => null);
    inflight.set(key, p);
  }
  return p;
}

async function doInstall(key: string, spec: InstallSpec, log?: (m: string) => void): Promise<string | null> {
  log?.(`installing ${key} (${spec.source})…`);
  await fs.mkdir(installDir(key), { recursive: true });
  const ok = spec.source === "npm" ? await installNpm(key, spec) : await installGithub(key, spec);
  if (!ok) {
    log?.(`could not install ${key} — using tree-sitter for now`);
    return null;
  }
  const resolved = resolveInstalled(key, spec);
  log?.(resolved ? `installed ${key}` : `installed ${key} but couldn't find its binary`);
  return resolved;
}

/**
 * Ceilings for provisioning. Every wait here is on something external — a registry,
 * a release download, an extract — and provisioning is BEST EFFORT: failing just
 * leaves that language on the tree-sitter tier, which is a working state.
 *
 * Before these existed, none of the three waits below was bounded: the spawns had
 * no timeout and were never killed, and `fetch` had no signal. A stalled install
 * therefore hung forever AND left its process tree behind, and because installs are
 * deduped through `inflight`, the never-resolving promise was handed to every later
 * caller for the rest of the session. That is the shape of "fresh project dirs,
 * processes piling up, runs hanging past ten minutes": a fresh dir is exactly when
 * provisioning runs, and a warm one skips it entirely.
 */
const NPM_INSTALL_TIMEOUT_MS = 180_000; // a real install of a language server
const DOWNLOAD_TIMEOUT_MS = 120_000; // release asset, tens of MB
const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Run a child to completion, but never wait forever: on timeout the whole process
 * tree is killed and the step reports failure. Tree-killing matters because the
 * things spawned here (npm, tar) start children of their own, and killing only the
 * shell leaves those holding on.
 */
export function runBounded(command: string, args: readonly string[], options: Parameters<typeof spawnManaged>[2], timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawnManaged(command, args, options);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(false);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

// ── npm source ──────────────────────────────────────────────────────────────
async function installNpm(key: string, spec: NpmInstall): Promise<boolean> {
  const dir = installDir(key);
  // Root npm at this dir with a private package.json — otherwise npm walks up
  // looking for one and can try to write node_modules at the drive root (EPERM).
  await fs.writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: `mindweave-server-${key}`, version: "0.0.0", private: true }),
  );
  // Pass the whole command as one string for the shell (npm is a .cmd shim on
  // Windows). Args are from the curated registry, not user input.
  //
  // --ignore-scripts: no package here needs an install script, and without the flag the
  // server's and EVERY dependency's install scripts ran as the user, from whatever
  // versions the registry served that day.
  const cmd = `npm install ${spec.package}@${spec.version} --ignore-scripts --no-save --no-audit --no-fund --loglevel=error`;
  return runBounded(cmd, [], { cwd: dir, shell: true, stdio: "ignore" }, NPM_INSTALL_TIMEOUT_MS);
}

// ── github source ────────────────────────────────────────────────────────────
async function installGithub(key: string, spec: GithubInstall): Promise<boolean> {
  const target = spec.targets[platformKey()];
  if (!target) return false; // this OS/arch isn't published — degrade to tree-sitter
  const dir = installDir(key);
  const asset = target.asset.replaceAll("{version}", spec.version);
  const url = `https://github.com/${spec.repo}/releases/download/${spec.version}/${asset}`;
  const archive = join(dir, asset);

  if (!(await download(url, archive, target.sha256))) return false;
  try {
    if (asset.endsWith(".zip")) {
      new AdmZip(archive).extractAllTo(dir, true);
    } else if (asset.endsWith(".tar.gz") || asset.endsWith(".tgz") || asset.endsWith(".tar.xz")) {
      if (!(await runTar(archive, dir))) return false;
    } else if (asset.endsWith(".gz")) {
      // Single-file gzip → the decompressed bytes ARE the binary.
      const out = zlib.gunzipSync(await fs.readFile(archive));
      await fs.mkdir(join(dir, target.bin, ".."), { recursive: true });
      await fs.writeFile(join(dir, target.bin.replaceAll("{version}", spec.version)), out);
    } else {
      return false; // unknown archive format
    }
  } catch {
    return false;
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {});
  }

  const bin = join(dir, target.bin.replaceAll("{version}", spec.version));
  if (!IS_WIN && existsSync(bin)) {
    try {
      await fs.chmod(bin, 0o755);
    } catch {
      /* not fatal */
    }
  }
  return existsSync(bin);
}

/** Download `url` to `dest` (follows GitHub's redirect to the CDN), only if it has the expected SHA-256. */
async function download(url: string, dest: string, sha256: string): Promise<boolean> {
  // AbortSignal.timeout covers the whole exchange, body included — a stalled
  // download mid-body is the realistic failure, not a stalled connect.
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return false;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== sha256.toLowerCase()) return false;
    await fs.writeFile(dest, bytes);
    return true;
  } catch {
    return false;
  }
}

/** Extract a tarball with the system `tar` (handles .tar.gz / .tar.xz on every
 *  platform; Windows 10+ ships bsdtar). */
function runTar(archive: string, dir: string): Promise<boolean> {
  return runBounded("tar", ["-xf", archive, "-C", dir], { stdio: "ignore" }, EXTRACT_TIMEOUT_MS);
}
