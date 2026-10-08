/**
 * governor.test.ts — the per-project control layer (deterministic, no network).
 *
 * Exercises the three pieces directly against a temp project state dir: rule
 * loading/rendering, skill catalog + body (progressive disclosure), and the
 * forbidden matchers (the pure path/command checks the mutating tools rely on).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import { loadRules, renderRules, parseGlobs } from "./rules.js";
import { createRuleScope, noteScopePath, rescope } from "./scope.js";
import { loadSkillCatalog, loadSkillBody, findSkill, renderSkillCatalog, activeSkills, substituteSkillArgs } from "./skills.js";
// A root that is absolute on every platform: "D:" alone is a drive on Windows and a relative folder name elsewhere.
const DRIVE = process.platform === "win32" ? "D:" : "/mnt-d";
import { parseForbidden, forbiddenPathReason, forbiddenCommandReason, parseForbiddenCommands, forbiddenCommandPatternReason } from "./forbidden.js";

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(join(tmpdir(), "mindweave-gov-"));
}

test("parseFrontmatter reads key/value header and trims body", () => {
  const { data, body } = parseFrontmatter("---\nname: foo\ndescription: a bar\n---\nHello\nworld\n");
  assert.equal(data.name, "foo");
  assert.equal(data.description, "a bar");
  assert.equal(body, "Hello\nworld");
});

test("parseFrontmatter with no header returns whole text as body", () => {
  const { data, body } = parseFrontmatter("just a body, no header");
  assert.deepEqual(data, {});
  assert.equal(body, "just a body, no header");
});

test("loadRules reads each rules/*.md and renders bodies; skips empties", async () => {
  const dir = await tempDir();
  await fs.mkdir(join(dir, "rules"), { recursive: true });
  await fs.writeFile(join(dir, "rules", "a.md"), "---\nname: pnpm\ndescription: pkg mgr\n---\nUse pnpm, never npm.");
  await fs.writeFile(join(dir, "rules", "b.md"), "---\nname: empty\n---\n"); // no body → skipped

  const rules = await loadRules(dir);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, "pnpm");
  assert.equal(rules[0].body, "Use pnpm, never npm.");
  assert.equal(renderRules(rules), "- Use pnpm, never npm.");
  assert.equal(renderRules([]), "");
});

test("loadRules returns [] when there is no rules dir", async () => {
  const dir = await tempDir();
  assert.deepEqual(await loadRules(dir), []);
});

test("parseGlobs splits comma/space and normalizes leading ./ and trailing /", () => {
  assert.deepEqual(parseGlobs("src/api/**, ./src/routes/ test/**"), ["src/api/**", "src/routes", "test/**"]);
  assert.deepEqual(parseGlobs(undefined), []);
});

test("glob-scoped rules fire once a matching path is touched; always-on always fire", async () => {
  const dir = await tempDir();
  await fs.mkdir(join(dir, "rules"), { recursive: true });
  await fs.writeFile(join(dir, "rules", "global.md"), "---\nname: pm\n---\nUse pnpm.");
  await fs.writeFile(join(dir, "rules", "api.md"), "---\nname: api\nglobs: src/api/**\n---\nAPI routes are kebab-case.");
  const rules = await loadRules(dir);
  assert.equal(rules.find((r) => r.name === "api")?.globs?.[0], "src/api/**");

  const root = process.platform === "win32" ? "D:\proj" : "/proj";
  const scope = createRuleScope();
  // Nothing touched yet, so only the always-on rule.
  assert.equal(renderRules(rules, scope.matched), "- Use pnpm.");

  // A path elsewhere leaves the scoped rule out.
  noteScopePath(scope, rules, root, join(root, "src", "web", "app.ts"));
  assert.equal(renderRules(rules, scope.matched), "- Use pnpm.");

  // A path under src/api fires it.
  noteScopePath(scope, rules, root, join(root, "src", "api", "users.ts"));
  const both = renderRules(rules, scope.matched);
  assert.match(both, /Use pnpm/);
  assert.match(both, /kebab-case/);

  // And it STAYS fired: the match is remembered, not re-derived from the paths, so
  // later work elsewhere cannot un-apply a rule that already became relevant.
  noteScopePath(scope, rules, root, join(root, "docs", "readme.md"));
  assert.match(renderRules(rules, scope.matched), /kebab-case/);
});

test("skills: catalog is metadata only; body loads on demand", async () => {
  const dir = await tempDir();
  const skillDir = join(dir, "skills", "ship");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: ship\ndescription: release flow\nwhen_to_use: cutting a release\n---\n1. bump\n2. tag\n3. publish",
  );
  // A directory without SKILL.md is ignored.
  await fs.mkdir(join(dir, "skills", "notaskill"), { recursive: true });

  const catalog = await loadSkillCatalog(dir);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].name, "ship");
  assert.equal(catalog[0].whenToUse, "cutting a release");
  assert.match(renderSkillCatalog(catalog), /ship: release flow — use when: cutting a release/);

  const found = findSkill(catalog, "/ship");
  assert.ok(found);
  const body = await loadSkillBody(found);
  assert.match(body ?? "", /1\. bump/);
});

test("skills: argument-hint + globs parse; catalog scopes by working set", async () => {
  const dir = await tempDir();
  const mk = async (name: string, fm: string) => {
    const d = join(dir, "skills", name);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(join(d, "SKILL.md"), `---\n${fm}\n---\nbody`);
  };
  await mk("deploy", "name: deploy\ndescription: ship it\nargument-hint: <env>");
  await mk("apitest", "name: apitest\ndescription: api tests\nglobs: src/api/**");

  const catalog = await loadSkillCatalog(dir);
  const deploy = catalog.find((s) => s.name === "deploy");
  assert.equal(deploy?.argumentHint, "<env>");
  const apitest = catalog.find((s) => s.name === "apitest");
  assert.deepEqual(apitest?.globs, ["src/api/**"]);

  // Always-listed shows the hint; scoped one only when the working set matches.
  assert.match(renderSkillCatalog(catalog, []), /deploy <env>: ship it/);
  assert.equal(activeSkills(catalog, []).some((s) => s.name === "apitest"), false);
  assert.equal(activeSkills(catalog, ["src/api/x.ts"]).some((s) => s.name === "apitest"), true);
});

test("substituteSkillArgs fills $ARGUMENTS / $1, else appends as context", () => {
  assert.equal(substituteSkillArgs("Deploy to $1 now.", "staging"), "Deploy to staging now.");
  assert.equal(substituteSkillArgs("Args: $ARGUMENTS.", "a b c"), "Args: a b c.");
  assert.match(substituteSkillArgs("No placeholders here.", "extra"), /Additional context from the user: extra/);
  assert.equal(substituteSkillArgs("Plain body.", ""), "Plain body.");
});

test("a skill body keeps its shell and its dollar amounts", () => {
  // A skill is a markdown playbook, so `awk '{print $1}'` and "$100" are ordinary
  // content. `/\$(\d+)/` matched $100 as positional argument one hundred, found none,
  // and substituted the empty string — so the steps the model was told to follow were
  // quietly not the steps on disk, and with NO arguments every $n vanished.
  const body = "awk '{print $1}' f.txt — budget $100, tier two $250.";
  assert.equal(substituteSkillArgs(body, ""), body, "no arguments must not rewrite the body");
  assert.match(substituteSkillArgs(body, "staging"), /budget \$100, tier two \$250\./);
});

test("an unfilled positional stays visible instead of being blanked", () => {
  // Deleting it makes a skill that wanted an argument read as though it never did.
  assert.equal(substituteSkillArgs("Deploy to $1.", ""), "Deploy to $1.");
  assert.equal(substituteSkillArgs("Deploy $1 to $2.", "app"), "Deploy app to $2.");
});

test("a dollar amount is not mistaken for a placeholder the skill declared", () => {
  // Distinct from the blanking bug above, and the reason `$1`-`$9` is the right range
  // rather than `\d+`: `hasPlaceholder` decides whether arguments get APPENDED as
  // context. A body whose only "$number" is a price was read as already parameterised,
  // so a plain skill invoked with arguments silently dropped them.
  const body = "Ask for approval above $500.";
  assert.match(
    substituteSkillArgs(body, "urgent"),
    /Additional context from the user: urgent/,
    "arguments vanished because a price looked like a placeholder",
  );
});

test("a $1 inside the user's own arguments is not substituted again", () => {
  // Two chained replaces meant the argument text was rescanned as if it were body.
  assert.equal(substituteSkillArgs("Target: $ARGUMENTS.", "a $1 b"), "Target: a $1 b.");
});

test("forbidden: parse strips comments/blanks and leading ./ and trailing /", () => {
  const patterns = parseForbidden("# secrets\nsrc/legacy/\n\n./config/prod.json\n*.pem\n");
  assert.deepEqual(patterns, ["src/legacy", "config/prod.json", "*.pem"]);
});

test("forbidden: path matching covers dirs, files, globs, and ignores outside-root", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";
  const cfg = { patterns: ["src/legacy", "config/prod.json", "*.pem"], root };
  const abs = (p: string) => join(root, p);

  // Folder prefix: the dir itself and anything under it.
  assert.equal(forbiddenPathReason(cfg, abs("src/legacy")), "src/legacy");
  assert.equal(forbiddenPathReason(cfg, abs("src/legacy/old.ts")), "src/legacy");
  // Exact file.
  assert.equal(forbiddenPathReason(cfg, abs("config/prod.json")), "config/prod.json");
  // Glob in the root.
  assert.equal(forbiddenPathReason(cfg, abs("key.pem")), "*.pem");
  // Allowed paths.
  assert.equal(forbiddenPathReason(cfg, abs("src/app.ts")), null);
  assert.equal(forbiddenPathReason(cfg, abs("config/dev.json")), null);
  // Outside the project root is never matched by relative patterns.
  assert.equal(forbiddenPathReason(cfg, join(root, "..", "other", "src", "legacy")), null);
  // No config → always allowed.
  assert.equal(forbiddenPathReason(undefined, abs("src/legacy")), null);
});

test("forbidden: command matching refuses when a forbidden path appears", () => {
  const cfg = { patterns: ["src/legacy", "deploy.sh", "*.pem"], root: "/proj" };
  assert.equal(forbiddenCommandReason(cfg, "cat src/legacy/old.ts"), "src/legacy");
  assert.equal(forbiddenCommandReason(cfg, "bash deploy.sh --prod"), "deploy.sh");
  assert.equal(forbiddenCommandReason(cfg, "npm run build"), null);
  // A pure glob has no literal to locate in free-form command text.
  assert.equal(forbiddenCommandReason(cfg, "ls *.pem"), null);
});

test("forbidden-commands: parse keeps lines verbatim, drops comments/blanks", () => {
  assert.deepEqual(
    parseForbiddenCommands("# no servers\ntauri dev\n\n  git push  \n"),
    ["tauri dev", "git push"],
  );
});

test("forbidden-commands: pattern matches as a normalized case-insensitive substring", () => {
  const cfg = { patterns: [], commands: ["tauri dev", "git push"], root: "/proj" };
  // Blocks the command itself and any command that contains it (npm run tauri dev).
  assert.equal(forbiddenCommandPatternReason(cfg, "npm run tauri dev"), "tauri dev");
  assert.equal(forbiddenCommandPatternReason(cfg, "TAURI   DEV"), "tauri dev"); // case + whitespace
  assert.equal(forbiddenCommandPatternReason(cfg, "git push --force origin main"), "git push");
  // Unrelated commands pass; a build is not a dev server.
  assert.equal(forbiddenCommandPatternReason(cfg, "npm run tauri build"), null);
  assert.equal(forbiddenCommandPatternReason(cfg, "git status"), null);
  // No commands configured (or none at all) → always allowed.
  assert.equal(forbiddenCommandPatternReason({ patterns: [], root: "/proj" }, "tauri dev"), null);
  assert.equal(forbiddenCommandPatternReason(undefined, "tauri dev"), null);
});

// ── the catalog is bounded, because it lives in the cached prefix forever ──────

test("a rambling skill description is clipped, but the skill stays callable", () => {
  // Only the prose is clipped. The NAME and argument hint are what make a skill
  // invocable — use_skill takes a name and nothing lists them — so clipping those
  // would silently remove a capability rather than save tokens.
  const skills = [
    { name: "deploy", description: "x".repeat(500), whenToUse: "y".repeat(500), dir: "/d", argumentHint: "<env>" },
  ] as unknown as Parameters<typeof renderSkillCatalog>[0];

  const out = renderSkillCatalog(skills);
  assert.ok(out.startsWith("- deploy <env>"), "name and hint survive intact");
  assert.ok(out.length < 300, `the line must be bounded, got ${out.length}`);
  assert.match(out, /…/, "and say it was cut");
});

test("a short catalog is untouched", () => {
  const skills = [
    { name: "ship", description: "release flow", whenToUse: "cutting a release", dir: "/d" },
  ] as unknown as Parameters<typeof renderSkillCatalog>[0];
  assert.equal(renderSkillCatalog(skills), "- ship: release flow — use when: cutting a release");
});

test("an absurd number of skills is capped, and the overflow is reported", () => {
  const skills = Array.from({ length: 130 }, (_, i) => ({
    name: `s${i}`,
    description: "d",
    whenToUse: "",
    dir: "/d",
  })) as unknown as Parameters<typeof renderSkillCatalog>[0];

  const out = renderSkillCatalog(skills);
  const entries = out.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(entries.length, 100, "capped at the backstop");
  assert.match(out, /30 more skill\(s\) exist/, "silence here would hide capabilities from the model");
});

test("the deny-list is not escaped by changing a path's case", () => {
  // Windows and macOS filesystems are case-insensitive, so `.env` and `.ENV` are ONE
  // file. A case-sensitive compare let the second spelling straight past a rule written
  // with the first, and nothing adversarial was needed to hit it: a model that writes
  // `.ENV` because it saw that spelling somewhere escaped the deny-list and wrote the
  // very file it was forbidden. Windows is the platform this ships on.
  const cfg = { root: join(DRIVE, "proj"), patterns: [".env", "src/legacy", "secrets/**"] };
  const cases: [string, string[]][] = [
    [".env", [[".env"], [".ENV"], [".Env"]].flat()],
    ["src/legacy", ["src/legacy/a.ts", "src/Legacy/a.ts", "SRC/legacy/a.ts"]],
    ["secrets/**", ["secrets/k.pem", "Secrets/k.pem", "SECRETS/k.pem"]],
  ];
  for (const [pattern, paths] of cases) {
    for (const rel of paths) {
      const abs = join(cfg.root, ...rel.split("/"));
      assert.equal(forbiddenPathReason(cfg, abs), pattern, `${rel} must be caught by ${pattern}`);
    }
  }
});

test("a path that traverses back into a forbidden folder is still caught", () => {
  // `..` is resolved before matching, so dressing the path up does not help.
  const cfg = { root: join(DRIVE, "proj"), patterns: ["src/legacy"] };
  for (const rel of ["src/legacy/../legacy/secret.ts", "harmless/../src/legacy/secret.ts"]) {
    assert.equal(forbiddenPathReason(cfg, join(cfg.root, ...rel.split("/"))), "src/legacy", rel);
  }
});

test("paths outside the project root stay unmatched by relative patterns", () => {
  // Deliberate: a relative pattern describes this project. Matching it against another
  // tree would deny files the rule was never about.
  const cfg = { root: join(DRIVE, "proj"), patterns: ["src/legacy"] };
  assert.equal(forbiddenPathReason(cfg, join(DRIVE, "other", "src", "legacy", "a.ts")), null);
});

test("the shell bypass check is not escaped by case either", () => {
  // `cat SRC/LEGACY/keys` names the same file on Windows as the lower-case spelling.
  const cfg = { root: join(DRIVE, "proj"), patterns: ["src/legacy"] };
  for (const cmd of ["cat src/legacy/keys", "cat SRC/LEGACY/keys", "type Src/Legacy/keys"]) {
    assert.equal(forbiddenCommandReason(cfg, cmd), "src/legacy", cmd);
  }
  assert.equal(forbiddenCommandReason(cfg, "npm test"), null, "unrelated commands still run");
});

test("the deny-list covers every folder in the workspace, not just the first", () => {
  // `/include` adds a second project to a session. Patterns are written relative to a
  // project, and judging them only against the one you opened meant a rule blocking
  // `src/legacy` there quietly did nothing in the folder you added — still listed by
  // /forbidden, still shown as active, simply not in force.
  const primary = join(DRIVE, "backend");
  const added = join(DRIVE, "frontend");
  const cfg = { root: primary, patterns: ["src/legacy", "secrets/**"] };
  const roots = [primary, added];

  for (const base of [primary, added]) {
    assert.equal(forbiddenPathReason(cfg, join(base, "src", "legacy", "a.ts"), roots), "src/legacy", base);
    assert.equal(forbiddenPathReason(cfg, join(base, "secrets", "k.txt"), roots), "secrets/**", base);
    // The other half: an included folder must stay WORKABLE, or /include is useless.
    assert.equal(forbiddenPathReason(cfg, join(base, "src", "app.ts"), roots), null, base);
  }

  // A folder that is not part of this workspace is still none of the rule's business.
  assert.equal(forbiddenPathReason(cfg, join(DRIVE, "elsewhere", "src", "legacy", "a.ts"), roots), null);
});

test("with no extra roots the deny-list behaves exactly as before", () => {
  // The added argument defaults to empty, so a single-root session is unchanged.
  const cfg = { root: join(DRIVE, "proj"), patterns: ["src/legacy"] };
  assert.equal(forbiddenPathReason(cfg, join(DRIVE, "proj", "src", "legacy", "a.ts")), "src/legacy");
  assert.equal(forbiddenPathReason(cfg, join(DRIVE, "other", "src", "legacy", "a.ts")), null);
});
