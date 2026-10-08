/**
 * multiroot.test.ts — the workspace spanning more than one root.
 *
 * The contract: paths stay collision-proof via `label/relative`, that string
 * round-trips back to the right root, search covers every root, and add/remove
 * roots behaves. This is the "nothing collides" guarantee for /include.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { canonicalRoot, relativize, resolvePath, rootsOf, searchUnits, anchorOf } from "./paths.js";
import { addRoot, removeRoot, workspaceTool } from "./workspace.js";
import { grepDef } from "./grep.js";
import type { ToolContext } from "./types.js";

function ctx(cwd: string, roots: string[]): ToolContext {
  return { cwd, roots, reads: new Map(), todos: [] };
}

async function twoRoots(fn: (a: string, b: string) => Promise<void>) {
  const a = await mkdtemp(join(tmpdir(), "mindweave-rootA-"));
  const b = await mkdtemp(join(tmpdir(), "mindweave-rootB-"));
  try {
    await fn(a, b);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
}

test("relativize labels by root; resolvePath round-trips the label", async () => {
  await twoRoots(async (a, b) => {
    const c = ctx(a, [a, b]);
    const labelA = basename(a);
    const labelB = basename(b);

    assert.equal(relativize(c, join(a, "src", "x.ts")), `${labelA}/src/x.ts`);
    assert.equal(relativize(c, join(b, "y.ts")), `${labelB}/y.ts`);
    // The labeled string resolves back to the exact file.
    assert.equal(resolvePath(c, `${labelB}/y.ts`), join(b, "y.ts"));
    assert.equal(resolvePath(c, `${labelA}/src/x.ts`), join(a, "src", "x.ts"));
  });
});

test("single root is unchanged (no labels)", async () => {
  await twoRoots(async (a) => {
    const c = ctx(a, [a]);
    assert.equal(relativize(c, join(a, "x.ts")), "x.ts"); // plain relative, no label
  });
});

test("searchUnits sweeps all roots when no path, one when given", async () => {
  await twoRoots(async (a, b) => {
    const c = ctx(a, [a, b]);
    assert.equal(searchUnits(c, undefined).length, 2);
    const one = searchUnits(c, `${basename(b)}`);
    assert.equal(one.length, 1);
    assert.equal(one[0]!.root, b);
  });
});

test("grep spans both roots and labels every hit", async () => {
  await twoRoots(async (a, b) => {
    await fs.writeFile(join(a, "a.txt"), "the needle is here\n");
    await fs.mkdir(join(b, "sub"));
    await fs.writeFile(join(b, "sub", "b.txt"), "another needle there\n");

    const c = ctx(a, [a, b]);
    const res = await grepDef.execute({ pattern: "needle", output_mode: "files_with_matches" }, c);
    assert.ok(!res.isError);
    assert.ok(res.output.includes(`${basename(a)}/a.txt`), res.output);
    assert.ok(res.output.includes(`${basename(b)}/sub/b.txt`), res.output);
  });
});

test("addRoot / removeRoot manage the live workspace", async () => {
  await twoRoots(async (a, b) => {
    const c = ctx(a, [a]);
    const added = await addRoot(c, b);
    assert.equal(added.label, basename(b));
    // Roots are stored CANONICAL. These fixtures live in tmpdir(), which is behind a
    // symlink on macOS, so asserting the literal input here would pass on Windows and
    // fail there — the fixture would be dodging the very thing the code now does.
    assert.deepEqual(c.roots, [a, await canonicalRoot(b)]);

    // Idempotent.
    assert.equal((await addRoot(c, b)).already, true);

    const removed = removeRoot(c, basename(b));
    assert.equal(removed.removed, basename(b));
    assert.deepEqual(c.roots, [a]);

    // Can't remove the primary.
    assert.ok(removeRoot(c, basename(a)).error);
  });
});

test("the same folder cannot be added twice under different spellings", async () => {
  // MEASURED before the fix: `RealApi`, `realapi` and a junction pointing at RealApi
  // became THREE roots with three labels. Every search then walked that tree three
  // times and reported each hit three ways, and an edit recorded under one label left
  // the freshness ledger for the others stale. `addRoot` was the one entry point that
  // skipped the canonicalisation paths.ts says every root goes through.
  await twoRoots(async (a, b) => {
    const c = ctx(a, [a]);
    const real = join(b, "RealApi");
    await fs.mkdir(real);
    assert.equal((await addRoot(c, real)).already, undefined, "first add is new");

    // Same directory, different case. Windows and macOS both resolve this to one place.
    const cased = join(b, "realapi");
    const byCase = await addRoot(c, cased);
    if ((await fs.realpath(cased).catch(() => "")) === (await fs.realpath(real))) {
      assert.equal(byCase.already, true, "a case variant is the same folder");
    }

    // Same directory, reached through a link.
    const link = join(b, "linkApi");
    try {
      await fs.symlink(real, link, "junction");
    } catch {
      assert.equal(rootsOf(c).length, 2);
      return; // no privilege to create links here
    }
    assert.equal((await addRoot(c, link)).already, true, "a link to it is the same folder");
    assert.equal(rootsOf(c).length, 2, "one primary + one real folder, however it was spelled");
  });
});

// ── Consent: widening the workspace is not something to assume ─────────────────
// Both tools guarded on `if (ctx.requestApproval)`, so the absence of a way to ask was
// treated as permission. A sub-agent has no channel by design, which made that the
// normal case rather than an edge one.

test("a proactive add with no way to ask does not add", async () => {
  await twoRoots(async (a, b) => {
    const c = ctx(a, [a]); // no requestApproval
    const r = await workspaceTool.execute({ path: b, proactive: true }, c);
    assert.deepEqual(c.roots, [a], "the workspace was widened without consent");
    assert.match(r.output, /no way to ask/i);
    assert.notEqual(r.isError, true, "it is a refusal to act, not a failure to retry");
  });
});

test("an add without `proactive` asks too: 'the user asked' is only the model's claim", async () => {
  // Leaving the flag out used to add any folder with no question, the home folder
  // included, and writes there then no longer counted as outside the workspace.
  await twoRoots(async (a, b) => {
    const silent = ctx(a, [a]); // no requestApproval
    const r = await workspaceTool.execute({ path: b }, silent);
    assert.deepEqual(silent.roots, [a], "the workspace was widened without consent");
    assert.match(r.output, /no way to ask/i);

    let asked = 0;
    const c: ToolContext = {
      ...ctx(a, [a]),
      requestApproval: async () => {
        asked++;
        return "Yes, include it";
      },
    };
    await workspaceTool.execute({ path: b }, c);
    assert.equal(asked, 1);
    assert.deepEqual(c.roots, [a, await canonicalRoot(b)]);
  });
});

test("the home folder, a drive root and a system folder are refused even with a yes", async () => {
  await twoRoots(async (a) => {
    const c: ToolContext = { ...ctx(a, [a]), requestApproval: async () => "Yes, include it" };
    const tooBroad = [homedir(), parse(a).root, process.platform === "win32" ? process.env["SystemRoot"] ?? "C:\\Windows" : "/etc"];
    for (const folder of tooBroad) {
      const r = await workspaceTool.execute({ path: folder }, c);
      assert.deepEqual(c.roots, [a], `${folder} was added`);
      assert.match(r.output, /\/include/, "the user is told how to add it themselves");
    }
  });
});

test("link_workspace with no way to ask adds nothing and reports what it found", async () => {
  await twoRoots(async (a, b) => {
    // A sibling project, so discovery has something to return.
    await fs.mkdir(join(b, "sibling"));
    await fs.writeFile(join(b, "sibling", "package.json"), "{}");
    const primary = join(b, "app");
    await fs.mkdir(primary);
    await fs.writeFile(join(primary, "package.json"), "{}");

    const c = ctx(primary, [primary]); // no requestApproval
    const before = [...rootsOf(c)];
    const r = await workspaceTool.execute({}, c);
    assert.deepEqual(c.roots, before, "a bulk add happened with nobody asked");
    if (/related folder/i.test(r.output)) assert.match(r.output, /no way to ask/i);
  });
});

// ── Fix B: file-path resolution is anchored to the root, not the shell cwd ──

test("relative paths resolve against the fixed anchor even after cd moved cwd", () => {
  // The bug: a build did `cd src-tauri`, moving ctx.cwd into the subdir; a later
  // edit_file("App.css") then resolved to <root>/src-tauri/App.css and failed
  // "file not found". With the anchor decoupling it must resolve to <root>/App.css.
  const root = resolve("/project");
  const movedCwd = join(root, "src-tauri"); // where a `cd` left the shell
  const c: ToolContext = { cwd: movedCwd, roots: [root], reads: new Map(), todos: [] };

  assert.equal(anchorOf(c), root);
  assert.equal(resolvePath(c, "App.css"), resolve(root, "App.css"));
  assert.equal(resolvePath(c, "src/main.rs"), resolve(root, "src/main.rs"));
});

test("single-root: an absent roots list falls back to cwd as the anchor", () => {
  const here = resolve("/here");
  const c: ToolContext = { cwd: here, reads: new Map(), todos: [] };
  assert.equal(anchorOf(c), here);
  assert.equal(resolvePath(c, "a.txt"), resolve(here, "a.txt"));
});

test("relativize shows the shell cwd as a clean subpath of the anchor", () => {
  const root = resolve("/project");
  const c: ToolContext = { cwd: join(root, "src-tauri"), roots: [root], reads: new Map(), todos: [] };
  // run_command's status line does relativize(ctx, ctx.cwd) — should read "src-tauri".
  assert.equal(relativize(c, c.cwd), "src-tauri");
  assert.equal(relativize(c, join(root, "App.css")), "App.css");
});
