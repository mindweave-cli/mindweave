/**
 * tools.test.ts — behaviour tests for the Step 4 tools.
 *
 * Run with `npm test`. Uses Node's built-in test runner (no extra deps). Each
 * test works in a throwaway temp directory and drives tools exactly as the
 * engine does: `tool.execute(args, ctx)`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "./types.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { edit } from "./edit.js";
import { numberedWindow } from "./editWindow.js";

/** The single-edit case, spelled the way it reads: `edit` takes an edits[] array,
 *  and a lone change is an array of one. */
function editOne(
  args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  ctx: ToolContext,
) {
  const { path, ...one } = args;
  return edit.execute({ path, edits: [one] }, ctx);
}
import { runCommand } from "./runCommand.js";
import { globDef } from "./glob.js";
import { grepDef } from "./grep.js";
import { MAX_ENTRIES, listDir } from "./listDir.js";
import { protectedPathReason, catastrophicCommandReason, sensitiveCommandReason } from "./guard.js";

function freshCtx(): ToolContext {
  // CANONICALISED, because a real session is: session.ts pins every root through
  // canonicalRoot at creation. Without it these contexts are less faithful than the
  // thing they stand in for, and on Windows that shows: os.tmpdir() can hand back an
  // 8.3 short path (C:\Users\RUNNER~1\...) while a command reports the long one, so
  // the root and the cwd stop sharing a prefix and relativize gives up and prints
  // absolute paths. Uses the NATIVE resolver for the same reason canonicalRoot does:
  // Node's own realpath leaves a short name exactly as it found it.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mindweave-test-")));
  return { cwd: dir, reads: new Map(), todos: [] };
}

// ── read_file ─────────────────────────────────────────────────────────────
test("read_file caps a default read at the line limit and says there's more", async () => {
  const ctx = freshCtx();
  const lines = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join("\n");
  await fs.writeFile(join(ctx.cwd, "big.txt"), lines);
  const r = await readFile.execute({ path: "big.txt" }, ctx);
  assert.equal(r.isError, undefined);
  assert.match(r.output, /showing lines 1-2000 of 2500/);
  assert.doesNotMatch(r.output, /\bL2001\b/); // line 2001 wasn't sent
});

test("a read capped by the line limit is NOT recorded as a whole-file read", async () => {
  const ctx = freshCtx();
  const lines = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join("\n");
  const p = join(ctx.cwd, "big.txt");
  await fs.writeFile(p, lines);
  await readFile.execute({ path: "big.txt" }, ctx);
  // 2000 of 2500 lines went out. Recording that as "full" let a later re-read be
  // answered "unchanged since you last read" for 500 lines never shown.
  assert.equal(ctx.reads.get(p)?.full, false);
  ctx.transcriptFull = new Set([p]); // even with the result still in context
  const again = await readFile.execute({ path: "big.txt" }, ctx);
  assert.doesNotMatch(again.output, /unchanged since you last read/);
});

test("read_file dedups an unchanged re-read", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  await readFile.execute({ path: "c.txt" }, ctx);
  // Dedup means "you already have this" — so the earlier read has to still BE in
  // context. The engine derives that set each turn; a fixture has to declare it.
  ctx.transcriptFull = new Set([join(ctx.cwd, "c.txt")]);
  const again = await readFile.execute({ path: "c.txt" }, ctx);
  assert.match(again.output, /unchanged since you last read/);
});

test("read_file re-reads (no dedup) after the file changes", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  await readFile.execute({ path: "c.txt" }, ctx);
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta gamma"); // different size
  const again = await readFile.execute({ path: "c.txt" }, ctx);
  assert.doesNotMatch(again.output, /unchanged/);
  assert.match(again.output, /beta gamma/);
});

// ── write_file ────────────────────────────────────────────────────────────
test("write_file creates a new file and records it as read", async () => {
  const ctx = freshCtx();
  const r = await writeFile.execute({ path: "a/b.txt", content: "hello" }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "a/b.txt"), "utf8"), "hello");
  // recorded → a later edit is allowed without a separate read
  assert.ok(ctx.reads.has(join(ctx.cwd, "a/b.txt")));
});

test("write_file preserves an existing file's CRLF line endings", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "page.html"), "<a>\r\n<b>\r\n");
  await readFile.execute({ path: "page.html" }, ctx);
  await writeFile.execute({ path: "page.html", content: "<x>\n<y>\n<z>\n" }, ctx); // model emits LF
  const after = await fs.readFile(join(ctx.cwd, "page.html"), "utf8");
  assert.equal(after, "<x>\r\n<y>\r\n<z>\r\n");
});

test("write_file matches a sibling's CRLF for a new file in the same dir", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "home.html"), "<h>\r\n<i>\r\n"); // CRLF sibling
  await writeFile.execute({ path: "cart.html", content: "<p>\n<q>\n" }, ctx);
  const after = await fs.readFile(join(ctx.cwd, "cart.html"), "utf8");
  assert.equal(after, "<p>\r\n<q>\r\n");
});

test("write_file defaults a brand-new file to LF when there's no sibling", async () => {
  const ctx = freshCtx();
  await writeFile.execute({ path: "fresh/only.txt", content: "a\nb\n" }, ctx);
  const after = await fs.readFile(join(ctx.cwd, "fresh/only.txt"), "utf8");
  assert.equal(after, "a\nb\n");
});

test("write_file refuses to overwrite an unread existing file", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "x.txt"), "old");
  const r = await writeFile.execute({ path: "x.txt", content: "new" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /hasn't been read/);
  assert.equal(await fs.readFile(join(ctx.cwd, "x.txt"), "utf8"), "old"); // untouched
});

test("write_file overwrites after the file has been read", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "x.txt"), "old");
  await readFile.execute({ path: "x.txt" }, ctx);
  const r = await writeFile.execute({ path: "x.txt", content: "new" }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "x.txt"), "utf8"), "new");
});

test("write_file refuses a protected path", async () => {
  const ctx = freshCtx();
  const r = await writeFile.execute({ path: ".env", content: "SECRET=1" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /Refusing/);
});

// ── edit_file ─────────────────────────────────────────────────────────────
test("edit on an unread file is allowed only when the edit proves it knows the content", async () => {
  // An unread file no longer refuses outright — quoting a line that matches uniquely is
  // itself evidence the model has seen it, and the refuse-first rule was costing a full
  // re-read of files the model already knew (see editFreshness.test.ts for the numbers).
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta");
  const ok = await editOne({ path: "c.txt", old_string: "alpha", new_string: "ALPHA" }, ctx);
  assert.ok(!ok.isError, `an exact match should apply: ${ok.output}`);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "ALPHA beta");

  await fs.writeFile(join(ctx.cwd, "d.txt"), "alpha beta");
  const guess = await editOne({ path: "d.txt", old_string: "gamma", new_string: "G" }, ctx);
  assert.equal(guess.isError, true);
  assert.match(guess.output, /has not been read/);
});

test("edit errors when old_string is not found", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editOne({ path: "c.txt", old_string: "zzz", new_string: "y" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /not found/);
});

test("edit errors on an ambiguous (multi) match without replace_all", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "x x x");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editOne({ path: "c.txt", old_string: "x", new_string: "y" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /matches 3 places/);
});

test("edit replaces a unique match", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "alpha beta");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editOne({ path: "c.txt", old_string: "beta", new_string: "GAMMA" }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "alpha GAMMA");
});

test("edit matches a multi-line old_string against a CRLF file (LF from the model)", async () => {
  const ctx = freshCtx();
  // A Windows-style file on disk (CRLF). The model, shown LF lines by read_file,
  // sends an LF old_string. This used to fail every time ("old_string not found").
  const onDisk = ".section h2 {\r\n    font-size: 30px;\r\n}\r\n";
  await fs.writeFile(join(ctx.cwd, "style.css"), onDisk);
  await readFile.execute({ path: "style.css" }, ctx);
  const r = await editOne(
    {
      path: "style.css",
      old_string: ".section h2 {\n    font-size: 30px;\n}", // LF, as the model would send
      new_string: ".section h2 {\n    font-size: 28px;\n}",
    },
    ctx,
  );
  assert.equal(r.isError, undefined, r.output);
  const after = await fs.readFile(join(ctx.cwd, "style.css"), "utf8");
  assert.match(after, /font-size: 28px;/);
  assert.ok(after.includes("\r\n"), "the file's CRLF line endings are preserved");
  assert.ok(!after.includes("\r\r"), "no doubled carriage returns");
});

test("edit handles a `$` in the replacement literally", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "price here");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editOne({ path: "c.txt", old_string: "price here", new_string: "$9.99 ($&)" }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "$9.99 ($&)");
});

test("edit replace_all changes every occurrence", async () => {
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "c.txt"), "x x x");
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editOne({ path: "c.txt", old_string: "x", new_string: "y", replace_all: true }, ctx);
  assert.equal(r.isError, undefined);
  assert.equal(await fs.readFile(join(ctx.cwd, "c.txt"), "utf8"), "y y y");
});

test("edit returns the changed region with line numbers (so no re-read is needed)", async () => {
  const ctx = freshCtx();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  await fs.writeFile(join(ctx.cwd, "c.txt"), lines);
  await readFile.execute({ path: "c.txt" }, ctx);
  const r = await editOne({ path: "c.txt", old_string: "line 10", new_string: "LINE TEN" }, ctx);
  assert.equal(r.isError, undefined, r.output);
  // The window shows the edited line, numbered, with surrounding context.
  assert.match(r.output, /10  LINE TEN/);
  assert.match(r.output, /\b8  line 8/); // a few lines of context above
  assert.doesNotMatch(r.output, /\b1  line 1\b/); // far-away lines are not included
});

test("numberedWindow numbers the spanned lines plus padding, bounded by maxLines", () => {
  const text = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
  const startChar = text.indexOf("d");
  const w = numberedWindow(text, startChar, startChar + 1, 1); // pad=1 around line 4
  assert.equal(w, ["3  c", "4  d", "5  e"].join("\n"));

  const many = Array.from({ length: 100 }, (_, i) => `x${i}`).join("\n");
  const capped = numberedWindow(many, 0, many.length, 4, 10);
  assert.equal(capped.split("\n").length, 11); // 10 lines + the truncation marker
  assert.match(capped, /region continues/);
});

// ── glob / grep / list_dir ──────────────────────────────────────────────────
async function seed(ctx: ToolContext) {
  await fs.mkdir(join(ctx.cwd, "src"), { recursive: true });
  await fs.writeFile(join(ctx.cwd, "src/a.ts"), "export const a = 1;\n// TODO: fix\n");
  await fs.writeFile(join(ctx.cwd, "src/b.ts"), "export const b = 2;\n");
  await fs.writeFile(join(ctx.cwd, "readme.md"), "# hi\nTODO later\n");
  await fs.mkdir(join(ctx.cwd, "node_modules/pkg"), { recursive: true });
  await fs.writeFile(join(ctx.cwd, "node_modules/pkg/index.ts"), "TODO ignored\n");
}

test("glob matches by pattern and skips ignored dirs", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await globDef.execute({ pattern: "**/*.ts" }, ctx);
  assert.match(r.output, /src\/a\.ts/);
  assert.match(r.output, /src\/b\.ts/);
  assert.doesNotMatch(r.output, /node_modules/); // ignored
});

test("grep content mode finds matches with locations, ignoring node_modules", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await grepDef.execute({ pattern: "TODO", output_mode: "content" }, ctx);
  assert.match(r.output, /src\/a\.ts:2:/);
  assert.match(r.output, /readme\.md:2:/);
  assert.doesNotMatch(r.output, /node_modules/);
});

test("grep files_with_matches lists only matching files", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await grepDef.execute({ pattern: "export const", glob: "*.ts" }, ctx);
  assert.match(r.output, /src\/a\.ts/);
  assert.match(r.output, /src\/b\.ts/);
  assert.doesNotMatch(r.output, /readme\.md/);
});

test("grep reports an invalid regex instead of throwing", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await grepDef.execute({ pattern: "(" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /invalid regular expression/);
});

test("list_dir shows directories first with a trailing slash", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  const r = await listDir.execute({}, ctx);
  assert.match(r.output, /src\//);
  assert.match(r.output, /readme\.md/);
});

test("a symlinked directory is marked as a directory, not shown as a file", async () => {
  // readdir does not follow links: for a junction/symlink to a directory BOTH
  // isDirectory() and isFile() are false (measured). So the trailing slash that is
  // the entire reading key never appeared, and a linked package directory looked
  // exactly like an ordinary file — in node_modules/.bin and linked monorepos, which
  // is where links actually turn up.
  const ctx = freshCtx();
  await fs.mkdir(join(ctx.cwd, "realdir"));
  await fs.writeFile(join(ctx.cwd, "plain.txt"), "x");
  try {
    await fs.symlink(join(ctx.cwd, "realdir"), join(ctx.cwd, "linkdir"), "junction");
  } catch {
    return; // no privilege to create links here; nothing to assert
  }
  const r = await listDir.execute({}, ctx);
  assert.match(r.output, /linkdir\/\s+\(symlink\)/, "a linked directory must carry the slash");
  // And it must sort with the directories, above the plain files.
  assert.ok(r.output.indexOf("linkdir/") < r.output.indexOf("plain.txt"));
});

test("a broken symlink says so rather than passing as a file", async () => {
  const ctx = freshCtx();
  try {
    await fs.symlink(join(ctx.cwd, "gone"), join(ctx.cwd, "dangling"), "junction");
  } catch {
    return;
  }
  const r = await listDir.execute({}, ctx);
  assert.match(r.output, /dangling\s+\(broken symlink\)/);
});

test("pointing list_dir at a file says it is a file, not that nothing is there", async () => {
  // readdir fails identically for missing, is-a-file, and permission-denied. Calling
  // all three "directory not found" sent the model hunting for a file it had already
  // located.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, "notes.md"), "hi");
  const r = await listDir.execute({ path: "notes.md" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /not a directory, it is a file/);
  assert.match(r.output, /read_file/, "it should point at the tool that can open it");
  assert.doesNotMatch(r.output, /not found/, "the file plainly exists");

  const missing = await listDir.execute({ path: "no-such-dir" }, ctx);
  assert.match(missing.output, /directory not found/);
});

test("list_dir reports the disk, including what search hides, and says so", async () => {
  // The one tool that shows the filesystem as it is. glob and grep withhold secrets
  // and other agents' folders; if list_dir did too, a file could exist, be invisible
  // to every tool, and the model would conclude it was absent. Showing a NAME is not
  // permission to open it, which is the line the description has to draw.
  const ctx = freshCtx();
  await fs.writeFile(join(ctx.cwd, ".env"), "SECRET=1");
  await fs.mkdir(join(ctx.cwd, ".claude"));
  const r = await listDir.execute({}, ctx);
  assert.match(r.output, /\.env/, "a listing that hides it makes the file undiscoverable");
  assert.match(r.output, /\.claude\//);
  // Listed here, still refused by the tool that would disclose the contents.
  assert.ok(protectedPathReason(join(ctx.cwd, ".env")));
  assert.match(listDir.description, /read_file still refuses secrets/);
});

test("a long listing is cut at the real cap and announces it", async () => {
  const ctx = freshCtx();
  for (let i = 0; i < MAX_ENTRIES + 5; i++) {
    await fs.writeFile(join(ctx.cwd, `f${String(i).padStart(4, "0")}.txt`), "x");
  }
  const r = await listDir.execute({}, ctx);
  assert.match(r.output, /… \(5 more\)/, "silent truncation would be a lie about the directory");
  assert.ok(listDir.description.includes(`after ${MAX_ENTRIES} entries`));
});

// ── run_command ─────────────────────────────────────────────────────────────
test("run_command runs a command and returns its output", async () => {
  const ctx = freshCtx();
  const r = await runCommand.execute({ command: "echo mindweave123" }, ctx);
  assert.match(r.output, /mindweave123/);
});

test("run_command reports a non-zero exit code", async () => {
  const ctx = freshCtx();
  const r = await runCommand.execute({ command: "exit 3" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /code 3/);
});

test("run_command persists cwd across calls (cd carries over)", async () => {
  const ctx = freshCtx();
  await fs.mkdir(join(ctx.cwd, "sub"), { recursive: true });
  await runCommand.execute({ command: "cd sub" }, ctx);
  assert.match(ctx.cwd.split("\\").join("/"), /\/sub$/);
});

// The model cannot see ctx.cwd. If a `cd` moves the shell and the output doesn't say
// so, the next relative path silently resolves from somewhere else — which is how a
// doubled path (a/b/a/b/file) gets built and then read as "the file is missing".
test("run_command TELLS the model when a cd moved the shell", async () => {
  const ctx = freshCtx();
  // A real session always pins roots at creation (session.ts), which is what keeps the
  // anchor still while cwd moves. Without it here the anchor would follow the cd and
  // every location would render as ".".
  ctx.roots = [ctx.cwd];
  await fs.mkdir(join(ctx.cwd, "sub"), { recursive: true });
  const r = await runCommand.execute({ command: "cd sub" }, ctx);
  assert.match(r.output, /Working directory is now sub/);
  assert.match(r.output, /rest of this turn/);
});

test("run_command says nothing about the directory when it did not move", async () => {
  const ctx = freshCtx();
  const r = await runCommand.execute({ command: "echo hello" }, ctx);
  assert.doesNotMatch(r.output, /Working directory is now/);
});

test("run_command refuses a catastrophic command", async () => {
  const ctx = freshCtx();
  const r = await runCommand.execute({ command: "rm -rf /" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /Refusing/);
});

// ── guard ───────────────────────────────────────────────────────────────────
test("guard flags protected paths and allows ordinary ones", () => {
  assert.ok(protectedPathReason("/proj/.env"));
  assert.ok(protectedPathReason("/proj/.git/config"));
  assert.ok(protectedPathReason("/home/u/.ssh/id_rsa"));
  assert.ok(protectedPathReason("/proj/key.pem"));
  assert.equal(protectedPathReason("/proj/src/index.ts"), null);
});

test("guard flags catastrophic commands and allows ordinary ones", () => {
  assert.ok(catastrophicCommandReason("rm -rf /"));
  assert.ok(catastrophicCommandReason("mkfs.ext4 /dev/sda"));
  assert.equal(catastrophicCommandReason("npm test"), null);
  assert.equal(catastrophicCommandReason("rm -rf ./build"), null); // local dir is fine
});

test("the disk-format guard catches real formatters but not PowerShell display cmdlets", () => {
  // Real disk formats — still blocked.
  assert.ok(catastrophicCommandReason("format C:"), "format C: must be caught");
  assert.ok(catastrophicCommandReason("format /fs:ntfs /q D:"), "a switched format must be caught");
  assert.ok(catastrophicCommandReason("Format-Volume -DriveLetter D"), "Format-Volume erases a volume");
  assert.ok(catastrophicCommandReason("Format-Disk -Number 1"), "Format-Disk erases a disk");
  // Benign — must NOT be refused (this is the bug that blocked the agent mid-task).
  assert.equal(catastrophicCommandReason("Get-Process electron | Format-Table -AutoSize"), null);
  assert.equal(catastrophicCommandReason("Get-Item x | Format-List"), null);
  assert.equal(catastrophicCommandReason("Format-Hex file.bin"), null);
  assert.equal(catastrophicCommandReason('git log --format="%H"'), null, "--format is not disk formatting");
});

// ── grep's description warns about silent exclusions; they must be real ───────
// The failure this guards is a wrong CONCLUSION, not a crash: an empty result read as
// "that string is not in this codebase" when the file was skipped or refused. The
// model acts on that, so the exclusions have to actually be the ones described.

test("grep really refuses secrets, so 'no matches' there is a refusal not a fact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-grepx-"));
  await fs.writeFile(join(dir, ".env"), "API_TOKEN=supersecret\n");
  await fs.writeFile(join(dir, "ok.ts"), "const x = 'supersecret';\n");
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;

  const r = await grepDef.execute({ pattern: "supersecret", output_mode: "files_with_matches" }, ctx);
  assert.doesNotMatch(r.output, /\.env/, "a secrets file must never be searched");
  assert.match(r.output, /ok\.ts/, "…but ordinary files still are");
  assert.match(grepDef.description, /refused rather than missing/i);
});

test("grep's stated output cap is the real one", () => {
  // A number in a description that drifts from the constant is a quiet lie.
  assert.match(grepDef.description, /stops after 250 matching lines/i);
});

test("grep points at references for named symbols", () => {
  // Asserts the PROPERTY, not the phrasing. The first version of this test pinned the
  // exact words "prefer references", and broke the moment that sentence was reworded
  // to stop overclaiming what references can do. A test that fails on a rewrite of
  // the same true statement is a test that punishes correcting the text.
  assert.match(grepDef.description, /\breferences\b/, "grep must name references as the alternative");
  assert.match(grepDef.description, /symbol you can NAME/i, "…and say when it is the better choice");
});

// ── glob's description claims, pinned ────────────────────────────────────────

test("glob's stated result cap is the real one", () => {
  assert.match(globDef.description, /stop after 100 paths/i);
});

test("glob matches against the ROOT-RELATIVE path, as the description says", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-globrel-"));
  await fs.mkdir(join(dir, "src", "deep"), { recursive: true });
  await fs.writeFile(join(dir, "src", "deep", "a.ts"), "x\n");
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;

  const hit = await globDef.execute({ pattern: "src/**/*.ts" }, ctx);
  assert.match(hit.output, /a\.ts/, "a root-relative pattern must match");
  // A leading slash is an absolute path, which never matches a relative one.
  const miss = await globDef.execute({ pattern: "/src/**/*.ts" }, ctx);
  assert.match(miss.output, /No files found/, "a leading slash must not match");
  assert.match(globDef.description, /RELATIVE to the root/i);
});

test("glob does NOT list secrets or other agents' data, matching grep and read_file", async () => {
  // The gap this closes: read_file refused .env, grep refused to search it, and glob
  // listed it. Listing is a weaker disclosure than reading, but it is the same kind:
  // it tells the model a secrets file exists and exactly where. A guard that one way
  // of looking ignores is not a guard.
  const dir = mkdtempSync(join(tmpdir(), "mindweave-globsec-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, ".env"), "API_TOKEN=x\n");
  await fs.writeFile(join(dir, "id_rsa"), "key\n");
  await fs.writeFile(join(dir, "src", "ok.ts"), "export const a = 1;\n");
  const ctx = { cwd: dir, reads: new Map(), todos: [] } as unknown as ToolContext;

  const r = await globDef.execute({ pattern: "**/*" }, ctx);
  assert.doesNotMatch(r.output, /\.env/, "a secrets file must not be listed");
  assert.doesNotMatch(r.output, /id_rsa/, "a private key must not be listed");
  assert.match(r.output, /ok\.ts/, "…while ordinary files still are");
});

// ── both search engines must honour the same exclusions ──────────────────────
// grep and glob each have TWO engines: ripgrep when installed, a pure-Node walk when
// not. Behavioural tests here only reach whichever one this machine has, so on a box
// without ripgrep the primary path is never executed and a missing exclusion there
// would pass every test. This scans the source instead, which is checkable either way.

test("grep and glob exclude secrets in BOTH engines, not just the one this machine runs", () => {
  for (const [name, rel] of [
    ["grep", "./grep.ts"],
    ["glob", "./glob.ts"],
  ] as const) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    // Name-agnostic: the previous version pinned the loop VARIABLE and broke on a
    // rename while the behaviour was fine, which is the "asserts a symbol exists
    // rather than what it does" trap.
    const excludeLoop = /for \(const \w+ of SEARCH_EXCLUDE_GLOBS\) args\.push\("-g", `!\$\{\w+\}`\);/;
    assert.match(src, excludeLoop, `${name}'s ripgrep path must exclude secrets`);
    assert.match(src, /excludedFromSearch\(/, `${name}'s walk path must exclude secrets`);

    // ORDER, which is the part that actually failed in the field: ripgrep's `-g`
    // rules are last-match-wins, so any caller-supplied pattern must be registered
    // BEFORE the exclusions. With it after, `**/*` cancelled every guard and rg
    // listed .env and id_rsa. A source check is the only way to pin this on a
    // machine without rg installed; CI, which has rg, pins it behaviourally.
    const callerGlob = src.indexOf('args.push("-g", pattern)') >= 0
      ? src.indexOf('args.push("-g", pattern)')
      : src.indexOf('args.push("-g", o.glob)');
    assert.ok(callerGlob >= 0, `${name} should register the caller's glob explicitly`);
    assert.ok(
      callerGlob < src.search(excludeLoop),
      `${name} registers the caller's glob AFTER the exclusions, so rg's last-match-wins ` +
        `rule lets an ordinary pattern override them`,
    );
  }
});

// ── ranged reads of a large file ──────────────────────────────────────────────
// The <working_files> block used to localize a large file into regions, and a ranged
// read inside one of those regions was suppressed. Both are gone: nothing renders the
// regions any more, so suppressing a read against them would refuse content on the
// strength of something the model was never shown. A ranged read now always returns
// its lines unless the whole file is unchanged and still in the transcript.

test("with no working set, a ranged read always returns the lines", async () => {
  // No presence information means no dedup — a wasted read, never a phantom one.
  const ctx = freshCtx();
  const p = join(ctx.cwd, "big.ts");
  await fs.writeFile(p, Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n"));
  const st = await fs.stat(p);
  ctx.reads.set(p, { mtimeMs: st.mtimeMs, size: st.size, full: false, touchedAt: 1 });

  const r = await readFile.execute({ path: "big.ts", offset: 120, limit: 20 }, ctx);
  assert.match(r.output, /line 125/);
});

// ── search findings are durable ──────────────────────────────────────────────────
// A grep's result used to live only in the transcript, which keeps the last 8 tool
// results and sweeps to 2 at a task boundary, while a read is re-rendered from disk into
// <working_files> on every step forever. That asymmetry taught the model, mechanically,
// that reading sticks and searching does not — so it read narrowly and repeatedly where
// one search would have answered it.

test("a content grep puts the region it found into the working set", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  await grepDef.execute({ pattern: "TODO", output_mode: "content" }, ctx);

  const hit = ctx.reads.get(join(ctx.cwd, "src/a.ts"));
  assert.ok(hit, "the file a search matched inside is not tracked at all");
  assert.deepEqual(hit!.focus, [{ start: 1, end: 4 }], "the match and its context should be the focus");
});

test("a search does NOT count as having read the file", async () => {
  // grep returns matching lines, never the file. write_file's read-before-overwrite gate
  // must not open on the strength of a search, or the model overwrites what it never saw.
  const ctx = freshCtx();
  await seed(ctx);
  await grepDef.execute({ pattern: "TODO", output_mode: "content" }, ctx);

  const hit = ctx.reads.get(join(ctx.cwd, "src/a.ts"));
  assert.equal(hit!.viaSearch, true, "a search-sourced entry must be marked as one");
  const r = await writeFile.execute({ path: "src/a.ts", content: "wiped\n" }, ctx);
  assert.match(r.output, /hasn't been read this session/, "a grep opened the overwrite gate");
});

test("the overwrite gate refuses QUIETLY — it is a correction, not an outcome", async () => {
  // The model reads the file and writes it a moment later, in the same turn, with no
  // help from anyone. Painted as a red row it is worse than noise: a file the session
  // never created — one a scaffolder or an installer left there — is reported to the
  // user as a problem with a file they have never seen mentioned, and then the write
  // succeeds anyway, which explains nothing.
  const ctx = freshCtx();
  await seed(ctx);
  const r = await writeFile.execute({ path: "src/a.ts", content: "replacement\n" }, ctx);

  assert.equal(r.isError, true, "the model must still be refused and still have to read first");
  assert.match(r.output, /hasn't been read this session/, "the model's instructions are unchanged");
  assert.equal(r.quiet, true, "the UI must not paint a row the user can do nothing about");
});

test("a refusal the user CAN act on stays loud", async () => {
  // The quiet mark belongs to the one refusal the model resolves by itself. A write to a
  // directory is not that: nothing the model does next fixes it, so the row must show.
  const ctx = freshCtx();
  await seed(ctx);
  await fs.mkdir(join(ctx.cwd, "src/adir"), { recursive: true });
  const r = await writeFile.execute({ path: "src/adir", content: "x\n" }, ctx);

  assert.equal(r.isError, true);
  assert.notEqual(r.quiet, true, "a refusal with no self-correction must not be hidden");
});

test("one search cannot flood the working set", async () => {
  const ctx = freshCtx();
  await fs.mkdir(join(ctx.cwd, "many"), { recursive: true });
  for (let i = 0; i < 12; i++) {
    await fs.writeFile(join(ctx.cwd, `many/f${i}.ts`), "const x = 1; // TODO\n".repeat(8));
  }
  await grepDef.execute({ pattern: "TODO", output_mode: "content" }, ctx);

  assert.ok(ctx.reads.size <= 5, `a broad search tracked ${ctx.reads.size} files`);
  for (const rec of ctx.reads.values()) {
    assert.ok((rec.focus ?? []).length <= 4, "too many spans kept for one file");
  }
});

test("files_with_matches leaves no focus behind — it showed no lines", async () => {
  const ctx = freshCtx();
  await seed(ctx);
  await grepDef.execute({ pattern: "TODO", output_mode: "files_with_matches" }, ctx);
  assert.equal(ctx.reads.size, 0, "a path list is not something the model was shown");
});

test("per-environment secret files are on the hard floor, ordinary code is not", () => {
  // `.env` and `.env.local` were covered; `prod.env`, `staging.env` and
  // `production.env` were NOT, and a per-environment file is one of the commonest
  // places a real secret actually lives. `.envrc` (direnv) routinely holds exported
  // keys and was also getting through. This floor is the "never, whatever you are
  // asked" list, so a miss here is not a policy question, it is a hole.
  for (const p of [
    "D:/proj/prod.env",
    "D:/proj/staging.env",
    "D:/proj/env/production.env",
    "D:/proj/.envrc",
    "D:/proj/.env",
    "D:/proj/.env.local",
    "C:/Users/x/.mindweave/.env",
  ]) {
    assert.ok(protectedPathReason(p), `${p} must never be readable`);
  }

  // The other half, and the reason the suffix is anchored to the basename rather than
  // matched loosely: a floor that blocked ordinary source would be worked around
  // rather than obeyed.
  for (const p of ["D:/proj/src/environment.ts", "D:/proj/src/env.ts", "D:/proj/docs/secretsanta.md"]) {
    assert.equal(protectedPathReason(p), null, `${p} is ordinary code and must stay readable`);
  }
});

test("an env EXAMPLE file is documentation, not a secret", () => {
  // The template a project commits so a newcomer knows which variables to set. It holds
  // names and placeholders, and refusing it withheld a project's own account of its
  // configuration while protecting nothing. A shell command was refused whole for
  // naming one among ordinary files.
  for (const p of [
    "D:/proj/.env.example",
    "D:/proj/.env.sample",
    "D:/proj/env.example",
    "D:/proj/.env.template",
  ]) {
    assert.equal(protectedPathReason(p), null, `${p} is a template and must stay readable`);
  }
  assert.equal(sensitiveCommandReason("Get-Content .env.example"), null);
  assert.equal(sensitiveCommandReason("cat .env.example && cat README.md"), null);

  // The live files are untouched by the exemption, including one that merely starts
  // like a template.
  for (const p of ["D:/proj/.env", "D:/proj/.env.local", "D:/proj/.env.example.local"]) {
    assert.ok(protectedPathReason(p), `${p} can hold a real key and must stay refused`);
  }
  assert.ok(sensitiveCommandReason("cat .env"));
  assert.ok(sensitiveCommandReason("cat .env.example; cat .env"), "the real file is still named");
});
