/**
 * context.test.ts — the project orientation snapshot.
 *
 * Builds a throwaway project on disk and asserts the snapshot orients correctly:
 * environment is always present, signals detect the manifest, the tree is
 * budgeted and skips ignored dirs, and rendering produces the tagged blocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { collectProjectContext, renderProjectContext } from "./context.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mindweave-ctx-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "demo-app", scripts: { build: "tsc", test: "node" }, devDependencies: { typescript: "5" } }),
  );
  writeFileSync(join(root, "README.md"), "# Demo App\n\nA tiny demo for orientation.");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  // A dir that must be ignored, with a file inside that must NOT show up.
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "junk.js"), "module.exports = {};\n");
  // A planning/notes doc in a notes folder — the kind of file that must always surface.
  mkdirSync(join(root, "notez"));
  writeFileSync(
    join(root, "notez", "feature-ideas.md"),
    "# Feature ideas\n\nInspired by Obsidian, Notion, Scrivener.\n",
  );
  writeFileSync(join(root, "TODO.md"), "# Things to do\n\n- ship it\n");
  // Legal boilerplate and README must NOT be listed as notes docs.
  writeFileSync(join(root, "LICENSE"), "MIT License\n\nCopyright...\n");
  return root;
}

test("environment is always captured", async () => {
  const pc = await collectProjectContext(fixture());
  assert.equal(typeof pc.environment.cwd, "string");
  assert.ok(pc.environment.platform.length > 0);
  assert.match(pc.environment.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(pc.environment.runtime.startsWith("Node"));
});

test("signals detect name, scripts, and TypeScript", async () => {
  const pc = await collectProjectContext(fixture());
  assert.equal(pc.signals.name, "demo-app");
  assert.ok(pc.signals.kinds.includes("Node/TypeScript"));
  assert.deepEqual(pc.signals.scripts.sort(), ["build", "test"]);
  assert.ok(pc.signals.manifests.includes("package.json"));
});

test("tree includes real files and skips ignored dirs", async () => {
  const pc = await collectProjectContext(fixture());
  const flat = pc.tree.lines.join("\n");
  assert.ok(flat.includes("src/"), "should list the src dir");
  assert.ok(flat.includes("index.ts"), "should list a source file");
  assert.ok(!flat.includes("node_modules"), "must skip ignored dirs");
  assert.ok(!flat.includes("junk.js"), "must not descend into ignored dirs");
});

test("readme excerpt is captured", async () => {
  const pc = await collectProjectContext(fixture());
  assert.ok(pc.readme && pc.readme.includes("Demo App"));
});

test("notable docs are surfaced with a descriptor, README/MINDWEAVE/legal excluded", async () => {
  const pc = await collectProjectContext(fixture());
  const paths = pc.docs.map((d) => d.path);
  assert.ok(paths.includes("notez/feature-ideas.md"), "should surface the notes doc in a subfolder");
  assert.ok(paths.includes("TODO.md"), "should surface a root TODO");
  assert.ok(!paths.some((p) => p.toLowerCase().startsWith("readme")), "README is shown separately, not as a note");
  assert.ok(!paths.includes("LICENSE"), "legal boilerplate must be excluded");
  const feature = pc.docs.find((d) => d.path === "notez/feature-ideas.md");
  assert.equal(feature?.desc, "Feature ideas", "descriptor comes from the first heading");
});

test("render produces the tagged blocks the prompt expects", async () => {
  const text = renderProjectContext(await collectProjectContext(fixture()));
  assert.ok(text.includes("<environment>"));
  assert.ok(text.includes("</environment>"));
  assert.ok(text.includes("<project_overview>"));
  assert.ok(text.includes("Project: demo-app"));
  assert.ok(text.includes("Docs & notes"), "the docs section renders");
  assert.ok(text.includes("notez/feature-ideas.md — Feature ideas"), "doc line renders path + descriptor");
});

test("missing directory degrades to environment-only, never throws", async () => {
  const pc = await collectProjectContext(join(tmpdir(), "mindweave-does-not-exist-" + Date.now()));
  assert.equal(pc.tree.lines.length, 0);
  assert.equal(pc.signals.kinds.length, 0);
  // Rendering still yields the environment block.
  assert.ok(renderProjectContext(pc).includes("<environment>"));
});

// ── git: the repository's own config must not be able to run a program ─────────

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A repository with one commit and one modified file, so `status` has work to do. */
function gitRepo(): { root: string; git: (...args: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), "mindweave-ctx-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(root, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(root, "a.txt"), "two\n");
  return { root, git };
}

/** A shell command that leaves a file behind if git ever runs it. */
function markerCommand(root: string): { command: string; marker: string } {
  const marker = `${root}-ran`;
  return { command: `echo ran > "${marker.split(sep).join("/")}"`, marker };
}

test("git snapshot: branch, status and recent commits are captured", { skip: !hasGit() }, async () => {
  const { root } = gitRepo();
  const pc = await collectProjectContext(root);
  assert.ok(pc.git, "a repository is detected");
  assert.match(pc.git.status, /M a\.txt/);
  assert.match(pc.git.recentCommits, /first/);
});

test("git snapshot: core.fsmonitor in the repository's config does not run", { skip: !hasGit() }, async () => {
  const { root, git } = gitRepo();
  const { command, marker } = markerCommand(root);
  git("config", "core.fsmonitor", command);
  const pc = await collectProjectContext(root);
  assert.equal(existsSync(marker), false, "the repository's fsmonitor program ran");
  assert.match(pc.git?.status ?? "", /M a\.txt/, "status is still read");
});

test("git snapshot: a content filter in the repository's config does not run", { skip: !hasGit() }, async () => {
  const { root, git } = gitRepo();
  const { command, marker } = markerCommand(root);
  writeFileSync(join(root, ".gitattributes"), "*.txt filter=probe\n");
  git("config", "filter.probe.clean", command);
  const pc = await collectProjectContext(root);
  assert.equal(existsSync(marker), false, "the repository's filter program ran");
  assert.match(pc.git?.status ?? "", /content filters/, "status is left out and says why");
  assert.match(pc.git?.recentCommits ?? "", /first/, "the rest of the snapshot is kept");
});
