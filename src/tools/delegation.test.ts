/**
 * delegation.test.ts — the rules for handing work to sub-agents.
 *
 * A model asked to be thorough starts ten workers for work one could do. These rules refuse that in code, and they are what keeps
 * two workers that edit at once from ever writing the same file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  DEFAULT_LIMITS,
  MIN_PARALLEL_TASK_CHARS,
  ScopeLocks,
  delegationLine,
  inScope,
  newDelegation,
  noteSpawn,
  normalizeScope,
  refuseSpawn,
  relativeToProject,
  scopeRefusal,
  sameJob,
  scopesOverlap,
  taskSimilarity,
} from "./delegation.js";

const cwd = resolve("/repo");
const LIMITS = { concurrent: 10, perTurn: 3, stepsPerTurn: 50 };
const task = (s: string) => `${s} `.repeat(Math.ceil(MIN_PARALLEL_TASK_CHARS / (s.length + 1)) + 1);

test("a scope names a file or a folder inside the project, and nothing wider", () => {
  assert.deepEqual(normalizeScope("src/ui/", cwd), { ok: true, scope: "src/ui" });
  assert.deepEqual(normalizeScope("src\\ui\\App.tsx", cwd), { ok: true, scope: "src/ui/App.tsx" });
  assert.deepEqual(normalizeScope("src/ui/**", cwd), { ok: true, scope: "src/ui" });
  assert.deepEqual(normalizeScope(resolve(cwd, "docs"), cwd), { ok: true, scope: "docs" });
  for (const bad of ["", ".", "./", "/repo", "../elsewhere", "src/*.ts", "{a,b}", "src/[ab]/x"]) {
    assert.equal(normalizeScope(bad, cwd).ok, false, `"${bad}" is not a scope`);
  }
});

test("scopes overlap by whole path segments, not by letters", () => {
  assert.equal(scopesOverlap("src/ui", "src/ui"), true);
  assert.equal(scopesOverlap("src", "src/ui/App.tsx"), true);
  assert.equal(scopesOverlap("src/ui/App.tsx", "src"), true);
  assert.equal(scopesOverlap("src/ui", "src/uikit"), false, "a shared prefix of letters is not a shared folder");
  assert.equal(scopesOverlap("src/a", "src/b"), false);
});

test("a file is inside a scope when it is the scope or under it", () => {
  assert.equal(inScope("src/ui/App.tsx", ["src/ui"]), true);
  assert.equal(inScope("src/ui", ["src/ui"]), true);
  assert.equal(inScope("./src/ui/App.tsx", ["src/ui"]), true);
  assert.equal(inScope("src/uikit/x.ts", ["src/ui"]), false);
  assert.equal(inScope("src/api/x.ts", ["src/ui", "docs"]), false);
  assert.equal(relativeToProject("/repo/src/a.ts", cwd), "src/a.ts");
  assert.equal(relativeToProject("/elsewhere/a.ts", cwd), null);
  assert.equal(relativeToProject("../a.ts", cwd), null);
});

test("two workers cannot hold overlapping scopes; releasing frees them; one worker may hold several", () => {
  const locks = new ScopeLocks();
  assert.deepEqual(locks.acquire("a", "ui", ["src/ui", "docs"]), { ok: true });
  const clash = locks.acquire("b", "kit", ["src/ui/button"]);
  assert.equal(clash.ok, false);
  if (!clash.ok) {
    assert.equal(clash.heldBy, "ui");
    assert.equal(clash.heldScope, "src/ui");
  }
  assert.equal(locks.size, 2, "a refused worker holds nothing");
  assert.deepEqual(locks.acquire("c", "api", ["src/api"]), { ok: true });
  locks.release("a");
  assert.deepEqual(locks.acquire("b", "kit", ["src/ui/button"]), { ok: true });
});

test("a scoped worker may edit inside its scope and nowhere else, and has no shell", () => {
  const scopes = ["src/ui"];
  assert.equal(scopeRefusal("edit", { path: "src/ui/App.tsx" }, scopes, cwd), null);
  assert.equal(scopeRefusal("write_file", { path: resolve(cwd, "src/ui/New.tsx") }, scopes, cwd), null);
  assert.match(scopeRefusal("edit", { path: "src/api/x.ts" }, scopes, cwd)!, /outside your scope/);
  assert.match(scopeRefusal("write_file", { path: "../other/x.ts" }, scopes, cwd)!, /outside your scope/);
  assert.match(scopeRefusal("replace_symbol_body", { name: "f" }, scopes, cwd)!, /needs the `path`/, "a symbol found anywhere could be outside");
  assert.equal(scopeRefusal("replace_symbol_body", { name: "f", path: "src/ui/a.ts" }, scopes, cwd), null);
  assert.match(scopeRefusal("run_command", { command: "echo > src/api/x" }, scopes, cwd)!, /could change files outside your scope/);
  assert.match(scopeRefusal("remember_rule", {}, scopes, cwd)!, /outside your scope/);
  assert.equal(scopeRefusal("todo_write", {}, scopes, cwd), null);
});

test("similar tasks are told apart from different ones", () => {
  const a = "Review the authentication routes in src/api/auth for missing rate limits and report each handler";
  const b = "Review the authentication routes in src/api/auth for missing rate limits, and report every handler";
  const c = "Inventory the database migrations under db/migrations and list which tables each one touches";
  assert.ok(taskSimilarity(a, b) >= 0.7, "worded alike");
  const reworded = a.replace("handler", "function");
  assert.equal(sameJob(a, reworded), false, "a rewording is not caught: the slices keep two workers off one part");
  assert.equal(sameJob(a, b), true, "words that carry no meaning do not make a different task");
  assert.equal(sameJob(a, a.toUpperCase()), true, "the same task sent again is");
  assert.equal(sameJob("Read the api module end to end and list every function that touches the network", "Read the web module end to end and list every function that touches the network"), false, "ten tasks that differ by one name are ten jobs");
  assert.equal(sameJob("Check the logging calls in src/api/auth.ts for leaked secrets and list them", "Check the logging calls in src/api/users.ts for leaked secrets and list them"), false, "the same words about different files are different jobs");
  assert.ok(taskSimilarity(a, c) < 0.3);
  assert.equal(taskSimilarity("", a), 0);
});

test("a worker that runs beside others must name its slice, and slices cannot repeat", () => {
  const ledger = newDelegation();
  const req = (slice: string, text = task("Read everything in the billing module and list every place a charge can fail")) => ({ task: text, slice, parallel: true });
  assert.match(refuseSpawn(ledger, LIMITS, req(""))!, /which part of the work it owns/);
  assert.equal(refuseSpawn(ledger, LIMITS, req("billing")), null);
  noteSpawn(ledger, req("billing"));
  assert.match(refuseSpawn(ledger, LIMITS, req("Billing", task("Inventory the auth module and list every session store it writes to")))!, /already owns the slice/);
  assert.equal(refuseSpawn(ledger, LIMITS, req("auth", task("Inventory the auth module and list every session store it writes to"))), null);
});

test("a task too short to need a worker is sent back, and a near-copy of an earlier task is refused", () => {
  const ledger = newDelegation();
  assert.match(refuseSpawn(ledger, LIMITS, { task: "check the login", slice: "login", parallel: true })!, /quicker to do yourself/);
  const long = "Trace how a failed upload is reported to the person using the app, across the queue, the retry logic and the UI toast";
  noteSpawn(ledger, { task: long, slice: "uploads", parallel: true });
  assert.match(refuseSpawn(ledger, LIMITS, { task: long, slice: "uploads two", parallel: true })!, /almost the same/);
  // A worker that does not run beside others is not held to the slice and length rules, only to the ceilings.
  assert.equal(refuseSpawn(newDelegation(), LIMITS, { task: "Fix it", slice: "", parallel: false }), null);
});

test("a turn has a ceiling on workers and on steps", () => {
  const ledger = newDelegation();
  for (let i = 0; i < LIMITS.perTurn; i++) noteSpawn(ledger, { task: `distinct job number ${i} about topic${i}${i}${i}`, slice: `s${i}`, parallel: true });
  assert.match(refuseSpawn(ledger, LIMITS, { task: task("another quite different job entirely"), slice: "x", parallel: true })!, /used its 3 workers/);
  const spent = newDelegation();
  spent.steps = LIMITS.stepsPerTurn;
  assert.match(refuseSpawn(spent, LIMITS, { task: task("something new to look into at length"), slice: "y", parallel: true })!, /taken 50 steps/);
  assert.match(delegationLine(ledger, LIMITS), /3 of 3 workers, 0 of 50 steps/);
});

test("the defaults raise the old limit of five and keep a ceiling", () => {
  assert.equal(DEFAULT_LIMITS.concurrent, 10);
  assert.ok(DEFAULT_LIMITS.perTurn >= DEFAULT_LIMITS.concurrent && DEFAULT_LIMITS.perTurn <= 20);
});
