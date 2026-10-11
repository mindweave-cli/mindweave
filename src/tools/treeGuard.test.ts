/**
 * treeGuard.test.ts — a run that changes the project's files is seen, and named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeCount, giveToUndo, nameChanges, snapshotTree, treeChanges } from "./treeGuard.js";
import { Checkpoints } from "./checkpoints.js";

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mw-tree-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await mkdir(join(root, "out"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(join(root, "node_modules", "dep", "x.js"), "x");
  await writeFile(join(root, "out", "built.js"), "built");
  return root;
}

test("a file that was rewritten, one that was created and one that was deleted are each seen", async () => {
  const root = await project();
  try {
    const before = await snapshotTree(root);
    await writeFile(join(root, "src", "a.ts"), "export const a = 99;\n");
    await rm(join(root, "src", "b.ts"));
    await writeFile(join(root, "src", "c.ts"), "new");
    const c = await treeChanges(before);
    assert.deepEqual(c.changed.map((p) => p.split(/[\\/]/).pop()), ["a.ts"]);
    assert.deepEqual(c.deleted.map((p) => p.split(/[\\/]/).pop()), ["b.ts"]);
    assert.deepEqual(c.created.map((p) => p.split(/[\\/]/).pop()), ["c.ts"]);
    assert.equal(changeCount(c), 3);
    assert.equal(nameChanges(root, c), "src/a.ts, src/c.ts (new), src/b.ts (deleted)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed packages and build output are not the project: a build that rewrites them changes nothing", async () => {
  const root = await project();
  try {
    const before = await snapshotTree(root);
    await writeFile(join(root, "out", "built.js"), "rebuilt, and longer");
    await writeFile(join(root, "out", "new.js"), "new");
    await writeFile(join(root, "node_modules", "dep", "x.js"), "changed");
    assert.equal(changeCount(await treeChanges(before)), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file touched but left with the same text is not a change", async () => {
  const root = await project();
  try {
    const before = await snapshotTree(root);
    const file = join(root, "src", "a.ts");
    await writeFile(file, await readFile(file, "utf8"));
    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    assert.equal(changeCount(await treeChanges(before)), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("what .gitignore excludes is left out as well", async () => {
  const root = await project();
  try {
    await writeFile(join(root, ".gitignore"), "generated/\n*.log\n");
    await mkdir(join(root, "generated"), { recursive: true });
    await writeFile(join(root, "generated", "g.ts"), "1");
    const before = await snapshotTree(root);
    await writeFile(join(root, "generated", "g.ts"), "2");
    await writeFile(join(root, "debug.log"), "noise");
    assert.equal(changeCount(await treeChanges(before)), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file is handed to the undo net with its before, so undo can put it back", async () => {
  const root = await project();
  try {
    const before = await snapshotTree(root);
    const file = join(root, "src", "a.ts");
    await writeFile(file, "export const a = 99;\n");
    await writeFile(join(root, "src", "c.ts"), "new");
    const c = await treeChanges(before);
    const cp = new Checkpoints();
    const r = await giveToUndo(cp, c);
    assert.deepEqual(r, { covered: 2, notCovered: 0 });
    cp.seal("verifier");
    assert.equal(cp.hasUndo(), true, "a checkpoint exists for it");
    await cp.undo();
    assert.equal(await readFile(file, "utf8"), "export const a = 1;\n", "the rewritten file is back as it was");
    await assert.rejects(readFile(join(root, "src", "c.ts"), "utf8"), "the file it created is gone again");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file too big to hold is reported as not covered, never as covered", async () => {
  const root = await project();
  try {
    const big = join(root, "src", "big.txt");
    await writeFile(big, "x".repeat(300 * 1024));
    const before = await snapshotTree(root);
    await writeFile(big, "y".repeat(300 * 1024));
    const c = await treeChanges(before);
    assert.equal(c.changed.length, 1);
    const r = await giveToUndo(new Checkpoints(), c);
    assert.deepEqual(r, { covered: 0, notCovered: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tree that cannot be read gives an empty snapshot and no changes, never an error", async () => {
  const before = await snapshotTree(join(tmpdir(), "mw-does-not-exist-" + Date.now()));
  assert.equal(before.files.size, 0);
  assert.equal(changeCount(await treeChanges(before)), 0);
});
