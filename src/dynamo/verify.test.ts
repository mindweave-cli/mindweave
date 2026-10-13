import { test } from "node:test";
import assert from "node:assert/strict";
import { isFileMutation, mutationNeedsVerification, looksLikeVerification, isVerification, reScopeCheck, isBackgroundPollStep, stepFailureSignature, isServerManagementStep, normalizeErrorSignature, repeatFailureStep, repeatFailureNudge, failedActionLabel, firstErrorLine, narrationFault, narrationNudge, nearestTools, unknownToolError, replyFault, replyRewrite, REPLY_LINES, NARRATION_SENTENCES} from "./verify.js";

test("file mutations are the edit/write tools", () => {
  assert.ok(isFileMutation("edit"));
  assert.ok(isFileMutation("write_file"));
  assert.ok(isFileMutation("replace_symbol_body"));
  assert.ok(!isFileMutation("read_file"));
  assert.ok(!isFileMutation("run_command"));
});

test("mutationNeedsVerification: code/config edits DO need a check", () => {
  assert.ok(mutationNeedsVerification("edit", { path: "src/dynamo/engine.ts" }));
  assert.ok(mutationNeedsVerification("write_file", { path: "src/App.tsx" }));
  assert.ok(mutationNeedsVerification("edit", { path: "src-tauri/Cargo.toml" }));
  assert.ok(mutationNeedsVerification("write_file", { path: "package.json" }));
  assert.ok(mutationNeedsVerification("replace_symbol_body", { path: "lib.rs" }));
});

test("mutationNeedsVerification: docs-only edits do NOT trip the gate", () => {
  assert.ok(!mutationNeedsVerification("edit", { path: "MINDWEAVE.md" }));
  assert.ok(!mutationNeedsVerification("write_file", { path: "docs/README.md" }));
  assert.ok(!mutationNeedsVerification("edit", { path: "notes.txt" }));
  assert.ok(!mutationNeedsVerification("write_file", { path: "CHANGELOG.mdx" }));
});

test("mutationNeedsVerification: non-mutations and unknown paths", () => {
  // A read is never a mutation, so it never needs verification.
  assert.ok(!mutationNeedsVerification("read_file", { path: "MINDWEAVE.md" }));
  assert.ok(!mutationNeedsVerification("run_command", { command: "npm test" }));
  // An extensionless or missing path is treated as code (safe default: gate fires).
  assert.ok(mutationNeedsVerification("write_file", { path: "Dockerfile" }));
  assert.ok(mutationNeedsVerification("edit", {}));
  // A dot in a directory name, not the filename, is not an extension.
  assert.ok(mutationNeedsVerification("write_file", { path: "my.docs/lib" }));
});

test("looksLikeVerification recognizes real checks", () => {
  for (const cmd of [
    "npm test",
    "npm run build",
    "pnpm run typecheck",
    "yarn lint",
    "npx tsc --noEmit",
    "tsc",
    "vitest run",
    "npx jest src/",
    "pytest -q",
    "mypy .",
    "ruff check .",
    "go test ./...",
    "cargo test",
    "cargo clippy",
    "make check",
    "eslint src",
  ]) {
    assert.ok(looksLikeVerification(cmd), `should detect: ${cmd}`);
  }
});

test("looksLikeVerification ignores ordinary commands", () => {
  for (const cmd of [
    "ls -la",
    "git status",
    "echo hello",
    "cat package.json",
    "cd src",
    "mkdir build", // 'build' as an argument to mkdir, not a build command
    "node server.js",
  ]) {
    assert.ok(!looksLikeVerification(cmd), `should NOT detect: ${cmd}`);
  }
});

test("isVerification counts check-like commands, and only those", () => {
  // The language server no longer answers a call of its own — its errors ride back with
  // every edit — so running the project is the only thing left that verifies it.
  assert.ok(!isVerification("diagnostics", {}), "there is no such tool to count");
  assert.ok(isVerification("run_command", { command: "npm test" }));
  assert.ok(!isVerification("run_command", { command: "git status" }));
  assert.ok(!isVerification("read_file", { path: "x" }));
});

test("reScopeCheck: an ordinary turn that never completes a list never pauses", () => {
  // Editing with an in-progress list — no completion yet, no pause.
  const r = reScopeCheck(false, [{ name: "edit", summary: "edited" }], [
    { status: "in_progress" },
    { status: "pending" },
  ]);
  assert.equal(r.completed, false);
  assert.equal(r.pause, false);
});

test("reScopeCheck: the completing step itself does not pause (list is cleared)", () => {
  // todo_write reports all done; the list clears to empty → nothing pending yet.
  const r = reScopeCheck(false, [{ name: "todo_write", summary: "all tasks completed" }], []);
  assert.equal(r.completed, true);
  assert.equal(r.pause, false);
});

test("reScopeCheck: a NEW pending list after a completion triggers the pause", () => {
  // Prior step already completed a list; now a fresh pending list appears.
  const r = reScopeCheck(true, [{ name: "todo_write", summary: "task list updated (0/7 done)" }], [
    { status: "pending" },
    { status: "pending" },
  ]);
  assert.equal(r.completed, true);
  assert.equal(r.pause, true);
});

test("reScopeCheck: finishing then answering (no new list) does not pause", () => {
  // Completed earlier, and the model is wrapping up — the list stays empty.
  const r = reScopeCheck(true, [{ name: "edit", summary: "edited" }], []);
  assert.equal(r.pause, false);
});

test("isBackgroundPollStep: reading a still-running shell is a poll step", () => {
  assert.equal(isBackgroundPollStep([{ name: "shells", summary: "shell #1 (running)" }]), true);
});

test("isBackgroundPollStep: listing with something running is a poll step", () => {
  assert.equal(isBackgroundPollStep([{ name: "shells", summary: "1 running, 1 total" }]), true);
});

test("isBackgroundPollStep: listing with nothing running is NOT a poll step", () => {
  // "0 running, 2 total" must not false-match on the word "running".
  assert.equal(isBackgroundPollStep([{ name: "shells", summary: "0 running, 2 total" }]), false);
});

test("isBackgroundPollStep: polling a FINISHED shell is not a poll step (model can report it)", () => {
  assert.equal(isBackgroundPollStep([{ name: "shells", summary: "shell #1 (exited 0)" }]), false);
});

test("isBackgroundPollStep: real work alongside a poll is not a poll step", () => {
  const step = [
    { name: "shells", summary: "shell #1 (running)" },
    { name: "edit", summary: "edited app.tsx" },
  ];
  assert.equal(isBackgroundPollStep(step), false);
});

test("isBackgroundPollStep: an empty step is not a poll step", () => {
  assert.equal(isBackgroundPollStep([]), false);
});

// ── Fix A: the repeat-failure breaker (pure) ──

test("stepFailureSignature: null unless EVERY result in the step errored", () => {
  assert.equal(stepFailureSignature([]), null);
  // A success alongside the failure = progress, so no signature (streak resets).
  assert.equal(
    stepFailureSignature([
      { name: "run_command", output: "boom", isError: true },
      { name: "read_file", output: "ok", isError: false },
    ]),
    null,
  );
  assert.ok(stepFailureSignature([{ name: "edit", output: "file not found", isError: true }]));
});

test("stepFailureSignature: same edit failing twice yields the same signature", () => {
  const a = stepFailureSignature([{ name: "edit", output: "file src/App.css not found. Use write_file.", isError: true }]);
  const b = stepFailureSignature([{ name: "edit", output: "file src/App.css not found. Use write_file.", isError: true }]);
  assert.equal(a, b);
});

test("stepFailureSignature: near-identical PowerShell $pid errors collapse to one signature", () => {
  // Transcript 2: different commands, same read-only-variable error. The code-echo and
  // char position differ; the stable message must make them match so the streak counts.
  const err1 =
    "Cannot overwrite variable PID because it is read-only or constant.\n" +
    "At line:1 char:80\n" +
    "+ ... ForEach-Object { $t = $_ -split ' '; $pid = $t[$t.Count-1]; if ($p ...\n" +
    "+                                             ~~~~~~~~~~~~~~~~~~~~~\n" +
    "    + CategoryInfo          : WriteError: (PID:String) [], SessionStateUnauthorizedAccessException";
  const err2 =
    "Cannot overwrite variable PID because it is read-only or constant.\n" +
    "At line:1 char:99\n" +
    "+ ... ForEach-Object { $parts = $_ -split ' '; $pid = $parts[-1]; if ($p ...\n" +
    "+                                                 ~~~~~~~~~~~~~~~~~\n" +
    "    + CategoryInfo          : WriteError: (PID:String) [], SessionStateUnauthorizedAccessException";
  const a = stepFailureSignature([{ name: "run_command", output: err1, isError: true }]);
  const b = stepFailureSignature([{ name: "run_command", output: err2, isError: true }]);
  assert.ok(a);
  assert.equal(a, b);
});

test("stepFailureSignature: genuinely different errors do NOT match", () => {
  const a = stepFailureSignature([{ name: "run_command", output: "Cannot overwrite variable PID because it is read-only or constant.", isError: true }]);
  const b = stepFailureSignature([{ name: "run_command", output: "Cannot bind argument to parameter 'Id' because it is null.", isError: true }]);
  assert.notEqual(a, b);
});

test("normalizeErrorSignature: drops code-echo/caret/location noise and digits", () => {
  const sig = normalizeErrorSignature(
    "Cannot overwrite variable PID because it is read-only or constant.\nAt line:1 char:80\n+ $pid = 5\n~~~~~~~",
  );
  assert.match(sig, /cannot overwrite variable pid/);
  assert.doesNotMatch(sig, /char:|~|line:/);
});

// ---------------------------------------------------------------------------
// The repeat-failure breaker's two tiers.
//
// These exist because of a real session: the model doubled a path (`cd` had moved
// the shell), ran the same command three times, and the turn ended with nothing on
// screen. The breaker had fired correctly and told nobody — not the user, and not
// the model, which had no way to know it was repeating itself at all.
// ---------------------------------------------------------------------------

test("repeatFailureStep: does nothing below the limit", () => {
  assert.equal(repeatFailureStep(1, 3, false), "none");
  assert.equal(repeatFailureStep(2, 3, false), "none");
});

test("repeatFailureStep: the FIRST trip interrupts, it does not stop the turn", () => {
  assert.equal(repeatFailureStep(3, 3, false), "nudge");
});

test("repeatFailureStep: stops only once the model has already been told", () => {
  assert.equal(repeatFailureStep(3, 3, true), "stop");
  assert.equal(repeatFailureStep(9, 3, true), "stop");
});

test("repeatFailureStep: no streak can ever stop a turn without a nudge first", () => {
  for (let streak = 0; streak < 25; streak++) {
    assert.notEqual(
      repeatFailureStep(streak, 3, false),
      "stop",
      `streak ${streak} stopped the turn without ever telling the model it was looping`,
    );
  }
});

test("repeatFailureNudge: states the count, the action, the error, and the consequence", () => {
  const msg = repeatFailureNudge({
    attempts: 3,
    action: "python code-blue/backend/manage.py check",
    error: "can't open file 'manage.py': No such file or directory",
    cwd: "D:/Protocol Axiom/code-blue/backend",
  });
  assert.match(msg, /3 times/);
  assert.match(msg, /manage\.py check/);
  assert.match(msg, /No such file or directory/);
  assert.match(msg, /will end the turn/);
  // The working directory is the whole point: without it the model cannot see why
  // its path doubled, which is the failure this nudge was written for.
  assert.match(msg, /code-blue\/backend/);
});

test("repeatFailureNudge: mentions the working directory only when the shell has moved", () => {
  const msg = repeatFailureNudge({ attempts: 3, action: "npm test", error: "1 failing" });
  assert.doesNotMatch(msg, /working directory|shell is currently/i);
});

test("failedActionLabel: a shell failure shows the command that was actually run", () => {
  assert.equal(
    failedActionLabel("run_command", { command: "  python manage.py check  " }),
    "python manage.py check",
  );
});

test("failedActionLabel: other tools show what they acted on, or just their name", () => {
  assert.equal(failedActionLabel("edit", { path: "src/App.css" }), "edit src/App.css");
  assert.equal(failedActionLabel("read_file", { file_path: "a.ts" }), "read_file a.ts");
  assert.equal(failedActionLabel("todo_write", {}), "todo_write");
});

test("failedActionLabel: a runaway command is clipped, not pasted whole", () => {
  const label = failedActionLabel("run_command", { command: "echo " + "x".repeat(500) });
  assert.ok(label.length <= 160, `label was ${label.length} chars`);
  assert.ok(label.endsWith("…"));
});

test("firstErrorLine: skips PowerShell's code-echo and caret decoration", () => {
  const line = firstErrorLine("\n+ python manage.py check\n~~~~~\nCannot find path 'manage.py'.");
  assert.equal(line, "Cannot find path 'manage.py'.");
});

test("firstErrorLine: falls back rather than returning nothing to show", () => {
  assert.equal(firstErrorLine(""), "the same error");
});

// ── narration budget ──────────────────────────────────────────────────────────

test("an essay between tool calls is over budget", () => {
  const long =
    "I have a clear picture now. Let me analyze each item. First the overlap is real. " +
    "The cleanest fix is one helper. Actually cleaner: keep them separate.";
  const f = narrationFault(long, []);
  assert.equal(f?.kind, "length");
  assert.ok((f?.sentences ?? 0) > NARRATION_SENTENCES);
  assert.match(narrationNudge(f!), /budget is 2/);
});

test("restating is caught even when the block is SHORT", () => {
  // The fault a length cap misses, and the one that made the real session unreadable:
  // three individually-brief blocks that each re-summarise the same picture.
  const first = "getActiveSubsCost and getTotalExpenses both compute getSubscriptionCost.";
  const again = "So getSubscriptionCost, getTotalExpenses and getActiveSubsCost are all wired.";
  const f = narrationFault(again, [first]);
  assert.equal(f?.kind, "restating");
  assert.equal(f?.sentences, 1, "one sentence — a length rule would have passed it");
  assert.match(narrationNudge(f!), /only what is NEW/);
});

test("re-derivation is matched on SUBJECT, not wording", () => {
  // Paraphrase defeats phrase matching: none of these words repeat, the identifiers do.
  const first = "The overlap sits in getActiveSubsCost, getTotalExpenses and calculateSalary.";
  const paraphrased = "Looking again: calculateSalary duplicates getTotalExpenses, same as getActiveSubsCost.";
  assert.equal(narrationFault(paraphrased, [first])?.kind, "restating");
});

test("a normal step passes untouched", () => {
  assert.equal(narrationFault("Build passed. Running the tests now.", []), null);
  assert.equal(narrationFault("", ["anything"]), null);
});

test("naming the same file twice is not restating", () => {
  // The threshold has to clear ordinary continuity — mentioning what you are editing
  // is not a summary. Two shared identifiers stay under it.
  const first = "Patching runCommand in backgroundShells.";
  const next = "runCommand is patched; backgroundShells still needs the guard.";
  assert.equal(narrationFault(next, [first]), null);
});

test("a near-miss tool name gets a suggestion the model can act on", () => {
  // The point of the hint: turn a dead end into a correction. A one-character slip
  // and a plural are both things a model actually produces.
  assert.deepEqual(nearestTools("read_fil", ["read_file", "write_file", "search"]), ["read_file"]);
  assert.deepEqual(nearestTools("searches", ["read_file", "write_file", "search"]), ["search"]);
});

test("a name nothing resembles gets NO suggestion rather than the shortest one", () => {
  // Seen live: the model invented `index_results`. Pointing it at whichever registered
  // name happens to be shortest is worse than pointing it at nothing.
  assert.deepEqual(nearestTools("index_results", ["read_file", "write_file", "search", "edit"]), []);
});

test("the unknown-tool error names the tool, denies it exists, and gives a way forward", () => {
  const near = unknownToolError("read_fil", ["read_file", "search"]);
  assert.match(near, /unknown tool 'read_fil'/);
  assert.match(near, /Did you mean 'read_file'\?/);

  const far = unknownToolError("index_results", ["read_file", "search"]);
  assert.match(far, /unknown tool 'index_results'/);
  assert.match(far, /find_tools/, "with no near miss it must still say where to look");
});

// ── The reply gate ────────────────────────────────────────────────────────────
// Written against the observed failure: asked what was missing from a frontend, it
// answered with two bold section labels, eleven bullets, three numbered questions and
// an "My honest opinion" paragraph. The prompt already forbade all of that.

test("a turn that only ANSWERED is never gated, however long", () => {
  // The budget exists to stop padding after work, not to stop answering a question.
  const essay = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of a real explanation.`).join("\n");
  assert.equal(replyFault(essay, false), null);
});

test("a short plain confirmation after work passes", () => {
  assert.equal(replyFault("Added. The spending-cap branch now subtracts subs before the split.", true), null);
});

test("a wall of prose after work is over budget", () => {
  const wall = Array.from({ length: 9 }, (_, i) => `Sentence ${i} recapping what you just watched.`).join("\n");
  const fault = replyFault(wall, true);
  assert.equal(fault?.kind, "length");
  assert.equal(fault?.lines, 9);
});

test("headings are refused after work at ANY length", () => {
  // A four-line answer that needs a heading is not a four-line answer.
  const fault = replyFault("## What changed\nThe cap now subtracts subs.", true);
  assert.equal(fault?.kind, "shape");
  assert.match(fault!.detail, /heading/);
});

test("bold section labels are refused — they are headings wearing a disguise", () => {
  const fault = replyFault("**What exists:**\nThe cart loop is closed.", true);
  assert.equal(fault?.kind, "shape");
  assert.match(fault!.detail, /bold section label/);
});

test("one question is allowed, two are not", () => {
  assert.equal(replyFault("Done. Want me to remove the stale reference too?", true), null);
  const fault = replyFault("Done. Should I remove it? Or leave it for later?", true);
  assert.equal(fault?.kind, "shape");
  assert.match(fault!.detail, /2 questions/);
});

test("a fenced code block does not count against the budget", () => {
  // A snippet or a diff in the reply is content, never padding.
  const withCode = ["Fixed it, the guard was inverted.", "```ts", "a", "b", "c", "d", "e", "f", "```"].join("\n");
  assert.equal(replyFault(withCode, true), null);
});

test("blank lines do not count as lines", () => {
  const spaced = "One.\n\nTwo.\n\nThree.\n\nFour.";
  assert.equal(replyFault(spaced, true), null, `${REPLY_LINES} lines of prose is within budget however it is spaced`);
});

test("an empty reply is not a fault", () => {
  assert.equal(replyFault("   ", true), null);
});

test("the rewrite instruction names the fault, not just 'be shorter'", () => {
  // "Be shorter" produces a shorter version of the same shape.
  const shape = replyRewrite(replyFault("## Heading\nbody", true)!);
  assert.match(shape, /1 heading/);
  assert.match(shape, /plain prose/);

  const length = replyRewrite(replyFault(Array.from({ length: 9 }, () => "Line.").join("\n"), true)!);
  assert.match(length, /9 lines/);
  assert.match(length, new RegExp(`${REPLY_LINES} lines or fewer`));
});

test("stepFailureSignature: different tools of ONE failing MCP server are the same failure", () => {
  // open_binary, then binary_session, then list_adb_devices, each told the server is not
  // running: one mistake three times, not three different failures.
  const sig = (name: string) => stepFailureSignature([{ name, output: "Error: mcp server 'rea' is not running", isError: true }]);
  assert.equal(sig("mcp__rea__open_binary"), sig("mcp__rea__binary_session"));
  assert.notEqual(sig("mcp__rea__open_binary"), sig("mcp__other__open_binary"), "another server is another failure");
  assert.notEqual(sig("run_command"), sig("edit"), "built-in tools still count by name");
});

test("isServerManagementStep: only a step made of mcp_server calls", () => {
  assert.equal(isServerManagementStep(["mcp_server"]), true);
  assert.equal(isServerManagementStep(["mcp_server", "mcp_server"]), true);
  assert.equal(isServerManagementStep(["mcp_server", "run_command"]), false);
  assert.equal(isServerManagementStep([]), false);
});
