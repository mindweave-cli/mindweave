/**
 * approval.ts — the forbidden-path lift.
 *
 * When a protected (forbidden) path blocks a write/edit/run, the model shouldn't
 * just hit a wall: it asks the human. Through the client's approval channel
 * (`ctx.requestApproval`) the user gets Yes / No / "let me tell you what to do".
 *   - Yes   → the path is lifted FOR THIS SESSION (removed from the in-memory
 *             deny-list, so the rest of the run proceeds without re-asking; the
 *             saved rule on disk is untouched, so it returns next session).
 *   - No    → the original refusal stands; the model adapts.
 *   - Defer → control goes back to the user to give direction in the chat.
 *
 * With no approval channel (tests, or a future headless server) it falls back to
 * the hard refusal — fail-closed, exactly as before.
 */
import type { ToolContext, ToolResult } from "./types.js";
import { dirname, relative, isAbsolute } from "node:path";
import { fail } from "./results.js";
import { realPathOf, withinFolder } from "./guard.js";

const ALLOW = "Yes, allow it this time";
const DENY = "No, keep it protected";
const DEFER = "Let me tell you what to do";

/**
 * What the approval channel resolves with when the user dismisses the question
 * instead of answering it (Esc).
 *
 * Dismissing used to resolve with the SECOND option, which is right for a
 * Yes/No/Defer prompt and wrong for anything else. `ask_user` supplies arbitrary
 * options, so escaping "Postgres or SQLite?" told the model the user had chosen
 * SQLite — a preference they never expressed, reported to the model as fact.
 *
 * Every other caller tests for its own affirmative and treats anything else as a
 * refusal, so this value declines safely everywhere without them knowing about it.
 * Only a caller that must tell "declined" apart from "chose the second option"
 * needs to compare against it.
 */
export const APPROVAL_DISMISSED = "\u0000dismissed";


/**
 * Marks an answer the user TYPED rather than picked, so a caller can tell them apart.
 *
 * Leading space, like APPROVAL_DISMISSED: an option label never starts with one, so a
 * typed answer can never be mistaken for a choice and vice versa.
 */
export const APPROVAL_TEXT = " text:";

/** The typed answer, or null when this was an ordinary choice. */
export function readFreeText(answer: string): string | null {
  return answer.startsWith(APPROVAL_TEXT) ? answer.slice(APPROVAL_TEXT.length) : null;
}
/**
 * Offer to lift a forbidden path. Returns `null` to proceed (the user allowed it),
 * or a ToolResult the caller should return (refused or deferred). `refusal` is the
 * message used when there's no channel to ask through.
 */
export async function requestForbiddenLift(
  ctx: ToolContext,
  pattern: string,
  action: string,
  refusal: string,
  noun = "protected path",
): Promise<ToolResult | null> {
  if (!ctx.requestApproval) {
    return {
      output: `Error: ${refusal}`,
      isError: true,
      summary: `Forbidden ${noun}: ${pattern} → access denied`,
      displayKind: "governor",
      displayName: "Governor",
    };
  }

  const choice = await ctx.requestApproval(
    `This is blocked by a ${noun} rule ('${pattern}'). Allow ${action} anyway?`,
    [ALLOW, DENY, DEFER],
  );

  if (choice === ALLOW) {
    liftForbidden(ctx, pattern);
    return null; // proceed
  }
  if (choice === DEFER) {
    return {
      output: `Stopped: '${pattern}' is protected. The user will tell you how to proceed — wait for their direction instead of touching it.`,
      isError: true,
      summary: `Rule fired: ${pattern} → ${action} → DEFERRED`,
      displayKind: "governor",
      displayName: "Governor",
    };
  }
  return {
    output: `Refused: '${pattern}' is protected and the user declined to lift it. Find another way that doesn't touch it.`,
    isError: true,
    summary: `Rule fired: ${pattern} → ${action} → BLOCKED`,
    displayKind: "governor",
    displayName: "Governor",
  };
}

const AGENT_ALLOW = "Yes, you can use it";
const AGENT_DENY = "No, leave it alone";

/**
 * Ask before touching another coding agent's data (its saved sessions, memory,
 * rules or skills).
 *
 * The default is NOT to look. Finding another tool's history in a project is like
 * finding someone else's notebook on a shared desk: the right move is to say it's
 * there, not to read it and start quoting it back as your own recollection. So the
 * model surfaces it and the user decides.
 *
 * Returns `null` to proceed (the user allowed it), or a ToolResult the caller
 * should return. A yes is remembered for the rest of the session, per tool, so the
 * user is asked once rather than per file.
 */
export async function requestAgentDataAccess(
  ctx: ToolContext,
  tool: string,
  action: string,
): Promise<ToolResult | null> {
  if (ctx.agentDataAllowed?.has(tool)) return null; // already allowed this session

  const refusal =
    `that belongs to ${tool}, a different coding tool that has worked in this project. ` +
    `Its sessions, memory and rules are not yours. Tell the user it's there and let them decide.`;

  if (!ctx.requestApproval) {
    return { output: `Error: ${refusal}`, isError: true, summary: `skipped ${tool}'s data` };
  }

  const choice = await ctx.requestApproval(
    `${action} belongs to ${tool}, another coding tool that has worked here.\n` +
      `Its saved sessions, memory and rules are separate from mine. Use it anyway?`,
    [AGENT_ALLOW, AGENT_DENY, DEFER],
  );

  if (choice === AGENT_ALLOW) {
    if (!ctx.agentDataAllowed) ctx.agentDataAllowed = new Set();
    ctx.agentDataAllowed.add(tool);
    return null; // proceed
  }
  if (choice === DEFER) {
    return {
      output:
        `Stopped: that is ${tool}'s data. The user will say how to proceed — wait for their ` +
        `direction rather than reading it.`,
      isError: true,
      summary: `awaiting direction on ${tool}'s data`,
    };
  }
  return {
    output:
      `Refused: ${refusal} Continue without it, and do not present anything from it as your ` +
      `own history with the user.`,
    isError: true,
    summary: `left ${tool}'s data alone`,
  };
}

/** Drop a pattern from the live (session-only) deny-list. A new object forces the
 *  matcher to recompile; the on-disk rule is left intact. */
function liftForbidden(ctx: ToolContext, pattern: string): void {
  const g = ctx.governance;
  if (!g) return;
  // Remembered because the lift exists ONLY in memory and governance is re-read from
  // disk when the files change. Without this, a hand-edit to any rule file anywhere in
  // the project would quietly resurrect a pattern the user had explicitly allowed, and
  // the next write to that path would be blocked by a decision they had already made.
  g.lifted = [...(g.lifted ?? []), pattern];
  // Filter BOTH lists: a lift may be for a forbidden path or a forbidden command,
  // and a pattern won't collide across the two, so dropping it from each is safe.
  g.forbidden = {
    ...g.forbidden,
    patterns: g.forbidden.patterns.filter((p) => p !== pattern),
    commands: (g.forbidden.commands ?? []).filter((c) => c !== pattern),
  };
  g.notices = [...(g.notices ?? []), `Approval lifted: '${pattern}' → session scope → ALLOWED`];
}


/** The answers offered when a write lands outside the workspace. */
const OUTSIDE_OPTIONS = [
  "Yes, write it",
  "Yes, and allow this folder for the session",
  "No, keep to the workspace",
] as const;

/**
 * Ask before writing somewhere the workspace does not cover.
 *
 * Lightning means "do not ask me about the work", and everything inside the folders the
 * user opened IS the work. A path outside all of them is a different claim: nothing the
 * user chose says the agent may write there, and an absolute path is easy for a model to
 * produce from a stale assumption about where it is.
 *
 * The line is drawn where it is because an auto-accept mode allows a write only when the
 * path is inside an allowed working directory, and anything outside falls through to a
 * prompt. The second option scopes the grant to that FOLDER for the session, as theirs
 * does, so a run that legitimately writes next door asks once rather than every file.
 *
 * Returns a refusal to hand back, or null to proceed. Fails CLOSED: with no way to ask,
 * the write does not happen. Reads are untouched — this is about changing things.
 */
export async function requestOutsideWorkspaceWrite(
  ctx: ToolContext,
  filePath: string,
  action: string,
): Promise<ToolResult | null> {
  // Judged by where the write really lands. A link inside the project to a folder outside
  // it passed a comparison of path text, and the write went outside with no question.
  if (await insideWorkspaceReally(ctx, filePath)) return null;
  const dir = dirname(filePath);
  if (ctx.allowedOutsideDirs?.has(dir)) return null;

  if (!ctx.requestApproval) {
    return fail(
      `Refusing to ${action}: it is outside the workspace (${ctx.roots?.join(", ") ?? ctx.cwd}) ` +
        `and there is no way to ask the user from here. Work inside the project, or ask them ` +
        `to add that folder with /include.`,
    );
  }
  const choice = await ctx.requestApproval(
    "Write outside the workspace?",
    [...OUTSIDE_OPTIONS],
    `Action: ${action}
File: ${filePath}
Workspace: ${(ctx.roots ?? [ctx.cwd]).join(", ")}`,
    "Permission Request",
  );
  if (choice === OUTSIDE_OPTIONS[1]) {
    ctx.allowedOutsideDirs = new Set([...(ctx.allowedOutsideDirs ?? []), dir]);
    return null;
  }
  if (choice === OUTSIDE_OPTIONS[0]) return null;
  return fail(
    `Stopped: the user declined a write outside the workspace (${filePath}). Keep to the ` +
      `project folders, and say what you were trying to do if you need somewhere else.`,
  );
}

/** Is this path inside one of the folders the user opened, with links resolved on both sides? */
export async function insideWorkspaceReally(ctx: ToolContext, filePath: string): Promise<boolean> {
  if (!insideWorkspace(ctx, filePath)) return false;
  const roots = ctx.roots && ctx.roots.length > 0 ? ctx.roots : [ctx.cwd];
  const real = await realPathOf(filePath);
  for (const root of roots) {
    if (withinFolder(await realPathOf(root), real)) return true;
  }
  return false;
}

/** Is this path inside one of the folders the user opened? Compares path text; see insideWorkspaceReally. */
export function insideWorkspace(ctx: ToolContext, filePath: string): boolean {
  const roots = ctx.roots && ctx.roots.length > 0 ? ctx.roots : [ctx.cwd];
  return roots.some((root) => {
    const rel = relative(root, filePath);
    // "" is the root itself; a `..` prefix means the path climbed out of it.
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
