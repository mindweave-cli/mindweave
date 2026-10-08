/**
 * context.ts — the project orientation snapshot.
 *
 * Without this, Mindweave starts BLIND: the system prompt tells it nothing about the
 * project it's sitting in — not the working directory, the OS, whether it's a git
 * repo, what kind of project it is, or its shape. It would burn a list→read→read
 * just to answer "what is this?". The fix is to gather a small, budgeted snapshot
 * ONCE at session start:
 *
 *   - an <environment> block (cwd, is-git-repo, platform, OS, date) plus a git-status
 *     snapshot (branch, `status --short`, recent commits), so the first turn is oriented.
 *   - a budgeted project snapshot (name, a capped file tree, key manifests) so the
 *     FIRST answer is already informed.
 *
 * This module gathers both ONCE at session start — a
 * snapshot in time, not a live view (it does not update as the conversation runs;
 * the model uses tools for anything current or deeper). It is fully
 * deterministic: no model calls, no tokens to build. The heavy structural map is
 * the chassis (alternator); this is the shallow, always-on orientation layer that
 * sits above it.
 *
 * Pure facts, no instructions: deciding what to DO with the project is the model's
 * job. We only hand it the lay of the land.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { release } from "node:os";
import { join, basename } from "node:path";
import { DEFAULT_IGNORES } from "../tools/walk.js";
import { commandShellLabel } from "../tools/runCommand.js";
import { childEnv } from "../tools/childEnv.js";

// ── budgets (tunable, model-agnostic) ────────────────────────────────────────
const TREE_MAX_DEPTH = envInt("MINDWEAVE_CONTEXT_TREE_DEPTH", 3);
const TREE_MAX_LINES = envInt("MINDWEAVE_CONTEXT_TREE_LINES", 120);
const TREE_MAX_FILES = envInt("MINDWEAVE_CONTEXT_TREE_FILES", 60);
const GIT_STATUS_MAX_CHARS = 2_000;
const GIT_LOG_COUNT = 5;
const README_MAX_CHARS = 800;
const GIT_TIMEOUT_MS = 2_500;
// Docs & notes: the curated, high-signal list of planning/notes docs (roadmaps,
// feature plans, design notes). Surfaced so the model always KNOWS these exist and
// what they are, without having to "remember" them across sessions or dig them out of
// the raw file tree.
const DOCS_MAX_COUNT = 15;
const DOC_DESC_MAX_CHARS = 100;
const DOC_READ_BYTES = 1_024;

// ── shape ────────────────────────────────────────────────────────────────────
export interface Environment {
  cwd: string;
  platform: string;
  osVersion: string;
  shell: string;
  runtime: string;
  date: string;
}

export interface GitSnapshot {
  branch: string;
  /** `git status --short`, truncated; "(clean)" when there are no changes. */
  status: string;
  /** Recent commit subjects (`git log --oneline`). */
  recentCommits: string;
}

export interface ProjectSignals {
  /** Project name from a manifest, when one declares it. */
  name?: string;
  /** Human labels for what this project is, e.g. "Node/TypeScript", "Python". */
  kinds: string[];
  /** Runnable script names (npm scripts today). */
  scripts: string[];
  /** Manifest filenames found at the root. */
  manifests: string[];
}

export interface ProjectTree {
  lines: string[];
  fileCount: number;
  truncated: boolean;
}

/** A notable planning/notes doc: its path (relative, forward-slashed) and a one-line
 *  descriptor pulled from its first heading or line. */
export interface DocEntry {
  path: string;
  desc: string;
}

export interface ProjectContext {
  environment: Environment;
  git: GitSnapshot | null;
  signals: ProjectSignals;
  tree: ProjectTree;
  readme: string | null;
  docs: DocEntry[];
}

// ── collection ───────────────────────────────────────────────────────────────

/**
 * Gather the snapshot for `cwd`. Best-effort throughout: any piece that fails or
 * is absent is simply omitted, so this never throws and never blocks startup for
 * long (git is time-boxed).
 */
export async function collectProjectContext(cwd: string): Promise<ProjectContext> {
  const [git, signals, tree, readme, docs] = await Promise.all([
    collectGit(cwd),
    collectSignals(cwd),
    collectTree(cwd),
    collectReadme(cwd),
    collectDocs(cwd),
  ]);
  return { environment: collectEnvironment(cwd), git, signals, tree, readme, docs };
}

function collectEnvironment(cwd: string): Environment {
  return {
    cwd,
    platform: process.platform,
    osVersion: release(),
    shell: commandShellLabel(),
    runtime: `Node ${process.version}`,
    date: localDate(),
  };
}

async function collectGit(cwd: string): Promise<GitSnapshot | null> {
  const inside = (await runGit(["rev-parse", "--is-inside-work-tree"], cwd))?.trim();
  if (inside !== "true") return null;

  // `status` runs the repository's content filters, and a filter is a program named in
  // the repository's own config, which arrives with any folder that is copied together
  // with its .git directory. Filters cannot be switched off from the command line, so
  // when the repository defines one, status is left out of the snapshot.
  const filters = await repoDefinesFilters(cwd);
  const [branchRaw, statusRaw, logRaw] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    filters ? Promise.resolve(null) : runGit(["status", "--short", "--ignore-submodules=all"], cwd),
    runGit(["log", "--oneline", "--no-show-signature", "-n", String(GIT_LOG_COUNT)], cwd),
  ]);

  const branch = branchRaw?.trim() || "(detached)";
  let status = (statusRaw ?? "").trim();
  if (status.length > GIT_STATUS_MAX_CHARS) {
    status = status.slice(0, GIT_STATUS_MAX_CHARS) + "\n… (truncated; run `git status` for the rest)";
  }
  return {
    branch,
    status: filters ? FILTERED_STATUS : status || "(clean)",
    recentCommits: (logRaw ?? "").trim(),
  };
}

const FILTERED_STATUS =
  "(not read: this repository's own config defines content filters, which git would run; run `git status` yourself if you trust it)";

/**
 * True when the repository's own config (or a file it includes) defines a content
 * filter. Filters from the user's global or system config are the user's own and do not
 * count, so Git LFS installed globally keeps working. Reading config runs no programs.
 * An old git without --show-scope cannot tell the scopes apart, and counts as true.
 */
async function repoDefinesFilters(cwd: string): Promise<boolean> {
  const out = await runGit(
    ["config", "--show-scope", "--includes", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
    cwd,
    GIT_TIMEOUT_MS,
    [0, 1], // 1 means no matching key
  );
  if (out === null) return true;
  return out.split("\n").some((line) => /^(local|worktree)\s/.test(line));
}

/** Manifest → the labels and metadata it implies. */
async function collectSignals(cwd: string): Promise<ProjectSignals> {
  const kinds = new Set<string>();
  const manifests: string[] = [];
  const scripts: string[] = [];
  let name: string | undefined;

  const has = async (f: string): Promise<boolean> => {
    try {
      await fs.access(join(cwd, f));
      manifests.push(f);
      return true;
    } catch {
      return false;
    }
  };

  if (await has("package.json")) {
    const pkg = await readJson(join(cwd, "package.json"));
    if (pkg) {
      if (typeof pkg.name === "string") name = pkg.name;
      if (pkg.scripts && typeof pkg.scripts === "object") {
        scripts.push(...Object.keys(pkg.scripts as Record<string, unknown>));
      }
      const ts = !!(pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
      kinds.add(ts ? "Node/TypeScript" : "Node/JavaScript");
    } else {
      kinds.add("Node");
    }
  }
  // tsconfig confirms TypeScript, but don't double up if package.json already said so.
  if ((await has("tsconfig.json")) && !kinds.has("Node/TypeScript")) kinds.add("TypeScript");
  if (await has("pyproject.toml")) {
    kinds.add("Python");
    name ??= await tomlName(join(cwd, "pyproject.toml"));
  }
  if (await has("requirements.txt")) kinds.add("Python");
  if (await has("Cargo.toml")) {
    kinds.add("Rust");
    name ??= await tomlName(join(cwd, "Cargo.toml"));
  }
  if (await has("go.mod")) kinds.add("Go");
  if (await has("pom.xml")) kinds.add("Java/Maven");
  if (await has("build.gradle") || (await has("build.gradle.kts"))) kinds.add("Java/Gradle");
  if (await has("Gemfile")) kinds.add("Ruby");
  if (await has("composer.json")) kinds.add("PHP");
  if (await has("CMakeLists.txt")) kinds.add("C/C++");

  return { name, kinds: [...kinds], scripts, manifests };
}

/**
 * A budgeted, sorted, pre-order directory tree. Depth, total
 * lines, and file count are all capped so a huge repo degrades to a partial tree
 * instead of exploding the prompt. Skips DEFAULT_IGNORES and dotfiles/dirs.
 */
async function collectTree(cwd: string): Promise<ProjectTree> {
  const lines: string[] = [];
  let fileCount = 0;
  let truncated = false;

  const recurse = async (absDir: string, depth: number): Promise<void> => {
    if (truncated || depth > TREE_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !DEFAULT_IGNORES.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    const files = entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();

    for (const f of files) {
      if (lines.length >= TREE_MAX_LINES || fileCount >= TREE_MAX_FILES) {
        truncated = true;
        return;
      }
      lines.push("  ".repeat(depth) + f);
      fileCount += 1;
    }
    for (const d of dirs) {
      if (lines.length >= TREE_MAX_LINES) {
        truncated = true;
        return;
      }
      lines.push("  ".repeat(depth) + d + "/");
      await recurse(join(absDir, d), depth + 1);
    }
  };

  await recurse(cwd, 0);
  return { lines, fileCount, truncated };
}

/** The opening of a README, if there is one — orients on intent the tree can't. */
async function collectReadme(cwd: string): Promise<string | null> {
  for (const name of ["README.md", "README.rst", "README.txt", "README"]) {
    try {
      const raw = (await fs.readFile(join(cwd, name), "utf8")).trim();
      if (!raw) continue;
      return raw.length > README_MAX_CHARS ? raw.slice(0, README_MAX_CHARS) + "\n… (truncated)" : raw;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Find the project's planning/notes docs — feature plans, roadmaps, design notes,
 * TODOs — anywhere within the walked tree, and read a one-line descriptor for each.
 * This is the curated counterpart to the raw file tree: instead of one filename among
 * dozens, the model gets "notez/feature-ideas.md — Feature ideas" and knows to reach
 * for it. Deterministic and one-time, so nothing has to be "remembered" across
 * sessions. Best-effort: unreadable files are skipped, never thrown.
 */
async function collectDocs(cwd: string): Promise<DocEntry[]> {
  const found: { path: string; depth: number }[] = [];

  const recurse = async (absDir: string, rel: string, depth: number): Promise<void> => {
    if (depth > TREE_MAX_DEPTH || found.length >= DOCS_MAX_COUNT * 4) return;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isFile() && isNotableDoc(e.name)) {
        found.push({ path: rel ? `${rel}/${e.name}` : e.name, depth });
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !DEFAULT_IGNORES.has(e.name) && !e.name.startsWith(".")) {
        await recurse(join(absDir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      }
    }
  };
  await recurse(cwd, "", 0);

  // Shallowest first (root docs matter most), then alphabetical; then cap.
  found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  const top = found.slice(0, DOCS_MAX_COUNT);

  const docs = await Promise.all(
    top.map(async ({ path }): Promise<DocEntry> => ({ path, desc: await docDescriptor(join(cwd, path)) })),
  );
  return docs;
}

/**
 * Whether a filename is a planning/notes doc worth surfacing. Markdown files qualify,
 * as do a handful of conventional names (TODO, ROADMAP, …) whatever their extension.
 * README (shown separately), MINDWEAVE.md (the memory file itself), and legal boilerplate
 * are deliberately excluded.
 */
function isNotableDoc(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("readme") || lower === "mindweave.md") return false;
  if (/^(license|licence|copying|code_of_conduct|contributing|authors|notice)\b/.test(lower)) return false;
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot) : "";
  const base = dot > 0 ? lower.slice(0, dot) : lower;
  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") return true;
  return ["todo", "roadmap", "changelog", "notes", "tasks", "plan", "plans", "ideas", "design"].includes(base);
}

/** A short descriptor for a doc: its first Markdown heading, else its first non-empty
 *  line (YAML frontmatter skipped). "" when the file is empty or unreadable. */
async function docDescriptor(absPath: string): Promise<string> {
  let raw: string;
  try {
    const fh = await fs.open(absPath, "r");
    try {
      const buf = Buffer.alloc(DOC_READ_BYTES);
      const { bytesRead } = await fh.read(buf, 0, DOC_READ_BYTES, 0);
      raw = buf.toString("utf8", 0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
  const lines = raw.split(/\r?\n/);
  let i = 0;
  // Skip a leading YAML frontmatter block (--- … ---).
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i]?.trim() !== "---") i += 1;
    i += 1;
  }
  for (; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    const text = line.replace(/^#+\s*/, "").trim(); // strip Markdown heading marks
    if (!text) continue;
    return text.length > DOC_DESC_MAX_CHARS ? text.slice(0, DOC_DESC_MAX_CHARS) + "…" : text;
  }
  return "";
}

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * Render the snapshot into the text injected into the system prompt, or "" if
 * there is genuinely nothing to say. Two tagged blocks: <environment> (the env block)
 * and <project_overview> (signals + tree + README + git status).
 */
export function renderProjectContext(pc: ProjectContext): string {
  const env = pc.environment;
  const out: string[] = [];

  out.push(
    "<environment>\n" +
      `Working directory: ${env.cwd}\n` +
      `Git repo: ${pc.git ? `yes (branch ${pc.git.branch})` : "no"}\n` +
      `Platform: ${env.platform}\n` +
      `OS version: ${env.osVersion}\n` +
      `Shell: ${env.shell}\n` +
      `Runtime: ${env.runtime}\n` +
      `Today's date: ${env.date}\n` +
      "</environment>",
  );

  const overview: string[] = [];
  const s = pc.signals;
  const head = [s.name, s.kinds.length ? s.kinds.join(", ") : null].filter(Boolean).join(" — ");
  overview.push(`Project: ${head || basename(env.cwd) || env.cwd}`);
  if (s.scripts.length) overview.push(`Scripts: ${s.scripts.join(", ")}`);

  if (pc.docs.length) {
    overview.push(
      "Docs & notes (planning/roadmap/design docs in this project — read one when it's relevant):\n" +
        pc.docs.map((d) => `- ${d.path}${d.desc ? ` — ${d.desc}` : ""}`).join("\n"),
    );
  }

  if (pc.tree.lines.length) {
    const note = pc.tree.truncated ? " (partial — ask tools for more)" : "";
    overview.push(
      `Structure${note} — snapshot, ignores ${[...DEFAULT_IGNORES].slice(0, 3).join("/")}/…:\n` +
        pc.tree.lines.join("\n"),
    );
  }
  if (pc.readme) overview.push(`README (excerpt):\n${pc.readme}`);
  if (pc.git) {
    const git = [`Git status (snapshot at session start) — branch ${pc.git.branch}`];
    if (pc.git.recentCommits) git.push(`Recent commits:\n${pc.git.recentCommits}`);
    git.push(`Changes:\n${pc.git.status}`);
    overview.push(git.join("\n"));
  }

  out.push("<project_overview>\n" + overview.join("\n\n") + "\n</project_overview>");
  return out.join("\n\n");
}

/** Convenience: collect + render in one call. "" when there's nothing useful. */
export async function projectContextText(cwd: string): Promise<string> {
  return renderProjectContext(await collectProjectContext(cwd));
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Settings that make git start a program, switched off for every command this module
 * runs. A setting given with -c outranks the repository's own config, so a folder that
 * arrives with a hostile .git/config cannot run anything when a session opens. Filters
 * cannot be switched off this way; see repoDefinesFilters.
 */
const SAFE_GIT_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
  "-c", "core.sshCommand=",
  "-c", "log.showSignature=false",
  "-c", "protocol.ext.allow=never",
];

const SAFE_GIT_ENV = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
};

/**
 * Run a git command, time-boxed; resolves to stdout when the exit code is one of `okCodes`,
 * null otherwise.
 */
function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS, okCodes: number[] = [0]): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", [...SAFE_GIT_ARGS, ...args], {
        cwd,
        windowsHide: true,
        env: childEnv(SAFE_GIT_ENV),
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      if (out.length < 64_000) out += c.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code !== null && okCodes.includes(code) ? out : null));
  });
}

async function readJson(path: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Pull `name = "..."` from a TOML manifest's [package]/[project] table, cheaply. */
async function tomlName(path: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(path, "utf8");
    const m = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** Local YYYY-MM-DD (the user's calendar day, not UTC). */
function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
