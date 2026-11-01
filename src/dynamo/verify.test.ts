import { test } from "node:test";
import assert from "node:assert/strict";
import { isFileMutation, mutationNeedsVerification, looksLikeVerification, isVerification, reScopeCheck, isBackgroundPollStep, stepFailureSignature, isServerManagementStep, normalizeErrorSignature, repeatFailureStep, repeatFailureNudge, failedActionLabel, firstErrorLine, narrationFault, narrationNudge, nearestTools, unknownToolError, closingAfterCheck, otherRoute, VERIFY_NUDGE, NARRATION_SENTENCES} from "./verify.js";

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

test("isVerification counts what really ran or looked at the work, and only that", () => {
  // The language server no longer answers a call of its own — its errors ride back with
  // every edit — so running or looking at the result is what verifies it.
  assert.ok(!isVerification("diagnostics", {}), "there is no such tool to count");
  assert.ok(isVerification("run_command", { command: "npm test" }));
  assert.ok(isVerification("run_command", { command: "node dist/index.js --version" }), "running the program is checking it");
  assert.ok(isVerification("run_command", { command: "python3 app.py" }));
  assert.ok(isVerification("run_command", { command: "curl -s localhost:3000/health" }));
  assert.ok(!isVerification("run_command", { command: "git status" }));
  assert.ok(!isVerification("run_command", { command: "Get-Content node_modules/x" }));
  assert.ok(!isVerification("read_file", { path: "x" }));
});

test("opening a page and looking at it is a check: a project of plain pages has no other", () => {
  assert.ok(isVerification("ui", { action: "look", url: "file:///x/index.html" }));
  assert.ok(isVerification("ui", { steps: [{ action: "click", name: "Movies" }] }));
  assert.ok(isVerification("screenshot", {}));
  assert.ok(!isVerification("ui", { action: "close" }), "closing the browser looks at nothing");
  assert.ok(isVerification("spawn_subagent", { verify: true }));
  assert.ok(!isVerification("spawn_subagent", { prompt: "go" }));
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

test("otherRoute: a stuck edit is pointed at the shell, and a stuck file-writing command at the edit tools", () => {
  const miss = "the edit could not be applied to a.js: old_string not found.";
  assert.match(otherRoute("edit", { path: "a.js" }, miss)!, /shell command/);
  assert.match(otherRoute("write_file", { path: "a.js" }, "disk is full")!, /shell command/);
  for (const command of [
    `[IO.File]::WriteAllText("a.js", $c)`,
    "Set-Content a.js x",
    "sed -i s/a/b/ a.js",
    "echo hi > a.js",
    "echo hi >> a.js",
  ]) {
    assert.match(otherRoute("run_command", { command }, "exit 1")!, /edit or write_file/, command);
  }
});

test("otherRoute: nothing for a command that changes no file, or after being turned away", () => {
  assert.equal(otherRoute("run_command", { command: "npm test" }, "1 failing"), null);
  assert.equal(otherRoute("run_command", { command: "npm test 2>&1" }, "1 failing"), null, "a redirect of a stream is not a file");
  assert.equal(otherRoute("read_file", { path: "a" }, "no such file"), null);
  // Offering a shell command here would be telling it to go round the protection.
  assert.equal(otherRoute("edit", { path: ".env" }, "Refusing to edit .env: it is an environment/secrets file."), null);
  assert.equal(otherRoute("run_command", { command: "Set-Content a.js x" }, "Stopped: the user declined this action."), null);
});

test("repeatFailureNudge: carries the other route when there is one", () => {
  const route = "You can also make this change with a shell command.";
  assert.ok(repeatFailureNudge({ attempts: 3, action: "edit a.js", error: "not found", route }).includes(route));
  assert.doesNotMatch(repeatFailureNudge({ attempts: 3, action: "npm test", error: "1 failing", route: null }), /null/);
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

// ── What is left of a turn that was sent back to check its work ───────────────
// Seen as a turn that built a whole page and said only "I checked it as I built it".

const FULL = "The Movies page is in place at movies.html, with 74 titles, genre filters and the same Sort picker as Music CDs.";

test("a second reply that says about as much as the first is the rewrite that was asked for", () => {
  const rewrite = "Movies is at movies.html: 74 titles, genre filters, and the same Sort picker as the Music CDs page.";
  assert.equal(closingAfterCheck(FULL, rewrite, { ranSomething: true, changedSince: false }), rewrite);
  assert.equal(closingAfterCheck(FULL, rewrite, { ranSomething: false, changedSince: false }), rewrite);
});

test("an excuse written without running anything never replaces what was done", () => {
  const excuse = "No build or test suite applies here.";
  assert.equal(closingAfterCheck(FULL, excuse, { ranSomething: false, changedSince: false }), FULL);
});

test("a short line after a real check is added to what was done, not swapped for it", () => {
  const line = "Horror + New returns three titles.";
  assert.equal(closingAfterCheck(FULL, line, { ranSomething: true, changedSince: false }), `${FULL}\n\n${line}`);
});

test("once a file changed after the first reply, that reply is out of date", () => {
  const line = "Fixed the footer, which the check showed was missing.";
  assert.equal(closingAfterCheck(FULL, line, { ranSomething: true, changedSince: true }), line);
});

test("an empty reply on either side leaves the other", () => {
  assert.equal(closingAfterCheck("", "Done.", { ranSomething: false, changedSince: false }), "Done.");
  assert.equal(closingAfterCheck(FULL, "  ", { ranSomething: true, changedSince: false }), FULL);
});

test("the nudge says the reply was not shown, and asks for nothing about the check", () => {
  // Without the first the model answers it as if the person had asked; whatever the second asks for is what they read.
  assert.match(VERIFY_NUDGE, /NOT shown/);
  assert.match(VERIFY_NUDGE, /write your closing reply again in full/);
  assert.match(VERIFY_NUDGE, /never say that a project has no build or tests/);
  assert.doesNotMatch(VERIFY_NUDGE, /say so in one line/, "the line that produced the phrase is back");
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

test("a made-up name that is another program's word for one of our tools says which tool, and what it does", () => {
  const known = ["ask_user", "read_file", "run_command", "search"];
  const describe = (t: string) => (t === "ask_user" ? "Ask the user a question and wait for the answer. Use it when you need a decision." : undefined);
  const q = unknownToolError("question", known, describe);
  assert.match(q, /most likely meant 'ask_user'/);
  assert.match(q, /Ask the user a question/);
  assert.match(q, /Call 'ask_user' in your next step/);
  // Case and punctuation do not matter, and every one of the familiar words reaches its tool.
  assert.match(unknownToolError("Ask-User", known), /'ask_user'/);
  assert.match(unknownToolError("bash", known), /'run_command'/);
  assert.match(unknownToolError("cat", known), /'read_file'/);
  assert.match(unknownToolError("grep", known), /'search'/);
  // A tool that is not offered is never named, and a name nobody knows still gets the old answer.
  assert.doesNotMatch(unknownToolError("bash", ["read_file"]), /run_command/);
  assert.match(unknownToolError("zzzzzz", known), /find_tools/);
});
