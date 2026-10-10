/**
 * selfUpdate.test.ts — where this copy of Mindweave thinks it is, and what it will do
 * about it.
 *
 * Every case here is a real install SHAPE — a global install on either platform, a
 * checkout, a link, a project's own dependency — because the cost of being wrong is npm
 * rewriting something that was never ours.
 *
 * The paths are invented fixtures. The module is pure by construction, so these can cover
 * every shape rather than whichever one happens to exist on the machine running the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInstall, manualCommand, refusalReason, updateCommand, type InstallProbe } from "./selfUpdate.js";

/** A filesystem that exists only as a set of paths. */
function probe(present: string[] = [], links: string[] = []): InstallProbe {
  const has = new Set(present);
  const linked = new Set(links);
  return { exists: (p) => has.has(p), isLink: (p) => linked.has(p) };
}

// ── the global install this is actually for ──────────────────────────────────

const WIN_ROOT = "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\mindweave";
const WIN_PREFIX = "C:\\Users\\dev\\AppData\\Roaming\\npm";

test("a Windows global install is found, and its prefix comes from where it IS", () => {
  const install = classifyInstall(WIN_ROOT, probe([`${WIN_PREFIX}\\mindweave.cmd`]));
  assert.equal(install.kind, "global");
  assert.equal(install.kind === "global" && install.prefix, WIN_PREFIX);
});

test("a POSIX global install drops the lib directory from the prefix", () => {
  const root = "/home/u/.local/lib/node_modules/mindweave";
  const install = classifyInstall(root, probe(["/home/u/.local/bin/mindweave"]));
  assert.equal(install.kind, "global");
  assert.equal(install.kind === "global" && install.prefix, "/home/u/.local");
});

test("the update command names the prefix explicitly", () => {
  // The whole point. Left to its own configuration npm can install somewhere the user's
  // `mindweave` command does not look, report success, and leave them on the old version
  // with nothing on screen to say so.
  const { command, args } = updateCommand(WIN_PREFIX);
  assert.equal(command, "npm");
  assert.deepEqual(args, ["install", "-g", "--prefix", WIN_PREFIX, "mindweave@latest"]);
});

test("a prefix that npm would have chosen is never consulted", () => {
  // The reported failure: installed under ~/.local, `npm config get prefix` says /usr.
  // Deriving from the install's own path is what keeps those two apart, so this asserts
  // the derived prefix rather than anything npm would say.
  const root = "/home/dev/.local/lib/node_modules/mindweave";
  const install = classifyInstall(root, probe(["/home/dev/.local/bin/mindweave"]));
  assert.equal(install.kind === "global" && install.prefix, "/home/dev/.local");
  assert.doesNotMatch(manualCommand(install), /\/usr/);
});

// ── everything it must refuse ────────────────────────────────────────────────

test("a working tree is refused, not updated over", () => {
  // A development build: dist run straight out of a checkout. `npm i -g` here would
  // replace a source build with the published one and silently undo the work in it.
  const root = "C:\\src\\Mindweave";
  const install = classifyInstall(root, probe([`${root}\\.git`]));
  assert.equal(install.kind, "source");
  assert.match(refusalReason(install) ?? "", /working tree/);
});

test("a linked install is refused before its path is even read", () => {
  // `npm link` puts a junction at the global path whose segments are identical to a real
  // install's. Following them would land the update on the checkout it points at.
  const install = classifyInstall(WIN_ROOT, probe([`${WIN_PREFIX}\\mindweave.cmd`], [WIN_ROOT]));
  assert.equal(install.kind, "source");
});

test("a project's own dependency is not a global install", () => {
  // Identical segments to a global install one directory down. Only the launcher tells
  // them apart, and it is absent here.
  const install = classifyInstall("D:\\work\\api\\node_modules\\mindweave", probe([]));
  assert.equal(install.kind, "local");
  assert.match(refusalReason(install) ?? "", /dependency of another project/);
});

test("a place it cannot recognise is refused rather than guessed at", () => {
  const install = classifyInstall("/opt/weird/mindweave", probe([]));
  assert.equal(install.kind, "unknown");
  assert.ok(refusalReason(install));
});

test("a root with nothing above it does not produce an empty prefix", () => {
  // Guards the arithmetic: dropping two segments from a two-segment path leaves nothing,
  // and `npm install -g --prefix ""` would resolve somewhere unpredictable.
  const install = classifyInstall("/node_modules/mindweave", probe([]));
  assert.notEqual(install.kind, "global");
});

// ── what the user is told ────────────────────────────────────────────────────

test("only a global install has no refusal", () => {
  const global = classifyInstall(WIN_ROOT, probe([`${WIN_PREFIX}\\mindweave.cmd`]));
  assert.equal(refusalReason(global), null);
  for (const root of ["C:\\checkout\\Mindweave", "D:\\work\\api\\node_modules\\mindweave", "/opt/x/mindweave"]) {
    assert.ok(refusalReason(classifyInstall(root, probe([`${root}\\.git`]))), root);
  }
});

test("every refusal still hands over a command that can be typed", () => {
  for (const root of ["C:\\checkout\\Mindweave", "D:\\work\\api\\node_modules\\mindweave"]) {
    assert.match(manualCommand(classifyInstall(root, probe([]))), /^npm install -g mindweave@latest$/);
  }
});

test("a global install's manual command is the one it would have run itself", () => {
  const install = classifyInstall(WIN_ROOT, probe([`${WIN_PREFIX}\\mindweave.cmd`]));
  assert.equal(manualCommand(install), `npm install -g --prefix ${WIN_PREFIX} mindweave@latest`);
});

test("the copy bundled in the desktop app is told apart and not updated through npm", () => {
  for (const root of [
    "C:\\Users\\u\\AppData\\Local\\Programs\\mwcode\\resources\\app\\node_modules\\mindweave",
    "/opt/mwcode/resources/app/node_modules/mindweave",
  ]) {
    const install = classifyInstall(root, probe([]));
    assert.equal(install.kind, "app", root);
    assert.match(refusalReason(install) ?? "", /comes with the mwcode app/);
  }
});
