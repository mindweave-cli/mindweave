/**
 * verify.ts — the verification gate's fact detectors (pure).
 *
 * The gate's job is narrow and honest: notice when the model edited files this
 * turn and then tried to finish WITHOUT ever checking its work, and nudge once.
 * It decides nothing about engineering — it only reports two observable facts:
 * "was a file changed?" and "was a check run?". WHAT counts as an adequate check
 * for a given task stays the model's judgment (the thin-prompt boundary). Keeping
 * these as pure predicates means the behavior is unit-tested, never blind-shipped.
 */

import { aliasTarget, shortExplanation } from "./toolAliases.js";

/** True if a tool call changed files on disk (an edit or a write). */
export function isFileMutation(toolName: string): boolean {
  return toolName === "edit" || toolName === "write_file" || toolName === "replace_symbol_body";
}

/** File extensions whose content has no runtime surface — prose/docs, not code or
 *  config. A build, test, or type check can't catch anything in them, so editing
 *  ONLY these needs no verification. Deliberately narrow: config formats like .json,
 *  .toml, .yaml stay OUT (a broken tsconfig/Cargo.toml fails the build), so they DO
 *  need a check. */
const NON_RUNTIME_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
]);

/**
 * Should a mutating tool call oblige the verification gate — i.e. did it change a
 * file with a runtime surface (code/config a check could catch a problem in)?
 * A docs-only edit (MINDWEAVE.md, a README, a .txt) returns false, so the gate never
 * fires on it and the model is never forced to explain that "no check applies".
 * An unknown/extensionless path is treated as code (safe default: the gate fires).
 */
export function mutationNeedsVerification(toolName: string, args: Record<string, unknown>): boolean {
  if (!isFileMutation(toolName)) return false;
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return true; // unknown target — be safe, treat as code
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // A dot only counts as an extension if it's in the final path segment.
  const ext = dot > slash ? path.slice(dot).toLowerCase() : "";
  return !NON_RUNTIME_EXTENSIONS.has(ext);
}

/**
 * Does a shell command look like a build / test / typecheck / lint — i.e. a real
 * verification of code? Conservative and matched on the command's program names,
 * so ordinary commands (ls, git status, echo) never read as a check. Case-insensitive.
 */
export function looksLikeVerification(command: string): boolean {
  const c = command.toLowerCase();
  // Package-runner scripts: `npm test`, `npm run build`, `pnpm typecheck`, `yarn lint`, etc.
  if (/\b(npm|pnpm|yarn|bun)\b[^\n|&;]*\b(test|build|lint|typecheck|type-check|check|tsc|vitest|jest)\b/.test(c)) return true;
  // Direct tool invocations across common ecosystems.
  const tools = [
    "tsc",
    "vitest",
    "jest",
    "mocha",
    "eslint",
    "biome",
    "pytest",
    "mypy",
    "ruff",
    "pyright",
    "go test",
    "go build",
    "go vet",
    "cargo test",
    "cargo build",
    "cargo check",
    "cargo clippy",
    "gradle test",
    "mvn test",
    "mvn verify",
    "make test",
    "make check",
    "ctest",
    "rspec",
    "phpunit",
  ];
  return tools.some((t) => new RegExp(`(^|[\\s|&;])${t.replace(/ /g, "\\s+")}\\b`).test(c));
}

/** A command that runs a program or a script: running the thing is checking it. A shell on its own is not here, since it can do anything. */
const RUNS_A_PROGRAM = /(^|[\s|&;])(node|deno|bun|python3?|py|ruby|php|java|dotnet|swift|go\s+run|cargo\s+run|curl)\s+\S/i;

/**
 * Did this tool call count as verifying the work? Anything that really ran or really looked at it:
 * a build, test, typecheck or lint, a program or script being run, the page or app being opened and
 * looked at with `ui` or `screenshot`, or a verifier sub-agent.
 *
 * The browser has to count. A project of plain pages has nothing else to run, so leaving it out meant
 * every turn that edited one was told it "never ran a check" straight after looking at the page, and
 * what the person read as the turn's reply was the model answering that.
 *
 * The language server's own errors do not count, and cannot: they arrive with every edit result rather
 * than through a call of their own. Reading what an edit handed back is not running the project.
 */
export function isVerification(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === "run_command") {
    const command = String(args.command ?? "");
    return looksLikeVerification(command) || RUNS_A_PROGRAM.test(command);
  }
  if (toolName === "ui") return args.action !== "close";
  if (toolName === "screenshot") return true;
  if (toolName === "spawn_subagent") return args.verify === true;
  return false;
}

/**
 * Re-scope guard (pure). A turn is one user request; when the model finishes its
 * whole todo list it has done what was asked. If it then opens a NEW list of
 * pending work in the same turn, it's taking on scope the user never asked for —
 * the "did the same task three times" runaway. This decides, from observable
 * facts alone, whether that has happened.
 *
 *  - `completedBefore` — was a full list already completed earlier this turn?
 *  - `stepResults`     — the tool results from the latest step (name + summary).
 *  - `todos`           — the current task list after the step.
 *
 * Returns the updated `completed` flag (carry it into the next step) and whether
 * the turn should pause. It decides nothing about the code — only turn-taking.
 */
export function reScopeCheck(
  completedBefore: boolean,
  stepResults: readonly { name: string; summary?: string }[],
  todos: readonly { status: string }[] | undefined,
): { completed: boolean; pause: boolean } {
  const finishedNow = stepResults.some(
    (r) => r.name === "todo_write" && r.summary === "all tasks completed",
  );
  const completed = completedBefore || finishedNow;
  // A list finishing clears itself, so the pending check only trips on a genuinely
  // NEW list created after the completion — never on the completing step itself.
  const morePending = todos?.some((t) => t.status !== "completed") ?? false;
  return { completed, pause: completed && morePending };
}

/**
 * Background-poll guard (pure). A background shell's completion is pushed to the
 * model automatically (see backgroundEventNotes), so re-reading a still-running
 * shell with the `shells` tool accomplishes nothing — it just spends a step
 * and narrates "still running" to the user, the exact spam a wait-loop produces.
 * This detects a step whose ONLY work was polling background shells that are still
 * running. A step that does any real work alongside (an edit, a file read, a real
 * command) is NOT a poll step, so genuine progress never trips the guard.
 */
export function isBackgroundPollStep(
  stepResults: readonly { name: string; summary?: string }[],
): boolean {
  if (stepResults.length === 0) return false;
  const isStatusRead = (name: string) => name === "shells";
  if (!stepResults.every((r) => isStatusRead(r.name))) return false;
  // At least one polled shell must still be RUNNING — a poll that finds the shell
  // already finished is legitimate (the model reads the result and reports it).
  // A read summary is "shell #1 (running)"; a listing is "N running,
  // M total" (N≥1 only when something is actually running — avoids "0 running").
  return stepResults.some((r) => /\(running\)|[1-9]\d* running/i.test(r.summary ?? ""));
}

/**
 * What a failing call is counted AS (pure): an MCP tool counts as its SERVER.
 *
 * A model reaching for `open_binary`, then `binary_session`, then `list_adb_devices` on a
 * server that is down is making the same mistake three times, and keying on the tool
 * name made each a "different" failure, so the streak restarted every step.
 */
function failureKey(name: string): string {
  const m = /^(mcp__.+?)__/.exec(name);
  return m ? m[1]! : name;
}

/**
 * A step made only of server-management calls (pure). Such a step neither is progress
 * nor is a new kind of failure: it is the model fiddling with the thing that keeps
 * failing. Letting it reset the repeat-failure streak is how an agent alternated
 * "enable server" and "call its tool" nine times without the breaker ever tripping.
 */
export function isServerManagementStep(names: readonly string[]): boolean {
  return names.length > 0 && names.every((n) => n === "mcp_server");
}

/**
 * Repeat-failure breaker (pure). A weaker model can get stuck firing the SAME thing
 * over and over when it keeps failing — an edit that errors "file not found" six times,
 * or ten near-identical PowerShell commands that all die with the same error — because
 * it doesn't recognize the error is the same and never changes course. The fix is to key
 * the repeat detection on the ERROR MESSAGE, not the exact command — which is what catches
 * a run of slightly-different commands that all fail identically.
 *
 * `stepFailureSignature` returns a stable signature for a step whose EVERY tool result
 * errored (a pure-failure step), or null otherwise — any success alongside is progress,
 * so the streak resets. The engine counts consecutive identical signatures and stops
 * losslessly once they cross a small limit, surfacing the real error to the user.
 */
export function stepFailureSignature(
  results: readonly { name: string; output: string; isError: boolean }[],
): string | null {
  if (results.length === 0) return null;
  // Any non-error result means the step made some progress — not a pure-failure step.
  if (!results.every((r) => r.isError)) return null;
  return results
    .map((r) => `${failureKey(r.name)}:${normalizeErrorSignature(r.output)}`)
    .sort()
    .join("|");
}

/**
 * Collapse an error output to its stable core so two failures of the same KIND match
 * even when the offending command differs. Drops the noise that varies call-to-call:
 * PowerShell's code-echo/caret lines (start with `+` or `~`) and its `At line:N char:N`
 * locators, then strips digits (so `char:80` and `char:99` unify) and collapses space.
 * Harmless on non-PowerShell output — plain error text passes through digit-normalized.
 */
export function normalizeErrorSignature(output: string): string {
  const kept = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((t) => {
      if (t === "") return false;
      if (t.startsWith("+") || /^~+$/.test(t)) return false; // PS code-echo / caret underline
      if (/at line:\d+ char:\d+/i.test(t)) return false; // PS location line
      return true;
    });
  return kept
    .join(" ")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * What the breaker should do at a given streak length. Two tiers, deliberately:
 *
 * Stopping the turn the moment a streak trips is the wrong reflex. The model has
 * no idea it repeated itself — nothing in the conversation says so — so a hard stop
 * punishes it for a fact it was never told. Worse, it removes the one thing that
 * would actually fix the situation: a chance to look at why.
 *
 * So the first trip INTERRUPTS: the loop injects the fact (same thing, N times, same
 * error, here's where your shell actually is) and continues. Only if the model repeats
 * it AGAIN after being told does the turn stop. That second tier is what keeps this a
 * real backstop rather than an endless nudge, and it costs one model round-trip.
 */
export type RepeatFailureStep = "none" | "nudge" | "stop";

export function repeatFailureStep(streak: number, limit: number, nudged: boolean): RepeatFailureStep {
  if (streak < limit) return "none";
  return nudged ? "stop" : "nudge";
}

/**
 * The first line of an error worth showing a human: skips blanks and PowerShell's
 * code-echo/caret decoration, and clips so one runaway line can't fill the screen.
 */
export function firstErrorLine(output: string, max = 200): string {
  const line =
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("+") && !/^~+$/.test(l)) ?? "the same error";
  return line.length > max ? line.slice(0, max - 3) + "…" : line;
}

/**
 * A one-line label for the thing that kept failing. For a shell command that's the
 * command itself (the actual repeated text); for anything else it's the tool plus
 * whichever argument identifies what it acted on.
 */
export function failedActionLabel(name: string, args: Record<string, unknown>): string {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (command) return command.length > 160 ? command.slice(0, 157) + "…" : command;
  const target = ["path", "file_path", "file", "pattern", "query"]
    .map((k) => args[k])
    .find((v) => typeof v === "string" && v) as string | undefined;
  return target ? `${name} ${target}` : name;
}

/**
 * The interrupt injected on the first trip of the breaker.
 *
 * Every sentence here is a FACT the model cannot otherwise see: how many times it
 * repeated itself, what it repeated, what the error was, where its shell actually is,
 * and what the harness will do next. That last one matters — the model can only weigh
 * "retry once more" against a stop if it knows the stop is coming.
 *
 * `cwd` is included only when the shell has moved off the project root, which is the
 * failure this was written for: `cd` persists within a turn, so a later relative path
 * silently resolves from somewhere else and the model has no way to notice.
 */
export function repeatFailureNudge(opts: {
  attempts: number;
  action: string;
  error: string;
  cwd?: string;
  /** The other way to do it, from `otherRoute`, when there is one. */
  route?: string | null;
}): string {
  const where = opts.cwd
    ? `Your shell is currently in ${opts.cwd}, not the project root. Relative paths resolve from there, ` +
      `so a path that looks right from the root will not be.\n\n`
    : "";
  return (
    `You have now run this ${opts.attempts} times and gotten the same error every time:\n\n` +
    `    ${opts.action}\n` +
    `    ${opts.error}\n\n` +
    where +
    `Running it again unchanged will end the turn. Find out why it fails before you act again: ` +
    `check the path or file it names, confirm the state you are actually in, or take a different ` +
    `route to the same goal.${opts.route ? ` ${opts.route}` : ""} (This fires once per failure loop.)`
  );
}

/** A command that writes to a file, in either shell. */
const WRITES_A_FILE = /\b(WriteAllText|WriteAllLines|Set-Content|Add-Content|Out-File|tee|sed\s+-i)\b|(^|[^>&\d])>>?\s*["']?[\w./\\$~]/i;

/** Failing because something was refused or declined. That was somebody's decision, so no other route is offered for it. */
const WAS_TURNED_AWAY = /Refusing to|Stopped:|declined|forbid|protected|outside the workspace/i;

/**
 * The other way to change a file, when the way being tried keeps failing (pure), or null.
 *
 * An edit that will not match and a script that will not run are the same job by two routes, and a model stuck on one
 * tends not to think of the other. Never offered for a refusal: suggesting a shell command after "Refusing to edit
 * .env" would be telling it to go round the protection.
 */
export function otherRoute(name: string, args: Record<string, unknown>, error: string): string | null {
  if (WAS_TURNED_AWAY.test(error)) return null;
  if (isFileMutation(name)) return "You can also make this change with a shell command.";
  if (name === "run_command" && WRITES_A_FILE.test(String(args.command ?? ""))) {
    return "If this command is there to change a file, make the change with edit or write_file instead.";
  }
  return null;
}

/**
 * How many single edits to the SAME file a turn may make before it is told to batch.
 *
 * Two is the allowance because two is defensible: the second edit is often something the
 * first one revealed. A third means the model is working through a list it already had,
 * one call at a time.
 */
export const SAME_FILE_EDIT_LIMIT = 2;

/**
 * Count ONE-AT-A-TIME edits per file in a step (pure).
 *
 * Only single-edit calls count. An `edit` call carrying several edits IS the batched
 * form this nudge is asking for, so counting it would scold the model for doing the
 * right thing. `write_file` is a different decision entirely and never counts.
 *
 * This used to key on the tool NAME, back when `edit_file` and `multi_edit` were
 * separate tools and the name alone told you which shape had been used. With one
 * merged tool the shape is in the arguments, so that is where it is read from.
 */
export function sameFileEditCounts(results: readonly { name: string; args?: Record<string, unknown> }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r.name !== "edit") continue;
    const edits = r.args?.edits;
    // Anything other than exactly one edit is either already batched or malformed;
    // neither is the pattern being discouraged.
    if (!Array.isArray(edits) || edits.length !== 1) continue;
    const path = typeof r.args?.path === "string" ? r.args.path.trim() : "";
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/**
 * The file a turn has now edited one-at-a-time too often, or null (pure).
 *
 * Why this is mechanical rather than a line in a tool description: measured against a
 * real model, the same task with the same descriptions routed correctly on one run and
 * made three separate one-edit calls to one file on another. Prose can bias a choice;
 * it cannot make it hold. Anything that must be true for EVERY provider has to be
 * enforced by the harness, which is the same reasoning behind the verify gate and the
 * repeat-failure breaker.
 */
export function overusedSingleEdits(
  running: ReadonlyMap<string, number>,
  limit = SAME_FILE_EDIT_LIMIT,
): string | null {
  for (const [path, n] of running) if (n > limit) return path;
  return null;
}

/** The one-shot nudge injected when a turn keeps editing one file a change at a time. */
export function batchEditNudge(path: string, count: number): string {
  return (
    `You've made ${count} separate one-edit calls to ${path} in this turn. When one file needs several ` +
    `changes, put them in the SAME edit call as several entries in \`edits\` instead: they apply in order, ` +
    `each sees the result of the last, and if any fails to match the file is left untouched rather than ` +
    `half-edited. Keep it to one call per file — don't try to cover several files in one call. ` +
    `(This reminder fires once per turn.)`
  );
}

/**
 * The one-shot nudge injected when files changed and nothing ran or looked at them afterwards.
 *
 * It states what the model cannot otherwise know: the reply it just wrote was not shown. Without that it
 * reads this as someone answering that reply, so it answers back ("The check did run this turn…"), and that
 * answer is all the person ever sees of a turn that built something. It also never asks for a word about
 * the check, because whatever it asks for here is what the person gets.
 */
export const VERIFY_NUDGE =
  "You changed files this turn and nothing has run or looked at them since. The reply you just wrote was NOT shown " +
  "to the user, and this message is not from them: they cannot see it, so do not answer it or mention it. Check the " +
  "change now in whatever way fits: run the build, the tests or the script, or open the page or app and look at it. " +
  "Fix what that turns up. Then write your closing reply again in full, as if this message had never been sent: what " +
  "you built or changed and what the user needs to know about it. Say nothing about the check if it went fine, and " +
  "never say that a project has no build or tests. If you could not check it, finish with one plain sentence saying so.";

/**
 * What the person reads when a turn was sent back to check its work (pure).
 *
 * The reply written before the nudge said what was done. The one written after it is supposed to say that again
 * in full, and a model may instead answer the nudge in a line ("No build or test suite applies here"). That line
 * must not be what is left of the turn, whatever the wording of the nudge, so the first reply is not lost here:
 *
 *  - The second reply says about as much as the first: it is the rewrite that was asked for.
 *  - Nothing ran in between: nothing has been learned, so the first reply stands.
 *  - Something ran and no file changed since: the first reply is still true, and the second adds how that went.
 *  - Something ran and a file changed: the first reply is out of date, so the second is all there is.
 */
export function closingAfterCheck(draft: string, second: string, facts: { ranSomething: boolean; changedSince: boolean }): string {
  const first = draft.trim();
  const after = second.trim();
  if (!first) return second;
  if (!after) return draft;
  if (after.length >= first.length * 0.7) return second;
  if (!facts.ranSomething) return draft;
  return facts.changedSince ? second : `${first}\n\n${after}`;
}

// ── Narration budget ──────────────────────────────────────────────────────────
// Prose between tool calls is not free: it is written into the transcript and
// re-sent on every subsequent turn until compaction, so a paragraph restated five
// times is paid for five times, forever. Measured on a real session before this
// existed: the same assessment given five times, the same status table twice, one
// block of 46 sentences, ~10,700 characters of prose in a turn that made no edits.
//
// Mechanical rather than only a line in the prompt, for the reason the batching gate
// gives: prose biases a choice, it cannot make it hold. The prompt states the rule;
// this catches the turn where the rule slipped and says so while it can still matter.

/** Sentences the model may spend on an intermediate step before it is over budget. */
export const NARRATION_SENTENCES = 2;

/** Identifiers repeated from earlier prose before it counts as restating. */
const RESTATE_IDENTS = 3;

/** Rough sentence split for prose (fenced code is not narration). Pure. */
export function proseSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=[-*\d])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** camelCase / snake_case identifiers named in prose, 4+ chars. Pure. */
export function proseIdentifiers(text: string): string[] {
  const found = text.replace(/```[\s\S]*?```/g, " ").match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:[A-Z][A-Za-z0-9_$]*|_[A-Za-z0-9_$]+)\b/g) ?? [];
  return [...new Set(found.filter((s) => s.length > 3))];
}

/**
 * Why this intermediate message breaks the budget, or null if it is fine (pure).
 *
 * Two separate faults, because they need different corrections. LENGTH is an essay
 * where a line belonged. RESTATING is the worse one and the one a length cap alone
 * misses: three short blocks that each re-summarise the picture are individually
 * within budget and collectively the thing that makes a transcript unreadable.
 * Re-derivation is paraphrased, so matching wording finds nothing — what recurs is
 * the SUBJECT, which is why this compares identifiers rather than phrases.
 */
export function narrationFault(
  text: string,
  earlier: readonly string[],
): { kind: "length" | "restating"; sentences: number; repeated: string[] } | null {
  const prose = text.trim();
  if (!prose) return null;

  const seenBefore = new Set(earlier.flatMap((e) => proseIdentifiers(e)));
  const repeated = proseIdentifiers(prose).filter((id) => seenBefore.has(id));
  const sentences = proseSentences(prose).length;

  // Restating is checked first: it is the more serious fault and can hold at any length.
  if (repeated.length >= RESTATE_IDENTS) return { kind: "restating", sentences, repeated };
  if (sentences > NARRATION_SENTENCES) return { kind: "length", sentences, repeated };
  return null;
}

/** The one-shot nudge injected when a turn narrates past its budget. */
export function narrationNudge(fault: { kind: "length" | "restating"; sentences: number; repeated: string[] }): string {
  if (fault.kind === "restating") {
    return (
      `You have already told the user about ${fault.repeated.slice(0, 4).join(", ")} earlier in this turn. ` +
      `Do not summarise the picture again — each message should carry only what is NEW since your last one. ` +
      `Keep gathering silently and give the assessment ONCE, when there is something to conclude. ` +
      `(This reminder fires once per turn.)`
    );
  }
  return (
    `That was ${fault.sentences} sentences between tool calls, where the budget is ${NARRATION_SENTENCES}. ` +
    `The user can see every call you make, so say only what you learned and what you are doing next. ` +
    `Spend more only when they would act differently for knowing. (This reminder fires once per turn.)`
  );
}

/**
 * Levenshtein distance — the edit cost between two tool names. Small and iterative
 * (two rolling rows) because it runs over the whole registry on a rare path.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * The registered tools closest to a name the model invented.
 *
 * A model occasionally calls a tool that does not exist (seen live: `index_results`).
 * The bare "unknown tool" error tells it nothing it can act on, so it either gives up
 * or guesses again. Naming the near misses turns the dead end into a correction it can
 * make on the next step.
 *
 * Returns nothing when nothing is genuinely close. A suggestion has to be plausibly
 * what was meant — past roughly a third of the name's length the "nearest" match is
 * just whichever registered name happens to be shortest, and pointing at that is worse
 * than pointing at nothing.
 */
export function nearestTools(name: string, known: readonly string[], max = 2): string[] {
  return known
    .map((k) => ({ k, d: editDistance(name, k) }))
    .filter(({ k, d }) => d <= Math.max(2, Math.floor(Math.max(name.length, k.length) / 3)))
    .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k))
    .slice(0, max)
    .map((s) => s.k);
}

/**
 * The error handed back for a tool that does not exist, with a way forward.
 *
 * A name that is another agent program's word for one of OUR tools (`question` for ask_user, `bash` for run_command, see
 * toolAliases.ts) gets more than "did you mean": which tool, what it does, and to call it in the next step. `describe`
 * returns a tool's own description.
 */
export function unknownToolError(name: string, known: readonly string[], describe?: (tool: string) => string | undefined): string {
  const meant = aliasTarget(name, known);
  if (meant) {
    const what = describe?.(meant);
    return (
      `Error: there is no tool called '${name}' here. You most likely meant '${meant}'.` +
      (what ? ` What '${meant}' does: ${shortExplanation(what)}` : "") +
      ` Call '${meant}' in your next step, with the arguments its definition lists.`
    );
  }
  const near = nearestTools(name, known);
  const hint = near.length > 0
    ? `Did you mean ${near.map((n) => `'${n}'`).join(" or ")}?`
    : `Call find_tools to see what is available.`;
  return `Error: unknown tool '${name}'. Mindweave has no tool by that name. ${hint}`;
}

