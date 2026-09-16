/**
 * autoMemory.test.ts — the cross-session memory store and the save_memory tool.
 *
 * Pointed at a temp HOME so it never touches the real ~/.mindweave (same scheme as
 * memory.test.ts). Covers: writing a topic file + index pointer, loading the
 * index, update-not-duplicate on the same name, and that the tool saves SILENTLY
 * (there is no ask-before-save gate any more) plus type validation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "mindweave-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const { saveMemory, loadMemoryIndex, memoryDir, slugify } = await import("./autoMemory.js");
const { saveMemoryTool } = await import("../tools/saveMemory.js");
type ToolContext = import("../tools/types.js").ToolContext;

function input(over: Partial<Parameters<typeof saveMemory>[1]> = {}) {
  return {
    name: "User role",
    description: "who the user is",
    type: "user" as const,
    body: "The user is a senior engineer building a terminal agent.",
    indexLine: "senior engineer, building a terminal agent",
    ...over,
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

test("saveMemory writes a topic file and an index pointer", async () => {
  const cwd = "/proj/mem-a";
  const saved = await saveMemory(cwd, input());
  assert.equal(saved.updated, false);
  assert.equal(saved.file, "user-role.md");

  const topic = await fs.readFile(join(memoryDir(cwd), "user-role.md"), "utf8");
  assert.match(topic, /name: User role/);
  assert.match(topic, /type: user/);
  assert.match(topic, /senior engineer building a terminal agent/);

  const index = await fs.readFile(join(memoryDir(cwd), "MEMORY.md"), "utf8");
  assert.match(index, /# Memory Index/);
  assert.match(index, /\[User role\]\(user-role\.md\)/);
});

test("loadMemoryIndex returns the index, or empty when none", async () => {
  assert.equal(await loadMemoryIndex("/proj/mem-empty"), "");
  const cwd = "/proj/mem-b";
  await saveMemory(cwd, input({ name: "Build tool", type: "project", indexLine: "uses pnpm" }));
  const idx = await loadMemoryIndex(cwd);
  assert.match(idx, /\[Build tool\]\(build-tool\.md\) — uses pnpm/);
});

test("saving the same name updates instead of duplicating", async () => {
  const cwd = "/proj/mem-c";
  await saveMemory(cwd, input({ indexLine: "first" }));
  const second = await saveMemory(cwd, input({ indexLine: "second, revised", body: "Revised." }));
  assert.equal(second.updated, true);

  const index = await fs.readFile(join(memoryDir(cwd), "MEMORY.md"), "utf8");
  const hits = index.match(/user-role\.md/g) ?? [];
  assert.equal(hits.length, 1, "exactly one index line for the file");
  assert.match(index, /second, revised/);
  assert.doesNotMatch(index, /— first/);

  const topic = await fs.readFile(join(memoryDir(cwd), "user-role.md"), "utf8");
  assert.match(topic, /Revised\./);
});

test("slugify produces a safe file stem", () => {
  assert.equal(slugify("User Role!"), "user-role");
  assert.equal(slugify("  "), "memory");
  // Everything outside [a-z0-9] collapses, so a name cannot escape the memory dir.
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
});

test("an index line that mentions another memory's file survives that memory's save", async () => {
  // The old filter dropped any line CONTAINING "(file.md)". Index lines are prose the
  // model writes about memories, so cross-references are ordinary content — and losing
  // one silently removes a memory from the only listing that is always loaded.
  const cwd = "/proj/mem-xref";
  await saveMemory(cwd, input({ name: "user role", indexLine: "who they are" }));
  await saveMemory(cwd, input({ name: "release process", indexLine: "supersedes (user-role.md) entirely" }));
  // Re-saving the referenced memory must not delete the line that mentions it.
  await saveMemory(cwd, input({ name: "user role", indexLine: "who they are, revised" }));

  const index = await loadMemoryIndex(cwd);
  assert.match(index, /\[release process\]\(release-process\.md\)/, "the cross-referencing entry was deleted");
  assert.match(index, /who they are, revised/);
  assert.equal(index.match(/\(user-role\.md\)/g)?.length, 2, "one pointer + one mention");
});

test("frontmatter values cannot be forged by a newline in the name", async () => {
  // These are model-supplied strings going into a line-oriented format; a description
  // ending in "\ntype: user" would otherwise re-file the memory as a different type.
  const cwd = "/proj/mem-frontmatter";
  const saved = await saveMemory(cwd, input({ name: "notes", description: "first\ntype: user\nx: y" }));
  const raw = await fs.readFile(join(memoryDir(cwd), saved.file), "utf8");
  const header = raw.split("---")[1] ?? "";
  assert.equal(header.match(/^type:/gm)?.length, 1, "a second type: key was injected");
  assert.match(header, /description: first type: user x: y/);

  // The name field is the other way in, and it also reaches the MEMORY.md index line.
  const viaName = await saveMemory(cwd, input({ name: "notes2\ndescription: forged" }));
  const raw2 = await fs.readFile(join(memoryDir(cwd), viaName.file), "utf8");
  const header2 = raw2.split("---")[1] ?? "";
  assert.equal(header2.match(/^description:/gm)?.length, 1, "a second description: key was injected");
  const index = await loadMemoryIndex(cwd);
  assert.equal(index.split("\n").filter((l) => l.includes(viaName.file)).length, 1, "the index line broke in two");
});

test("overwriting a DIFFERENT memory is reported, not passed off as an update", async () => {
  // Names slug and clip to 60 chars, so two distinct names can land on one file. That
  // is the only destructive path, and "memory is non-destructive" is the stated reason
  // the user is never asked before a save.
  const cwd = "/proj/mem-collide";
  const long = "a".repeat(60);
  const first = await saveMemory(cwd, input({ name: `${long}-one` }));
  const second = await saveMemory(cwd, input({ name: `${long}-two` }));
  assert.equal(first.file, second.file, "fixture must actually collide");
  assert.equal(second.replaced, `${long}-one`);

  // And a genuine re-save of the same name is NOT reported as a replacement.
  const again = await saveMemory(cwd, input({ name: `${long}-two` }));
  assert.equal(again.replaced, undefined);
  assert.equal(again.updated, true);
});

// ── the save_memory tool ────────────────────────────────────────────────────

function ctxWith(): ToolContext {
  // An approval channel is provided to prove save_memory NEVER calls it — saving is
  // silent and automatic now, not gated on a yes/no.
  return {
    cwd: `/proj/tool-${Math.random().toString(36).slice(2)}`,
    reads: new Map(),
    todos: [],
    requestApproval: async () => {
      throw new Error("save_memory must not prompt the user");
    },
  };
}

test("save_memory writes silently without prompting the user", async () => {
  const ctx = ctxWith();
  const res = await saveMemoryTool.execute(
    { name: "Pref terse", description: "wants terse replies", type: "feedback", body: "Be terse.", index_line: "terse" },
    ctx,
  );
  assert.equal(res.isError, undefined);
  assert.match(res.output, /Saved memory 'Pref terse'/);
  const index = await fs.readFile(join(memoryDir(ctx.cwd), "MEMORY.md"), "utf8");
  assert.match(index, /Pref terse/);
});

test("save_memory rejects an invalid type", async () => {
  const ctx = ctxWith();
  const res = await saveMemoryTool.execute(
    { name: "Bad", description: "x", type: "notatype", body: "x", index_line: "x" },
    ctx,
  );
  assert.equal(res.isError, true);
  assert.match(res.output, /type/);
});

test("an old memory is flagged as old, a recent one is left exactly as it was", async () => {
  // Models are poor at date arithmetic, so the index does it for them — but only in two
  // coarse buckets, because this string lands in the CACHED system prefix and an exact
  // age would break that cache once a day for every memory, forever.
  const cwd = "/proj/mem-stale";
  await saveMemory(cwd, input({ name: "Fresh", description: "recent" }));
  await saveMemory(cwd, input({ name: "Middling", description: "a while back" }));
  await saveMemory(cwd, input({ name: "Ancient", description: "long ago" }));

  const age = async (file: string, days: number) => {
    const when = new Date(Date.now() - days * 86_400_000);
    await fs.utimes(join(memoryDir(cwd), file), when, when);
  };
  await age("fresh.md", 3);
  await age("middling.md", 120);
  await age("ancient.md", 800);

  const index = await loadMemoryIndex(cwd);
  const line = (name: string) => index.split(/\r?\n/).find((l) => l.includes(name)) ?? "";

  assert.doesNotMatch(line("Fresh"), /old\)/, "a recent memory carries no marker — no bytes, no cache churn");
  assert.match(line("Middling"), /\(months old\)$/);
  assert.match(line("Ancient"), /\(over a year old\)$/);
});

test("marking is idempotent, so re-rendering cannot stack markers", async () => {
  const cwd = "/proj/mem-idem";
  await saveMemory(cwd, input({ name: "Old", description: "ancient" }));
  const when = new Date(Date.now() - 400 * 86_400_000);
  await fs.utimes(join(memoryDir(cwd), "old.md"), when, when);

  const once = await loadMemoryIndex(cwd);
  const twice = await loadMemoryIndex(cwd);
  assert.equal(once, twice, "a second render must produce the identical string");
  assert.equal((once.match(/over a year old/g) ?? []).length, 1);
});
