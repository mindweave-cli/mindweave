/**
 * editRipple.test.ts — the automatic post-edit check.
 *
 * The behaviour being pinned is the one the `diagnostics` tool's own description admits
 * it cannot provide: after an edit, the broken file is often the CALLER, and a per-file
 * check never looks there. So the tests that matter are about the target SET and about
 * staying silent when there is nothing honest to say.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { editedPaths, rippleTargets, formatRippleNote, MAX_DEPENDENTS } from "./editRipple.js";
import type { CodeDiagnostic } from "../alternator/chassis/types.js";
import type { ToolContext } from "./types.js";
import { sep } from "node:path";

const diag = (file: string, line: number, severity: "error" | "warning", message: string): CodeDiagnostic =>
  ({ file, line, column: 1, severity, message, source: "ts" }) as CodeDiagnostic;

/** A ctx whose single chassis answers `dependents` from a fixed map. */
function ctxWith(deps: Record<string, string[]>): ToolContext {
  const chassis = {
    async outline() { return []; },
    async definition() { return { symbols: [], confidence: "name-level" as const }; },
    async references() { return { refs: [], confidence: "name-level" as const }; },
    async relevant() { return []; },
    async span() { return []; },
    async directorySummary() { return null; },
    async diagnostics() { return []; },
    async dependents(abs: string) { return deps[abs] ?? []; },
    status() { return { ready: true, files: 1, symbols: 1, resolvedLanguages: [] }; },
  };
  return { cwd: "/repo", roots: ["/repo"], chassis, reads: new Map() } as unknown as ToolContext;
}

const idResolve = (p: string) => p;

test("only successful edits count as edits", () => {
  const got = editedPaths(
    [
      { name: "edit", args: { path: "/repo/a.ts" } },
      { name: "edit", args: { path: "/repo/broken.ts" }, isError: true },
      { name: "read_file", args: { path: "/repo/b.ts" } },
      { name: "grep", args: { pattern: "x" } },
    ],
    idResolve,
  );
  // A failed edit changed nothing; checking it would report pre-existing errors as if
  // this turn had caused them. A read is not an edit at all.
  assert.deepEqual(got, ["/repo/a.ts"]);
});

test("the target set is the edited files PLUS the files that import them", async () => {
  const ctx = ctxWith({ "/repo/api.ts": ["/repo/ui.ts", "/repo/cli.ts"] });
  const targets = await rippleTargets(ctx, ["/repo/api.ts"]);
  assert.deepEqual(targets, ["/repo/api.ts", "/repo/ui.ts", "/repo/cli.ts"]);
});

test("edited files come first when the dependent cap bites", async () => {
  const many = Array.from({ length: MAX_DEPENDENTS + 10 }, (_, i) => `/repo/dep${i}.ts`);
  const ctx = ctxWith({ "/repo/hub.ts": many });
  const targets = await rippleTargets(ctx, ["/repo/hub.ts"]);
  assert.equal(targets[0], "/repo/hub.ts", "the file the model just edited must never be dropped");
  assert.equal(targets.length, 1 + MAX_DEPENDENTS);
});

test("a file is never checked twice when two edits share a dependent", async () => {
  const ctx = ctxWith({ "/repo/a.ts": ["/repo/ui.ts"], "/repo/b.ts": ["/repo/ui.ts"] });
  const targets = await rippleTargets(ctx, ["/repo/a.ts", "/repo/b.ts"]);
  assert.deepEqual(targets, ["/repo/a.ts", "/repo/b.ts", "/repo/ui.ts"]);
});

test("nothing is said when nothing was found", () => {
  // Silence is the honest answer: no server, a slow server and an unreadable path are
  // indistinguishable from a clean file, so an all-clear would be a claim we cannot make.
  assert.equal(formatRippleNote([], new Set(), (p) => p), "");
});

test("a diagnostic in a file the model did NOT edit is marked as a caller", () => {
  const note = formatRippleNote(
    [diag("/repo/ui.ts", 12, "error", "Expected 2 arguments, but got 1.")],
    new Set(["/repo/api.ts"]),
    (p) => p,
  );
  // Asserted on the diagnostic's own LINE, not anywhere in the note. The header text
  // explains what "(caller)" means, so a note-wide regex matches even when the marking
  // is broken — this test passed with the marking deleted until it was narrowed.
  const line = note.split("\n").find((l) => l.startsWith("- /repo/ui.ts"))!;
  assert.ok(line, "the diagnostic must be listed");
  assert.match(line, /\(caller\)/, "a broken caller must be distinguishable from a broken edit");
  assert.match(line, /Expected 2 arguments/);
});

test("a diagnostic in a file the model DID edit is not marked as a caller", () => {
  // The other half: mark everything and the distinction is just as useless as marking
  // nothing. Both directions have to be checked or the label carries no information.
  const note = formatRippleNote(
    [diag("/repo/api.ts", 3, "error", "Cannot find name 'foo'.")],
    new Set(["/repo/api.ts"]),
    (p) => p,
  );
  const line = note.split("\n").find((l) => l.startsWith("- /repo/api.ts"))!;
  assert.doesNotMatch(line, /\(caller\)/);
});

test("errors are reported before warnings", () => {
  const note = formatRippleNote(
    [
      diag("/repo/a.ts", 1, "warning", "unused import"),
      diag("/repo/a.ts", 2, "error", "Type 'string' is not assignable to type 'number'."),
    ],
    new Set(["/repo/a.ts"]),
    (p) => p,
  );
  const errAt = note.indexOf("not assignable");
  const warnAt = note.indexOf("unused import");
  assert.ok(errAt < warnAt, "one type error must not be buried under lint warnings");
});

test("caller warnings and schema-loading noise are not reported; the edited file's are, under either slash", () => {
  // The edited path in the platform's own separators; the diagnostic always uses "/".
  const edited = (process.platform === "win32" ? "C:/p/src/a.ts" : "/p/src/a.ts").split("/").join(sep);
  const editedShown = process.platform === "win32" ? "C:/p/src/a.ts" : "/p/src/a.ts";
  const d = (file: string, severity: "error" | "warning", message: string) => ({ file, line: 1, column: 1, severity, message }) as never;
  const note = formatRippleNote(
    [
      d(editedShown, "warning", "unused variable"),
      d("/p/tauri.conf.json", "warning", "Unable to load schema from 'desktop-schema.json': ENOENT"),
      d("/p/other.json", "warning", "Property windows is not allowed"),
      d("/p/src/b.ts", "error", "Expected 1 arguments, but got 0"),
    ],
    new Set([edited]),
    (p) => p,
  );
  assert.match(note, /unused variable/, "a warning in the edited file is kept");
  assert.ok(!/unused variable \(caller\)|:1 \(caller\) warning: unused/.test(note), "the edited file is not called a caller");
  assert.match(note, /b\.ts:1 \(caller\) error/);
  assert.ok(!/schema|windows is not allowed/.test(note), "noise was reported");
  assert.equal(formatRippleNote([d("/p/x.json", "warning", "Property windows is not allowed")], new Set([edited]), (p) => p), "");
});
