/**
 * args.test.ts — what `mindweave -p ...` understands, and what it refuses.
 *
 * A script has no one to notice a flag that was silently ignored, so the failure cases matter
 * as much as the working ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeadlessArgs, type HeadlessOptions } from "./args.js";
import { parseStartupArgs } from "../cli/startupArgs.js";

function ok(argv: string[]): HeadlessOptions {
  const r = parseHeadlessArgs(argv);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.options;
}
function bad(argv: string[]): string {
  const r = parseHeadlessArgs(argv);
  assert.ok(!r.ok, "expected a usage error");
  return r.ok ? "" : r.error;
}

test("a task in quotes is the prompt, and the defaults are the quiet-script ones", () => {
  assert.deepEqual(ok(["-p", "fix the login"]), { prompt: "fix the login", format: "text", quiet: false, continueLast: false });
});

test("loose words are joined, so an unquoted task means the same as a quoted one", () => {
  assert.equal(ok(["-p", "fix", "the", "login"]).prompt, "fix the login");
  assert.equal(ok(["fix", "-p", "login"]).prompt, "fix login");
});

test("no task at all is not an error here: it may arrive on stdin", () => {
  assert.equal(ok(["-p"]).prompt, null);
});

test("--print is -p", () => {
  assert.equal(ok(["--print", "hi"]).prompt, "hi");
});

test("every value flag takes either '--flag value' or '--flag=value'", () => {
  const o = ok(["-p", "go", "--output-format", "json", "--mode=architect", "--model", "gemini-3.7-flash", "--resume=abc-123"]);
  assert.equal(o.format, "json");
  assert.equal(o.mode, "architect");
  assert.equal(o.model, "gemini-3.7-flash");
  assert.equal(o.resumeId, "abc-123");
  assert.equal(o.prompt, "go", "a flag's value is never part of the task");
});

test("the three formats and the three modes are the only ones", () => {
  for (const f of ["text", "json", "stream-json"]) assert.equal(ok(["-p", "x", "--output-format", f]).format, f);
  for (const m of ["lightning", "architect", "sentinel"]) assert.equal(ok(["-p", "x", "--mode", m]).mode, m);
  assert.match(bad(["-p", "x", "--output-format", "xml"]), /text, json, stream-json/);
  assert.match(bad(["-p", "x", "--mode", "yolo"]), /lightning, architect, sentinel/);
});

test("--continue and -q set their flags; --continue with --resume is refused", () => {
  const o = ok(["-p", "more", "-c", "-q"]);
  assert.equal(o.continueLast, true);
  assert.equal(o.quiet, true);
  assert.match(bad(["-p", "x", "--continue", "--resume", "abc"]), /not both/);
});

test("an unknown flag is a usage error, not something quietly ignored", () => {
  assert.match(bad(["-p", "x", "--mdoe", "architect"]), /Unknown option: --mdoe/);
  assert.match(bad(["-p", "x", "-z"]), /Unknown option: -z/);
});

test("a flag with no value, or an unsafe session id, is refused", () => {
  assert.match(bad(["-p", "x", "--mode"]), /needs a value/);
  assert.match(bad(["-p", "x", "--model="]), /needs a value/);
  assert.match(bad(["-p", "x", "--resume", "../../etc"]), /session id/);
});

test("'--' lets a task start with a dash", () => {
  assert.equal(ok(["-p", "--", "-1 is wrong, why?"]).prompt, "-1 is wrong, why?");
});

test("a lone '-' is text, not a flag", () => {
  assert.equal(ok(["-p", "-"]).prompt, "-");
});

// ── how the launcher decides ─────────────────────────────────────────────────

test("-p anywhere on the command line makes the launch headless, with the arguments handed over whole", () => {
  assert.deepEqual(parseStartupArgs(["-p", "hi"]), { kind: "headless", argv: ["-p", "hi"] });
  assert.deepEqual(parseStartupArgs(["fix it", "--print"]), { kind: "headless", argv: ["fix it", "--print"] });
});

test("--help and --version still win, so they work with -p too", () => {
  assert.equal(parseStartupArgs(["-p", "--help"]).kind, "print");
  assert.equal(parseStartupArgs(["--version", "-p"]).kind, "print");
});

test("without -p nothing changes: --resume is still the relaunch flag and stray words are ignored", () => {
  assert.deepEqual(parseStartupArgs(["--resume", "9603f18c-514e-45d0-a672-52284b75e8c4"]), {
    kind: "run",
    resumeSessionId: "9603f18c-514e-45d0-a672-52284b75e8c4",
  });
  assert.deepEqual(parseStartupArgs(["whatever"]), { kind: "run" });
});

test("with -p, --resume names the session to continue and is left for the headless parser", () => {
  const s = parseStartupArgs(["-p", "more", "--resume", "abc"]);
  assert.equal(s.kind, "headless");
  assert.equal(ok(s.kind === "headless" ? s.argv : []).resumeId, "abc");
});
