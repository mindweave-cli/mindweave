/**
 * lsp.test.ts — the precision tier against a real language server.
 *
 * Exercises the bundled typescript-language-server end-to-end: launch, initialize,
 * workspace/symbol, and textDocument/references. Generous timeout (first launch is
 * slow). If the server can't run in this environment the assertions surface it
 * rather than silently passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspManager, filesToOpen } from "./lsp.js";
import { CodeChassis } from "./index.js";
import { isProcessStopped } from "../../tools/killTree.js";

/**
 * Still running? A bare `kill(pid, 0)` is wrong here: on POSIX a killed server is a
 * ZOMBIE until reaped and answers that probe as alive, so `shutdown` looked broken
 * on Linux while it was working. The shared check reads the process state instead.
 */
function alive(pid: number): boolean {
  return !isProcessStopped(pid);
}

async function tsProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-lsp-"));
  await fs.mkdir(join(dir, "src"), { recursive: true });
  await fs.writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
  await fs.writeFile(join(dir, "src/util.ts"), "export function helper(): number { return 1; }\n");
  await fs.writeFile(join(dir, "src/main.ts"), "import { helper } from './util';\nexport function run() { return helper(); }\n");
  return dir;
}

test("LspManager returns compiler-accurate symbols and references", { timeout: 45_000 }, async () => {
  const dir = await tsProject();
  const lsp = new LspManager(dir);
  try {
    lsp.noteFile(join(dir, "src/util.ts"));
    lsp.noteFile(join(dir, "src/main.ts"));

    const syms = await lsp.symbols("helper");
    assert.ok(syms.length >= 1, "workspace/symbol should find helper");
    const def = syms.find((s) => s.file.endsWith("util.ts"))!;
    assert.ok(def, "helper should be defined in util.ts");
    assert.equal(def.kind, "function");

    const refs = await lsp.references(def.file, def.line, def.character);
    assert.ok(refs.some((r) => r.file.endsWith("main.ts")), "helper should be referenced from main.ts");
  } finally {
    await lsp.dispose();
  }
});

test("LspManager resolves Python symbols via bundled pyright", { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mindweave-py-"));
  await fs.writeFile(join(dir, "util.py"), "def helper():\n    return 1\n");
  await fs.writeFile(join(dir, "main.py"), "from util import helper\n\ndef run():\n    return helper()\n");
  const lsp = new LspManager(dir);
  try {
    lsp.noteFile(join(dir, "util.py"));
    lsp.noteFile(join(dir, "main.py"));
    const syms = await lsp.symbols("helper");
    assert.ok(syms.some((s) => s.file.endsWith("util.py")), "pyright should find helper in util.py");
  } finally {
    await lsp.dispose();
  }
});

// ── Teardown actually reaps the server ──────────────────────────────────────

test("shutdown leaves no language server running", { timeout: 45_000 }, async () => {
  const dir = await tsProject();
  const lsp = new LspManager(dir);
  lsp.noteFile(join(dir, "src/util.ts"));
  await lsp.symbols("helper"); // forces a real launch

  const pids = lsp.pids();
  assert.ok(pids.length > 0, "a server should have been launched");
  assert.ok(pids.every(alive), "servers should be running before shutdown");

  await lsp.shutdown();

  const survivors = pids.filter(alive);
  assert.deepEqual(survivors, [], `servers still alive after shutdown: ${survivors.join(", ")}`);
});

test("a disposed manager refuses to launch anything new", { timeout: 45_000 }, async () => {
  const dir = await tsProject();
  const lsp = new LspManager(dir);
  lsp.noteFile(join(dir, "src/util.ts"));
  await lsp.shutdown();

  // A query arriving after teardown must not resurrect a server that nothing
  // will ever reap: the session it belonged to is gone.
  const syms = await lsp.symbols("helper");
  assert.deepEqual(syms, []);
  assert.deepEqual(lsp.pids(), []);
});

// ── The open-document bound ─────────────────────────────────────────────────

const KEY = "ts";
const tsKey = () => KEY;

test("filesToOpen bounds a single call, so one query can't stall", () => {
  const known = Array.from({ length: 500 }, (_, i) => `f${i}.ts`);
  const picked = filesToOpen(known, new Set(), KEY, tsKey);
  assert.equal(picked.length, 50);
});

test("filesToOpen bounds the SESSION, not just each call", () => {
  // The bug: `opened` was ignored for the ceiling, so every query opened another
  // batch and a long session fed the whole repo to the server, 50 files at a time.
  const known = Array.from({ length: 5000 }, (_, i) => `f${i}.ts`);
  const opened = new Set<string>();
  let rounds = 0;
  for (;;) {
    const picked = filesToOpen(known, opened, KEY, tsKey);
    if (picked.length === 0) break;
    for (const p of picked) opened.add(p);
    if (++rounds > 500) break; // safety: an unbounded impl would spin to 5000
  }
  assert.equal(opened.size, 300, "total open documents must stop at the ceiling");
  assert.ok(rounds < 500, "the loop must terminate on the cap, not on the file list");
});

test("filesToOpen skips already-open files and other servers' files", () => {
  const opened = new Set(["a.ts"]);
  const picked = filesToOpen(["a.ts", "b.ts", "c.py"], opened, KEY, (p) => (p.endsWith(".ts") ? KEY : "py"));
  assert.deepEqual(picked, ["b.ts"]);
});

test("filesToOpen returns nothing once the ceiling is already reached", () => {
  const opened = new Set(Array.from({ length: 300 }, (_, i) => `o${i}.ts`));
  assert.deepEqual(filesToOpen(["new.ts"], opened, KEY, tsKey), []);
});

test("CodeChassis with LSP returns resolved confidence", { timeout: 45_000 }, async () => {
  const dir = await tsProject();
  const ch = new CodeChassis(dir, { lsp: true });
  try {
    await ch.build();
    const def = await ch.definition("helper");
    assert.ok(def.symbols.length >= 1);
    assert.equal(def.confidence, "resolved");
    assert.match(def.symbols[0].file, /util\.ts$/);
  } finally {
    await ch.dispose();
  }
});

// ── Idle servers are reaped to give their memory back ───────────────────────
//
// A pyright or tsserver is spawned on the first symbol query and, without a reaper, lives
// for the rest of the session holding its whole index — hundreds of megabytes each. Most
// of a session is not symbol lookups, so that memory sat unused. An idle server is now
// shut down; a later query respawns it, the same cold cost the first query already paid.

test("an idle language server is shut down, and a later query brings it back", { timeout: 60_000 }, async () => {
  const prev = process.env["MINDWEAVE_LSP_IDLE_MS"];
  process.env["MINDWEAVE_LSP_IDLE_MS"] = "0"; // anything since the last query counts as idle
  const dir = await tsProject();
  const lsp = new LspManager(dir);
  try {
    lsp.noteFile(join(dir, "src/util.ts"));
    await lsp.symbols("helper"); // forces a real launch

    const pids = lsp.pids();
    assert.ok(pids.length > 0 && pids.every(alive), "a server should be running after the first query");

    // Idle threshold 0 → the reaper shuts it down on the spot.
    lsp.reapIfIdle();
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(pids.filter(alive), [], "the idle server was not shut down");
    assert.deepEqual(lsp.pids(), [], "the manager still tracks a server it has killed");

    // The manager is NOT disposed — a fresh query relaunches and still answers.
    const syms = await lsp.symbols("helper");
    assert.ok(syms.length >= 1, "the server did not come back for a query after idle shutdown");
    assert.ok(lsp.pids().length > 0, "a fresh server should be running again");
  } finally {
    process.env["MINDWEAVE_LSP_IDLE_MS"] = prev;
    await lsp.dispose();
  }
});

test("a server in active use is NOT reaped", { timeout: 60_000 }, async () => {
  // The threshold defaults to two minutes; a query just happened, so nothing is idle.
  const dir = await tsProject();
  const lsp = new LspManager(dir);
  try {
    lsp.noteFile(join(dir, "src/util.ts"));
    await lsp.symbols("helper");
    const pids = lsp.pids();
    assert.ok(pids.length > 0);

    lsp.reapIfIdle(); // default 120s idle; the query was moments ago
    assert.ok(pids.every(alive), "a server was reaped while still in active use");
  } finally {
    await lsp.dispose();
  }
});

// The TypeScript server sends diagnostics only to a client that declares it can take them,
// and on Windows it names the file `c:/...` when it was opened as `C:/...`. Between the two
// the diagnostics tool and the after-edit check answered "nothing" for every TypeScript
// project. This is the check that an edit which breaks a caller is actually caught.
test("an edit that breaks a caller is reported as an error in the caller", { timeout: 45_000 }, async () => {
  const dir = await tsProject();
  const lsp = new LspManager(dir);
  try {
    const main = join(dir, "src/main.ts");
    lsp.noteFile(join(dir, "src/util.ts"));
    lsp.noteFile(main);
    await fs.writeFile(join(dir, "src/util.ts"), "export function helper(x: number): string { return String(x); }\n");
    await fs.writeFile(main, "import { helper } from './util';\nexport function run(): number { return helper(); }\n");
    await lsp.diagnostics(join(dir, "src/util.ts"));
    const found = await lsp.diagnostics(main);
    assert.ok(found.some((d) => d.severity === "error"), `no error reported: ${JSON.stringify(found)}`);
    assert.ok(found.every((d) => d.file.endsWith("src/main.ts")), "reported under the file's own path");
  } finally {
    await lsp.dispose();
  }
});
