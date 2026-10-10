/**
 * selfUpdate.ts — deciding whether this copy of Mindweave may update itself, and how.
 *
 * Pure. Nothing here touches the disk, the network or a process; every question about
 * the outside world arrives through `InstallProbe`. That is deliberate, because this is
 * the part of `/update` that can do damage: the command it produces is run with `-g`, and
 * a wrong answer here means npm rewriting something that was never ours to rewrite.
 *
 * ## The mistake this file exists to avoid
 *
 * The obvious implementation asks npm where global packages go (`npm config get prefix`)
 * and installs there. That is wrong, and it is wrong in a way that looks fine on the
 * machine you wrote it on. A package can be installed under one prefix while npm is
 * configured with another — `npm i -g` without an explicit prefix landing in
 * `~/.local` while `npm config get prefix` says `/usr` is a documented, reported case.
 * The updater then either fails on permissions or, worse, SUCCEEDS: it installs a fresh
 * copy somewhere the user's `mindweave` command does not look, reports victory, and
 * leaves them running the old version with no way to tell.
 *
 * So the prefix is never asked for. It is DERIVED from where this code actually is,
 * and the derivation is confirmed by finding our own launcher where a global install
 * would have put it. If that does not check out, this refuses rather than guessing.
 *
 * ## What it refuses, and why each one matters
 *
 * - a working tree (`mwdev` and the like): `npm i -g` would replace a source build with
 *   a published one, silently undoing whatever was being worked on
 * - a linked install: the same, one indirection further away
 * - a local dependency: not ours to update, and `-g` would not update it anyway
 * - anything it cannot place: the honest answer, not a guess with a `-g` on the end
 */

/** Questions about the filesystem, injected so this module never touches it. */
export interface InstallProbe {
  /** Is this path a symlink or junction, rather than a real directory? */
  isLink(path: string): boolean;
  /** Does this path exist at all? */
  exists(path: string): boolean;
}

/** Where this copy lives, and what may be done about it. */
export type Install =
  /** A global npm install, updatable at `prefix`. */
  | { kind: "global"; packageRoot: string; prefix: string }
  /** A working tree, or a link into one. Updating would overwrite a source build. */
  | { kind: "source"; packageRoot: string }
  /** The copy that ships inside the mwcode desktop app. It updates when the app does. */
  | { kind: "app"; packageRoot: string }
  /** A dependency of some project. `-g` would not touch it, and it is not ours anyway. */
  | { kind: "local"; packageRoot: string }
  /** Somewhere this cannot place. Refused rather than guessed at. */
  | { kind: "unknown"; packageRoot: string };

/** Split a path on either separator, so one implementation reads both shapes. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s !== "");
}

/** Rebuild a path from segments, in the style the input was written in. */
function join(parts: string[], windows: boolean): string {
  return windows ? parts.join("\\") : "/" + parts.join("/");
}

/** Does this path look like a Windows one — a drive letter or a UNC root? */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("\\\\");
}

/**
 * The launcher a global install writes beside its `node_modules`.
 *
 * Finding it is what turns "these path segments look global" into evidence. A project
 * that happens to depend on Mindweave has the identical `node_modules/mindweave` shape
 * one directory down from its own root; only a global prefix also holds the launcher.
 */
function launcherPaths(prefix: string, windows: boolean): string[] {
  return windows
    ? [`${prefix}\\mindweave.cmd`, `${prefix}\\mindweave`]
    : [`${prefix}/bin/mindweave`, `${prefix}/mindweave`];
}

/**
 * Place this copy of Mindweave from the directory its package sits in.
 *
 * `packageRoot` is the directory holding our `package.json` — the parent of `dist`, not
 * the path of the running file.
 */
export function classifyInstall(packageRoot: string, probe: InstallProbe): Install {
  const windows = isWindowsPath(packageRoot);
  const parts = segments(packageRoot);

  // A link at our own directory is `npm link` or a junction into a checkout. It is
  // checked before anything else: the segments of a linked install look exactly like a
  // real one, and following them would land the update on the target of the link.
  if (probe.isLink(packageRoot)) return { kind: "source", packageRoot };

  // The copy bundled in the desktop app sits under its `resources/app` folder. npm cannot
  // update it, and a second global copy would not change which one runs.
  if (/(^|[\\/])resources[\\/]app(\.asar)?[\\/]node_modules[\\/]mindweave$/i.test(packageRoot)) {
    return { kind: "app", packageRoot };
  }

  // Running straight out of a checkout — the dev shim's shape. No `node_modules` above
  // us, and a repository beside us.
  const parent = parts[parts.length - 2];
  if (parent !== "node_modules") {
    return probe.exists(`${packageRoot}${windows ? "\\" : "/"}.git`)
      ? { kind: "source", packageRoot }
      : { kind: "unknown", packageRoot };
  }

  // `<prefix>/node_modules/mindweave` on Windows, `<prefix>/lib/node_modules/mindweave`
  // elsewhere. Drop our own directory and the `node_modules` above it, then the `lib` if
  // this is the POSIX shape.
  const above = parts.slice(0, -2);
  const base = above[above.length - 1] === "lib" ? above.slice(0, -1) : above;
  if (base.length === 0) return { kind: "unknown", packageRoot };
  const prefix = join(base, windows);

  // The launcher is the proof. Without it this is a project's own dependency that
  // happens to have the same shape, and `-g` would install somewhere else entirely
  // while reporting success.
  if (!launcherPaths(prefix, windows).some((p) => probe.exists(p))) {
    return { kind: "local", packageRoot };
  }
  return { kind: "global", packageRoot, prefix };
}

/**
 * The exact command that updates a global install.
 *
 * `--prefix` is not optional and not a nicety. Without it npm resolves the target from
 * its own configuration, which is the one thing this module has established it must not
 * trust — see the file header.
 */
export function updateCommand(prefix: string, version = "latest"): { command: string; args: string[] } {
  return { command: "npm", args: ["install", "-g", "--prefix", prefix, `mindweave@${version}`] };
}

/** The command to type by hand, for every path where this declines to act. */
export function manualCommand(install: Install): string {
  return install.kind === "global"
    ? updateCommand(install.prefix).args.reduce((s, a) => `${s} ${a}`, "npm")
    : "npm install -g mindweave@latest";
}

/** Why an update is not being attempted, in the user's terms. */
export function refusalReason(install: Install): string | null {
  switch (install.kind) {
    case "global":
      return null;
    case "source":
      return (
        "This is running from a working tree, not an installed copy. Updating would " +
        "replace your build with the published one. Run `npm run build` there instead."
      );
    case "app":
      return "This copy comes with the mwcode app, so it updates when the app does.";
    case "local":
      return "This copy is a dependency of another project, so it is that project's to update.";
    case "unknown":
      return "This copy is not in a place an update can be placed, so nothing was changed.";
  }
}
