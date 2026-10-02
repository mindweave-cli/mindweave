/**
 * resumeParity.test.ts — a resumed row is built from the same fields as a live one.
 *
 * There are two places that turn a tool call into a row: the live stream handler, and
 * `showResumed` replaying a stored session. They dispatch the SAME actions into the same
 * reducer, so a row is identical only for as long as both sites pass the same fields.
 *
 * They drifted, repeatedly and silently, and every instance looked like a rendering bug
 * rather than a missing field:
 *
 *   - `detailKind` was live-only, so every resumed edit lost its green and red
 *   - `quiet` was live-only, so a resumed session filled with the "no diagnostics" rows
 *     the diagnostics tool goes out of its way to suppress
 *   - `meta` was live-only, so a command's timeout qualifier vanished
 *   - `displayName`/`displayKind` were live-only, so a red "Build Error" came back as a
 *     routine "Check"
 *
 * Each was found by a person looking at a screenshot. Listing the fields in a test would
 * only move the problem: the next field added to the live site would be missing here too,
 * and this file would still pass. So it does not list them — it reads both call sites and
 * compares what they actually pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");

/** The object literal passed to the first dispatch of `action` after `from`. */
function dispatchBody(from: number, action: string): string {
  const at = app.indexOf(`type: "${action}"`, from);
  assert.ok(at > 0, `no ${action} dispatch found`);
  // Walk braces from the opening one so a nested `{ ... }` inside a spread is included.
  const open = app.lastIndexOf("{", at);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === "{") depth++;
    else if (app[i] === "}" && --depth === 0) return app.slice(open, i + 1);
  }
  throw new Error(`unterminated ${action} dispatch`);
}

/** The field names an object literal sets, however it sets them. */
function fields(body: string): Set<string> {
  // Matches `name:` in both plain form and inside a `...(cond ? { name: v } : {})`
  // spread. A ternary's own colon never follows a word character, so it cannot match.
  return new Set([...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1]!));
}

const liveFrom = app.indexOf("const d = toolDisplay(e.name, e.args)");
const resumeFrom = app.indexOf("function showResumed");

test("the live and resumed toolStart pass the same fields", () => {
  const live = fields(dispatchBody(liveFrom, "toolStart"));
  const resumed = fields(dispatchBody(resumeFrom, "toolStart"));
  // `at` is when a live call started, so a running command counts its real time. A resumed row
  // is never running, so it has nothing to count.
  const missing = [...live].filter((f) => !resumed.has(f) && f !== "at");
  assert.deepEqual(missing, [], "these reach a live row but not a resumed one, so the two differ on screen");
});

test("the live and resumed toolEnd pass the same fields", () => {
  const live = fields(dispatchBody(liveFrom, "toolEnd"));
  const resumed = fields(dispatchBody(resumeFrom, "toolEnd"));
  // `ok` is derived either side (from `error` live, from `isError` stored) and both set
  // it; nothing else is allowed to be live-only.
  const missing = [...live].filter((f) => !resumed.has(f));
  assert.deepEqual(missing, [], "these reach a live row but not a resumed one, so the two differ on screen");
});

test("the calls the live path never draws are not drawn on resume either", () => {
  // `spawn_subagent` renders as its own sub-agent block, never as a raw tool row.
  // Replaying it as one puts a row in a resumed transcript that was never in the live
  // one — which is the same complaint from the other direction.
  const replay = app.slice(resumeFrom);
  const loop = replay.slice(replay.indexOf("for (const call of"), replay.indexOf('type: "toolStart"'));
  assert.match(loop, /spawn_subagent/, "the replay draws the spawn call as an ordinary row");
});

test("a resumed paste comes back as a chip, not as itself", async () => {
  // What `/continue` looked like after a big paste: the whole thing replayed into the
  // chat, line by line, as if the person had typed it. The chat and the transcript hold
  // deliberately different things — a chip and the full text — and the resume path is
  // where that split has to be honoured a second time.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

  // Written wrapped, so there is a boundary to find it by. Spliced in bare it is
  // indistinguishable from typing and nothing downstream can collapse it.
  assert.match(app, /join\(wrapPastedText\(content\)\)/, "pastes go into the transcript unwrapped again");
  // And collapsed on the way back to the chat, alongside the attachment strip.
  assert.match(
    app,
    /collapsePastes\(stripAttachments\(e\.content\)\)/,
    "the resume path replays the paste body instead of its chip",
  );
});

test("the session picker labels a session by what was TYPED", async () => {
  // The label is the last thing the person said, clipped. Uncollapsed, a session that
  // opened with a paste was labelled by the paste — and once the paste is wrapped, by the
  // wrapper, which is worse.
  const { readFile } = await import("node:fs/promises");
  const store = await readFile(new URL("../memory/store.ts", import.meta.url), "utf8");
  assert.match(store, /collapsePastes\(e\.content\)/, "the picker still labels sessions with paste bodies");
});
